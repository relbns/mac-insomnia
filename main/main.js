const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, dialog, powerMonitor, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { LidSleepController } = require('./lid-sleep');
const { ClaudeWatcher, URL_SCHEME, CLAUDE_SETTINGS, readClaudeSettings, writeClaudeSettings, hasHooks, addHooks, removeHooks } = require('./claude-watch');

const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : path.join(__dirname, '..');
const ASSETS_PATH = path.join(APP_ROOT, 'assets');
const RENDERER_PATH = path.join(APP_ROOT, 'renderer');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

const DURATIONS = [
    { label: 'Infinite', ms: null },
    { label: '30 minutes', ms: 30 * 60 * 1000 },
    { label: '1 hour', ms: 60 * 60 * 1000 },
    { label: '2 hours', ms: 2 * 60 * 60 * 1000 }
];

let settings = {
    defaultDuration: null,
    iconSet: 'set1',
    soundEnabled: true,
    startAtLogin: false,
    smartMode: false
};

let tray = null;
let settingsWindow = null;
let aboutWindow = null;
let isPlaying = false;
let caffeinateProcess = null;
let duration = null;
let endTime = null;
let endTimer = null;
let soundProcess = null;
let cachedMenu = null;
let lidSleep = null;
let lidBusy = false;
let quitting = false;
let shuttingDown = false;
let pmsetRefresh = null;
let claudeWatcher = null;
const pendingUrls = [];
const iconCache = new Map();

function isDevelopment () {
    return !app.isPackaged;
}

function settingsPath () {
    return path.join(app.getPath('userData'), 'settings.json');
}

function parseDuration (value) {
    if (value === null || value === undefined || value === 'null') return null;
    const ms = parseInt(value, 10);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function loadSettings () {
    try {
        if (fs.existsSync(settingsPath())) settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
    } catch (error) {
        console.error('Error loading settings:', error);
    }
    settings.startAtLogin = isDevelopment() ? false : app.getLoginItemSettings().openAtLogin;
}

function saveSettings () {
    try {
        fs.writeFileSync(settingsPath(), JSON.stringify(settings));
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

function setStartAtLogin (openAtLogin) {
    if (isDevelopment()) return false;
    try {
        app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
        return app.getLoginItemSettings().openAtLogin;
    } catch (error) {
        console.error('Login item settings not available:', error.message);
        return false;
    }
}

ipcMain.on('save-settings', (_event, newSettings) => {
    const previousIconSet = settings.iconSet;
    const previousDefault = parseDuration(settings.defaultDuration);
    settings = {
        ...settings,
        defaultDuration: parseDuration(newSettings.defaultDuration),
        iconSet: newSettings.iconSet === 'set2' ? 'set2' : 'set1',
        soundEnabled: Boolean(newSettings.soundEnabled)
    };
    if (Boolean(newSettings.startAtLogin) !== settings.startAtLogin) settings.startAtLogin = setStartAtLogin(Boolean(newSettings.startAtLogin));
    saveSettings();
    if (parseDuration(settings.defaultDuration) !== previousDefault && !isPlaying) duration = parseDuration(settings.defaultDuration);
    if (settings.iconSet !== previousIconSet) iconCache.clear();
    refreshTray();
});

ipcMain.handle('get-settings', () => ({ ...settings, isDevelopment: isDevelopment() }));
ipcMain.handle('get-app-version', () => app.getVersion());

function secureWebPreferences () {
    return { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true };
}

function openWindow (existing, options, file) {
    if (existing) {
        existing.focus();
        return existing;
    }
    const win = new BrowserWindow({
        backgroundColor: '#1e1e1e',
        show: false,
        resizable: false,
        fullscreenable: false,
        ...options,
        webPreferences: secureWebPreferences()
    });
    win.loadFile(path.join(RENDERER_PATH, file));
    win.once('ready-to-show', () => win.show());
    return win;
}

function createSettingsWindow () {
    settingsWindow = openWindow(settingsWindow, { width: 400, height: 480 }, 'settings.html');
    settingsWindow.once('closed', () => (settingsWindow = null));
}

function createAboutWindow () {
    aboutWindow = openWindow(aboutWindow, { width: 300, height: 400, alwaysOnTop: true, minimizable: false }, 'about.html');
    aboutWindow.once('closed', () => (aboutWindow = null));
}

function trayIcon (active) {
    const suffix = settings.iconSet === 'set2' ? '2' : '';
    const file = active ? `icon-active${suffix}.png` : `icon${suffix}.png`;
    if (!iconCache.has(file)) {
        const icon = nativeImage.createFromPath(path.join(ASSETS_PATH, file));
        icon.setTemplateImage(true);
        iconCache.set(file, icon);
    }
    return iconCache.get(file);
}

function playSound (isActivating) {
    if (!settings.soundEnabled) return;
    if (soundProcess) soundProcess.kill();
    const sound = isActivating ? 'Pop' : 'Bottle';
    const child = execFile('/usr/bin/afplay', [`/System/Library/Sounds/${sound}.aiff`], () => {
        if (soundProcess === child) soundProcess = null;
    });
    soundProcess = child;
}

function notify (title, body) {
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
}

function formatDurationLabel (ms) {
    if (ms === null) return 'Infinite';
    const minutes = ms / 60000;
    if (minutes >= 60) {
        const hours = minutes / 60;
        return `${hours} hour${hours > 1 ? 's' : ''}`;
    }
    return `${minutes} minutes`;
}

function formatTimeRemaining () {
    if (!endTime) return 'Running indefinitely';
    const remaining = Math.max(0, endTime - Date.now());
    const minutes = Math.ceil(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours > 0 ? `${hours}h ${mins}m remaining` : `${mins}m remaining`;
}

function lidMenuItems () {
    const items = [{
        label: lidSleep.pending ? 'Keep Awake with Lid Closed (waiting for password)' : 'Keep Awake with Lid Closed',
        type: 'checkbox',
        checked: lidSleep.active || lidSleep.pending,
        enabled: !lidBusy,
        click: () => toggleLidMode()
    }];
    if (lidSleep.active) {
        items.push({ label: '⚠︎ Sleep is disabled system-wide', enabled: false });
        items.push({ label: 'Keep the Mac on power and out of bags', enabled: false });
    } else if (!lidSleep.pending && lidSleep.systemSleepDisabled !== false) {
        const label = lidSleep.systemSleepDisabled === null ? '⚠︎ Could not read the sleep setting' : '⚠︎ Sleep is disabled system-wide (not by this session)';
        items.push({ label, enabled: false });
        items.push({ label: 'Restore Normal Sleep…', enabled: !lidBusy, click: () => restoreLeftOver() });
    }
    return items;
}

function claudeHooksInstalled () {
    try {
        return hasHooks(readClaudeSettings());
    } catch {
        return false;
    }
}

function detectSmartModeSource () {
    return claudeHooksInstalled() ? 'hooks' : 'scan';
}

function applySmartMode () {
    if (!claudeWatcher) return;
    if (settings.smartMode) claudeWatcher.start(detectSmartModeSource());
    else claudeWatcher.stop();
}

function toggleSmartMode () {
    settings.smartMode = !settings.smartMode;
    saveSettings();
    applySmartMode();
}

function smartStatusLabel () {
    const n = claudeWatcher?.count || 0;
    if (claudeWatcher?.mode === 'hooks') return n ? `Claude is working in ${n} session${n > 1 ? 's' : ''}` : 'Claude is idle';
    return `${n} Claude Code process${n === 1 ? '' : 'es'} open (hooks not installed)`;
}

function smartMenuItems () {
    return [
        { label: 'Smart Mode: Keep Awake While Claude Works', type: 'checkbox', checked: settings.smartMode, click: () => toggleSmartMode() },
        ...(settings.smartMode ? [{ label: smartStatusLabel(), enabled: false }] : []),
        claudeHooksInstalled()
            ? { label: 'Remove Claude Code Hooks…', click: () => changeClaudeHooks(false) }
            : { label: 'Install Claude Code Hooks…', click: () => changeClaudeHooks(true) }
    ];
}

async function changeClaudeHooks (install) {
    try {
        readClaudeSettings();
    } catch (error) {
        dialog.showErrorBox('Could not read Claude Code settings', `${CLAUDE_SETTINGS} is not valid JSON, so it was left unchanged.\n\n${error.message}`);
        return;
    }
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
        type: 'question',
        message: install ? 'Install Claude Code hooks?' : 'Remove Claude Code hooks?',
        detail: install
            ? `Adds hooks to ${CLAUDE_SETTINGS} that tell Mac Insomnia when Claude starts and finishes a turn, so the Mac stays awake only while Claude is working. Claude Code sessions that are already open pick up the hooks after a restart. A backup of the file is saved next to it.`
            : `Removes the Mac Insomnia hooks from ${CLAUDE_SETTINGS}. Other hooks are kept. A backup of the file is saved next to it.`,
        buttons: [install ? 'Install' : 'Remove', 'Cancel'],
        defaultId: 0,
        cancelId: 1
    });
    if (response !== 0) return;
    try {
        const latest = readClaudeSettings();
        writeClaudeSettings(install ? addHooks(latest) : removeHooks(latest));
    } catch (error) {
        dialog.showErrorBox('Could not update Claude Code settings', error.message);
        return;
    }
    applySmartMode();
    refreshTray();
}

function handleUrl (url) {
    if (!claudeWatcher) {
        pendingUrls.push(url);
        return;
    }
    claudeWatcher.handleUrl(url);
}

function createContextMenu () {
    const runLabel = isPlaying ? `Stop Insomnia (${formatTimeRemaining()})` : `Start (${formatDurationLabel(duration)}) Insomnia`;
    return Menu.buildFromTemplate([
        { label: runLabel, click: () => togglePlayback() },
        { type: 'separator' },
        {
            label: 'Set Duration',
            submenu: DURATIONS.map(({ label, ms }) => ({ label, type: 'radio', checked: duration === ms, click: () => setDuration(ms) }))
        },
        { type: 'separator' },
        ...lidMenuItems(),
        { type: 'separator' },
        ...smartMenuItems(),
        { type: 'separator' },
        { label: 'Settings', click: () => createSettingsWindow() },
        { label: 'About', click: () => createAboutWindow() },
        { type: 'separator' },
        { label: 'Quit Insomnia', click: () => app.quit() }
    ]);
}

function invalidateMenu () {
    cachedMenu = null;
}

function refreshSleepState () {
    if (!lidSleep || lidSleep.active || lidSleep.pending || pmsetRefresh) return;
    const before = lidSleep.systemSleepDisabled;
    pmsetRefresh = lidSleep.refresh()
        .then((after) => { if (after !== before) invalidateMenu(); })
        .finally(() => { pmsetRefresh = null; });
}

function showMenu () {
    if (isPlaying && endTime) invalidateMenu();
    cachedMenu ??= createContextMenu();
    tray.popUpContextMenu(cachedMenu);
}

function onTrayHover () {
    updateTooltip();
    refreshSleepState();
}

function updateTooltip () {
    if (!tray) return;
    const lid = lidSleep?.active ? ' - lid closed mode' : '';
    const warning = lidSleep && !lidSleep.active && lidSleep.systemSleepDisabled !== false ? ' - sleep disabled system-wide' : '';
    const smart = settings.smartMode && claudeWatcher ? ` - ${smartStatusLabel()}` : '';
    tray.setToolTip(isPlaying ? `Insomnia - ${formatTimeRemaining()}${lid}${warning}${smart}` : `Insomnia - Stopped${warning}${smart}`);
}

function refreshTray () {
    if (!tray) return;
    tray.setImage(trayIcon(isPlaying || Boolean(claudeWatcher?.count)));
    updateTooltip();
    invalidateMenu();
}

function createTray () {
    tray = new Tray(trayIcon(false));
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', () => showMenu());
    tray.on('right-click', () => togglePlayback());
    tray.on('mouse-enter', onTrayHover);
    refreshTray();
}

function startCaffeinate () {
    if (caffeinateProcess) return;
    const child = spawn('/usr/bin/caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinateProcess = child;
    child.once('error', (err) => console.error('Error starting caffeinate:', err));
    child.once('exit', () => {
        if (caffeinateProcess !== child) return;
        caffeinateProcess = null;
        if (isPlaying && !quitting) {
            notify('Insomnia stopped', 'The keep-awake process ended unexpectedly.');
            stopPlayback();
        }
    });
}

function stopCaffeinate () {
    const child = caffeinateProcess;
    caffeinateProcess = null;
    if (child) child.kill('SIGTERM');
}

function armTimer () {
    clearTimeout(endTimer);
    endTimer = null;
    endTime = duration ? Date.now() + duration : null;
    if (endTime) endTimer = setTimeout(onTimerEnd, duration);
}

function onTimerEnd () {
    clearTimeout(endTimer);
    endTimer = null;
    if (!isPlaying || !endTime) return;
    if (Date.now() < endTime) {
        endTimer = setTimeout(onTimerEnd, endTime - Date.now());
        return;
    }
    stopPlayback();
}

function startPlayback () {
    if (isPlaying) return;
    isPlaying = true;
    playSound(true);
    startCaffeinate();
    armTimer();
    refreshTray();
}

function stopPlayback () {
    if (!isPlaying) return;
    isPlaying = false;
    playSound(false);
    stopCaffeinate();
    clearTimeout(endTimer);
    endTimer = null;
    endTime = null;
    if (lidSleep.active) disableLidMode();
    else if (lidSleep.pending) lidSleep.killToken();
    refreshTray();
}

function togglePlayback () {
    isPlaying ? stopPlayback() : startPlayback();
}

function setDuration (ms) {
    duration = ms;
    if (isPlaying) armTimer();
    refreshTray();
}

async function confirmLidMode () {
    const onBattery = powerMonitor.isOnBatteryPower();
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'Keep the Mac awake with the lid closed?',
        detail: [
            'This turns off sleep for the whole system (pmset disablesleep), so the Mac keeps running when you close the lid.',
            '',
            'Only use it while the Mac is connected to power. Never put it in a bag, a drawer or any closed space while this is on: it will not sleep and can overheat.',
            onBattery ? '\nThe Mac is running on battery right now.' : '',
            '',
            'You will be asked for an administrator password. Normal sleep is restored when you turn this off, when the timer ends or when you quit.'
        ].join('\n'),
        buttons: ['Turn On', 'Cancel'],
        defaultId: 1,
        cancelId: 1
    });
    return response === 0;
}

async function runLidTask (task) {
    if (lidBusy) return undefined;
    lidBusy = true;
    invalidateMenu();
    try {
        return await task();
    } catch (error) {
        console.error('Lid closed mode:', error);
        notify('Lid closed mode error', String(error?.message || error));
        return undefined;
    } finally {
        lidBusy = false;
        refreshTray();
    }
}

const ENABLE_REFUSALS = {
    'already-disabled': 'Sleep is already disabled on this Mac by something else. Restore it from the Insomnia menu first, or leave it as it is.',
    'state-unknown': 'Could not read the current sleep setting (pmset -g), so lid closed mode was not turned on.'
};

function toggleLidMode () {
    if (lidSleep.active) return disableLidMode();
    return runLidTask(async () => {
        if (!(await confirmLidMode())) return;
        const wasPlaying = isPlaying;
        startPlayback();
        const result = await lidSleep.enable();
        if (result.ok) {
            if (!isPlaying) await lidSleep.disable({ allowPrompt: true });
            return;
        }
        if (!wasPlaying) stopPlayback();
        if (result.reason === 'stopped') return;
        if (ENABLE_REFUSALS[result.reason]) notify('Lid closed mode is off', ENABLE_REFUSALS[result.reason]);
        else if (!result.canceled) notify('Lid closed mode failed', String(result.error?.message || result.error));
        if (result.restored === false) notify('Sleep is still disabled', 'Open the Insomnia menu and choose "Restore Normal Sleep…".');
    });
}

function disableLidMode () {
    return runLidTask(async () => {
        const result = await lidSleep.disable({ allowPrompt: true });
        if (!result.restored) notify('Sleep is still disabled', 'Normal sleep could not be restored. Open the Insomnia menu and choose "Restore Normal Sleep…".');
        return result;
    });
}

function restoreLeftOver () {
    return runLidTask(async () => {
        const result = await lidSleep.restoreWithPrompt();
        if (!result.restored) notify('Sleep is still disabled', 'Open the Insomnia menu and choose "Restore Normal Sleep…".');
        return result;
    });
}

async function onLidModeEndedUnexpectedly ({ restored }) {
    if (isPlaying) stopPlayback();
    if (restored) notify('Lid closed mode ended', 'Its helper process stopped. Normal sleep is restored.');
    else await restoreLeftOver();
    refreshTray();
}

async function checkLeftOverOnLaunch () {
    const enabledAt = lidSleep.readMarker()?.enabledAt;
    const action = await lidSleep.startupAction();
    if (action === 'restore-left-over') {
        const since = enabledAt ? ` (turned on ${new Date(enabledAt).toLocaleString()})` : '';
        notify('Restoring normal sleep', `Lid closed mode was still on when Mac Insomnia last stopped${since}.`);
        await restoreLeftOver();
    } else if (action === 'report-external') {
        notify('Sleep is disabled on this Mac', 'Something set pmset disablesleep. The Insomnia menu can restore normal sleep.');
    } else if (action === 'report-unknown') {
        notify('Sleep setting unknown', 'Could not read pmset -g. The Insomnia menu can restore normal sleep.');
    }
    refreshTray();
}

function handleExternalLinks () {
    app.on('web-contents-created', (_event, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
            if (!url.startsWith('file://')) {
                shell.openExternal(url);
                return { action: 'deny' };
            }
            return { action: 'allow' };
        });
        contents.on('will-navigate', (event, url) => {
            if (!url.startsWith('file://')) {
                event.preventDefault();
                shell.openExternal(url);
            }
        });
    });
}

app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('window-all-closed', () => {});
    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleUrl(url);
    });

    app.whenReady().then(async () => {
        if (app.dock) app.dock.hide();
        loadSettings();
        duration = parseDuration(settings.defaultDuration);
        lidSleep = new LidSleepController({
            markerPath: path.join(app.getPath('userData'), 'lid-closed-mode.json'),
            onUnexpectedEnd: () => onLidModeEndedUnexpectedly()
        });
        handleExternalLinks();
        createTray();
        if (app.isPackaged) app.setAsDefaultProtocolClient(URL_SCHEME);
        claudeWatcher = new ClaudeWatcher({
            onChange: () => refreshTray(),
            onError: (error) => console.error('Smart Mode:', error)
        });
        claudeWatcher.sweepOrphans();
        applySmartMode();
        pendingUrls.splice(0).forEach(handleUrl);
        powerMonitor.on('on-battery', () => {
            if (lidSleep.active) notify('Lid closed mode is on battery', 'The Mac will not sleep. Connect power, and never put it in a bag while this is on.');
        });
        powerMonitor.on('resume', () => {
            if (endTimer) onTimerEnd();
        });
        powerMonitor.on('shutdown', () => {
            shuttingDown = true;
            lidSleep.killToken();
            app.quit();
        });
        await checkLeftOverOnLaunch();
    }).catch(console.error);

    app.on('before-quit', (event) => {
        quitting = true;
        if (lidSleep?.pending || shuttingDown) lidSleep?.killToken();
        if (!shuttingDown && lidBusy && !lidSleep?.pending) {
            event.preventDefault();
            setTimeout(() => app.quit(), 200);
            return;
        }
        if (!shuttingDown && lidSleep?.active) {
            event.preventDefault();
            disableLidMode().finally(() => app.quit());
            return;
        }
        stopCaffeinate();
        claudeWatcher?.stop();
        if (soundProcess) soundProcess.kill();
    });

    process.on('SIGTERM', () => app.quit());
    process.on('SIGINT', () => app.quit());
}
