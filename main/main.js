const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, dialog, powerMonitor, Notification, shell, systemPreferences, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { LidSleepController } = require('./lid-sleep');
const { keepAwakeArgs } = require('./keep-awake-args');
const { ProcessWatcher } = require('./process-watch');
const { DEFAULT_IDLE_MINUTES, normalizeIdleMinutes, shouldArmIdleTimer, idleDelayMs } = require('./claude-lid');
const { warningPlan, extendedEndTime, minutesLeft, extendLabel } = require('./timer-warning');
const { GUARD_LEVELS, DEFAULT_GUARD_PERCENT, BatteryMonitor, normalizeGuardPercent, shouldMonitor, shouldStop, shouldResumeSmartMode, lidModeAllowed } = require('./battery-guard');
const { parseCommandUrl } = require('./url-commands');
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
    smartMode: false,
    allowDisplaySleep: false,
    batteryGuardPercent: DEFAULT_GUARD_PERCENT,
    lidOffOnBattery: true,
    timerWarning: true,
    lidEndsWhenClaudeIdle: DEFAULT_IDLE_MINUTES
};

let tray = null;
let settingsWindow = null;
let aboutWindow = null;
let isPlaying = false;
let caffeinateProcess = null;
let duration = null;
let endTime = null;
let endTimer = null;
let warnTimer = null;
let warningNotification = null;
let timerArmedAt = null;
let lidIdleTimer = null;
let lidIdleMinutes = null;
let lidIdleArmedAt = null;
let lidSawClaudeWork = false;
let lidIdleFired = false;
let lidStartedPlayback = false;
let processWatcher = null;
let processCandidates = [];
let processRefresh = null;
let warnedForEndTime = null;
let soundProcess = null;
let cachedMenu = null;
let lidSleep = null;
let lidBusy = false;
let quitting = false;
let shuttingDown = false;
let pmsetRefresh = null;
let claudeWatcher = null;
let batteryMonitor = null;
let onBattery = false;
let lastBatteryPercent = null;
let guardStopping = false;
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
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings-changed', settingsForRenderer());
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

const SETTING_APPLIERS = {
    defaultDuration: (value) => {
        settings.defaultDuration = parseDuration(value);
        if (!isPlaying) duration = settings.defaultDuration;
        saveSettings();
    },
    iconSet: (value) => {
        settings.iconSet = value === 'set2' ? 'set2' : 'set1';
        iconCache.clear();
        saveSettings();
    },
    soundEnabled: (value) => {
        settings.soundEnabled = Boolean(value);
        saveSettings();
    },
    startAtLogin: (value) => {
        settings.startAtLogin = setStartAtLogin(Boolean(value));
        saveSettings();
    },
    allowDisplaySleep: (value) => setAllowDisplaySleep(Boolean(value)),
    lidEndsWhenClaudeIdle: (value) => {
        settings.lidEndsWhenClaudeIdle = normalizeIdleMinutes(value);
        saveSettings();
    },
    smartMode: (value) => setSmartMode(Boolean(value)),
    timerWarning: (value) => {
        settings.timerWarning = Boolean(value);
        saveSettings();
        if (!settings.timerWarning) closeWarning();
        scheduleTimers();
    },
    batteryGuardPercent: (value) => setBatteryGuard(normalizeGuardPercent(value)),
    lidOffOnBattery: (value) => setLidOffOnBattery(Boolean(value))
};

function settingsForRenderer () {
    const accent = systemPreferences.getAccentColor?.() || '007affff';
    return {
        ...settings,
        batteryGuardPercent: normalizeGuardPercent(settings.batteryGuardPercent),
        lidEndsWhenClaudeIdle: normalizeIdleMinutes(settings.lidEndsWhenClaudeIdle),
        claudeHooksInstalled: claudeHooksInstalled(),
        isDevelopment: isDevelopment(),
        accentColor: `#${accent.slice(0, 6)}`
    };
}

ipcMain.handle('set-setting', (_event, key, value) => {
    if (!Object.hasOwn(SETTING_APPLIERS, key)) return settingsForRenderer();
    SETTING_APPLIERS[key](value);
    refreshTray();
    return settingsForRenderer();
});

ipcMain.handle('get-settings', () => settingsForRenderer());
ipcMain.handle('get-app-version', () => app.getVersion());

let testNotification = null;

ipcMain.handle('send-test-notification', () => {
    if (!Notification.isSupported()) return false;
    testNotification?.close();
    testNotification = new Notification({
        title: 'Notifications from Mac Insomnia work',
        body: 'Timer reminders and battery alerts will look like this.'
    });
    testNotification.show();
    return true;
});

ipcMain.handle('open-notification-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'));

function secureWebPreferences () {
    return { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true };
}

const WINDOW_SCREEN_MARGIN = 60;

function fitWindowHeight (win, height) {
    if (!win || win.isDestroyed() || !Number.isFinite(height) || height <= 0) return;
    const maxHeight = screen.getDisplayMatching(win.getBounds()).workAreaSize.height - WINDOW_SCREEN_MARGIN;
    win.setContentSize(win.getContentSize()[0], Math.min(Math.ceil(height), maxHeight), win.isVisible());
}

ipcMain.on('fit-window', (event, height) => fitWindowHeight(BrowserWindow.fromWebContents(event.sender), height));

function openWindow (existing, options, file) {
    if (existing) {
        existing.focus();
        return existing;
    }
    const win = new BrowserWindow({
        show: false,
        resizable: false,
        fullscreenable: false,
        minimizable: false,
        maximizable: false,
        titleBarStyle: 'hiddenInset',
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#00000000',
        ...options,
        webPreferences: secureWebPreferences()
    });
    win.loadFile(path.join(RENDERER_PATH, file));
    win.once('ready-to-show', async () => {
        const height = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)').catch(() => null);
        fitWindowHeight(win, height);
        win.center();
        win.show();
    });
    return win;
}

function createSettingsWindow () {
    settingsWindow = openWindow(settingsWindow, { width: 460, height: 560, title: 'Settings' }, 'settings.html');
    settingsWindow.once('closed', () => (settingsWindow = null));
}

function createAboutWindow () {
    aboutWindow = openWindow(aboutWindow, { width: 320, height: 380, title: 'About Mac Insomnia' }, 'about.html');
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
        const idleMinutes = normalizeIdleMinutes(settings.lidEndsWhenClaudeIdle);
        if (settings.smartMode && idleMinutes && claudeWatcher?.mode === 'hooks') items.push({ label: `Ends ${idleMinutes} min after Claude finishes`, enabled: false });
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
    setSmartMode(!settings.smartMode);
}

function setSmartMode (value) {
    if (settings.smartMode === value) return;
    settings.smartMode = value;
    saveSettings();
    applySmartMode();
}

function updateLidIdleTimer () {
    const lidActive = Boolean(lidSleep?.active);
    const claudeBusy = Boolean(claudeWatcher?.count);
    if (!lidActive) {
        lidSawClaudeWork = false;
        lidIdleFired = false;
    } else if (claudeBusy) {
        lidSawClaudeWork = true;
    }
    const minutes = normalizeIdleMinutes(settings.lidEndsWhenClaudeIdle);
    const arm = !lidIdleFired && shouldArmIdleTimer({
        idleMinutes: minutes,
        smartMode: settings.smartMode,
        lidActive,
        claudeBusy,
        sawClaudeWork: lidSawClaudeWork,
        lastReleaseReason: claudeWatcher?.lastReleaseReason
    });
    if (!arm) {
        clearTimeout(lidIdleTimer);
        lidIdleTimer = null;
        lidIdleMinutes = null;
        lidIdleArmedAt = null;
        return;
    }
    lidIdleArmedAt ??= Date.now();
    if (lidIdleTimer && lidIdleMinutes === minutes) return;
    clearTimeout(lidIdleTimer);
    lidIdleMinutes = minutes;
    lidIdleTimer = setTimeout(() => onClaudeIdleTooLong(minutes), idleDelayMs({ armedAt: lidIdleArmedAt, minutes, now: Date.now() }));
}

async function onClaudeIdleTooLong (minutes) {
    lidIdleTimer = null;
    lidIdleArmedAt = null;
    if (!lidSleep.active) return;
    lidIdleFired = true;
    const startedByLid = lidStartedPlayback;
    const result = await disableLidMode();
    if (result?.restored) {
        if (startedByLid) stopPlayback();
        notify('Claude is done', startedByLid
            ? `No Claude Code session has worked for ${minutes} minutes, so Insomnia ended the session it started for Lid Closed Mode. The Mac can sleep now.`
            : `No Claude Code session has worked for ${minutes} minutes, so Insomnia turned off Lid Closed Mode. With the lid closed, the Mac can sleep now; your Insomnia session keeps running.`);
    }
    refreshTray();
}

function smartStatusLabel () {
    const n = claudeWatcher?.count || 0;
    if (claudeWatcher?.suspended) return 'Paused by Battery Guard until power is connected';
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

function runUrlCommand ({ action, durationMs, pid }) {
    if (action === 'until') return processWatcher.watchPid(pid);
    if (action === 'stop') return stopPlayback();
    if (action === 'toggle') return togglePlayback();
    if (durationMs !== undefined) setDuration(durationMs);
    startPlayback();
}

function handleUrl (url) {
    if (!claudeWatcher) {
        pendingUrls.push(url);
        return;
    }
    const command = parseCommandUrl(url);
    if (command) runUrlCommand(command);
    else claudeWatcher.handleUrl(url);
}

function createContextMenu () {
    const runLabel = isPlaying ? `Stop Insomnia (${formatTimeRemaining()})` : `Start (${formatDurationLabel(duration)}) Insomnia`;
    return Menu.buildFromTemplate([
        { label: runLabel, click: () => togglePlayback() },
        ...(isPlaying && endTime ? [{ label: extendLabel(), click: () => extendTimer() }] : []),
        ...watchedMenuItems(),
        { type: 'separator' },
        {
            label: 'Set Duration',
            submenu: DURATIONS.map(({ label, ms }) => ({ label, type: 'radio', checked: duration === ms, click: () => setDuration(ms) }))
        },
        { label: 'Let the Display Sleep', type: 'checkbox', checked: settings.allowDisplaySleep, click: () => toggleAllowDisplaySleep() },
        { label: 'Keep Awake Until a Process Ends', submenu: processMenuItems() },
        { label: 'Battery Guard', submenu: batteryMenuItems() },
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
    refreshProcessCandidates();
}

function updateTooltip () {
    if (!tray) return;
    const lid = lidSleep?.active ? ' - lid closed mode' : '';
    const warning = lidSleep && !lidSleep.active && lidSleep.systemSleepDisabled !== false ? ' - sleep disabled system-wide' : '';
    const smart = settings.smartMode && claudeWatcher ? ` - ${smartStatusLabel()}` : '';
    const waiting = processWatcher?.count ? ` - waiting for ${processWatcher.list().map((p) => p.name).join(', ')}` : '';
    tray.setToolTip(isPlaying ? `Insomnia - ${formatTimeRemaining()}${lid}${warning}${smart}${waiting}` : `Insomnia - Stopped${warning}${smart}${waiting}`);
}

function refreshTray () {
    if (!tray) return;
    tray.setImage(trayIcon(isKeepingAwake()));
    updateTooltip();
    invalidateMenu();
    updateBatteryMonitoring();
    updateLidIdleTimer();
}

function isKeepingAwake () {
    return isPlaying || lidSleep.active || lidSleep.pending || Boolean(claudeWatcher?.count) || Boolean(processWatcher?.count);
}

function refreshProcessCandidates () {
    if (!processWatcher || processRefresh) return;
    processRefresh = processWatcher.candidates()
        .then((list) => {
            processCandidates = list;
            invalidateMenu();
        })
        .finally(() => { processRefresh = null; });
}

function processMenuItems () {
    const items = processCandidates.map(({ pid, name, cpu }) => ({
        label: `${name} (${Math.round(cpu)}% CPU)`,
        click: () => processWatcher.watch(pid, name)
    }));
    return items.length ? items : [{ label: 'No busy apps or tools right now', enabled: false }];
}

function watchedMenuItems () {
    return (processWatcher?.list() || []).map(({ pid, name }) => ({ label: `Stop Waiting for ${name}`, click: () => processWatcher.unwatch(pid) }));
}

function guardPercent () {
    return normalizeGuardPercent(settings.batteryGuardPercent);
}

function updateBatteryMonitoring () {
    if (!batteryMonitor) return;
    if (shouldMonitor({ guardPercent: guardPercent(), onBattery, awake: isKeepingAwake() })) {
        batteryMonitor.start();
    } else {
        batteryMonitor.stop();
        lastBatteryPercent = null;
    }
}

function onBatteryUpdate (state) {
    lastBatteryPercent = state.percent;
    evaluateBatteryGuard();
}

async function evaluateBatteryGuard () {
    if (guardStopping || !shouldStop({ guardPercent: guardPercent(), onBattery, percent: lastBatteryPercent, awake: isKeepingAwake() })) {
        updateBatteryMonitoring();
        return;
    }
    guardStopping = true;
    const percent = lastBatteryPercent;
    try {
        let lidRestored = true;
        if (lidSleep.pending) lidSleep.killToken();
        if (lidSleep.active) lidRestored = Boolean((await disableLidMode())?.restored);
        stopPlayback();
        if (settings.smartMode) claudeWatcher.suspend();
        processWatcher.unwatchAll();
        const smart = settings.smartMode ? ' Smart Mode resumes when power is connected.' : '';
        notify(`Battery at ${percent}%`, lidRestored
            ? `Insomnia stopped keeping the Mac awake (Battery Guard: ${guardPercent()}%).${smart}`
            : `Insomnia stopped its session, but sleep is still disabled. Open the Insomnia menu and choose "Restore Normal Sleep…".`);
    } finally {
        guardStopping = false;
        refreshTray();
    }
}

function resumeSmartModeIfAllowed () {
    if (claudeWatcher?.suspended && shouldResumeSmartMode({ guardPercent: guardPercent(), onBattery, percent: lastBatteryPercent })) {
        claudeWatcher.resume();
    }
}

function setBatteryGuard (percent) {
    settings.batteryGuardPercent = percent;
    saveSettings();
    resumeSmartModeIfAllowed();
    evaluateBatteryGuard();
    refreshTray();
}

function enforceLidRuleOnBattery () {
    if (lidModeAllowed({ lidOffOnBattery: settings.lidOffOnBattery, onBattery })) return;
    if (lidSleep.pending) {
        lidSleep.killToken();
        notify('Lid closed mode turned off', 'The Mac is on battery. Insomnia keeps it awake only while the lid is open.');
    } else if (lidSleep.active) {
        disableLidMode();
        notify('Lid closed mode turned off', 'The Mac is on battery. Insomnia keeps it awake only while the lid is open.');
    }
}

function toggleLidOffOnBattery () {
    setLidOffOnBattery(!settings.lidOffOnBattery);
}

function setLidOffOnBattery (value) {
    settings.lidOffOnBattery = value;
    saveSettings();
    enforceLidRuleOnBattery();
    refreshTray();
}

function batteryMenuItems () {
    const current = guardPercent();
    return [
        { label: 'Off', type: 'radio', checked: current === null, click: () => setBatteryGuard(null) },
        ...GUARD_LEVELS.map((level) => ({ label: `Stop at ${level}%`, type: 'radio', checked: current === level, click: () => setBatteryGuard(level) })),
        { type: 'separator' },
        { label: 'Turn Off Lid Closed Mode on Battery', type: 'checkbox', checked: settings.lidOffOnBattery, click: () => toggleLidOffOnBattery() }
    ];
}

function onPowerSourceChange (battery) {
    onBattery = battery;
    if (battery && !settings.lidOffOnBattery && lidSleep.active) {
        notify('Lid closed mode is on battery', 'The Mac will not sleep. Connect power, and never put it in a bag while this is on.');
    }
    enforceLidRuleOnBattery();
    if (!battery) lastBatteryPercent = null;
    resumeSmartModeIfAllowed();
    refreshTray();
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
    const child = spawn('/usr/bin/caffeinate', keepAwakeArgs({ allowDisplaySleep: settings.allowDisplaySleep, ownerPid: process.pid }), { stdio: 'ignore' });
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

function clearTimers () {
    clearTimeout(endTimer);
    clearTimeout(warnTimer);
    endTimer = null;
    warnTimer = null;
}

function closeWarning () {
    warningNotification?.close();
    warningNotification = null;
}

function scheduleTimers () {
    clearTimers();
    if (!isPlaying || !endTime) return;
    endTimer = setTimeout(onTimerEnd, Math.max(0, endTime - Date.now()));
    const plan = warningPlan({ enabled: settings.timerWarning, endTime, armedAt: timerArmedAt, now: Date.now(), warnedForEndTime });
    if (plan.action === 'schedule') warnTimer = setTimeout(showTimerWarning, plan.delayMs);
    if (plan.action === 'show-now') showTimerWarning();
}

function armTimer () {
    endTime = duration ? Date.now() + duration : null;
    timerArmedAt = Date.now();
    warnedForEndTime = null;
    closeWarning();
    scheduleTimers();
}

function showTimerWarning () {
    warnTimer = null;
    if (!isPlaying || !endTime) return;
    warnedForEndTime = endTime;
    if (!Notification.isSupported()) return;
    const minutes = minutesLeft({ endTime, now: Date.now() });
    const notification = new Notification({
        title: `Insomnia ends in ${minutes} minute${minutes === 1 ? '' : 's'}`,
        body: 'Click to add more time from the Insomnia menu.'
    });
    notification.on('click', () => showMenu());
    notification.show();
    closeWarning();
    warningNotification = notification;
}

function extendTimer () {
    if (!isPlaying || !endTime) return;
    endTime = extendedEndTime({ endTime, now: Date.now() });
    timerArmedAt = Date.now();
    closeWarning();
    scheduleTimers();
    refreshTray();
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
    clearTimers();
    closeWarning();
    warnedForEndTime = null;
    endTime = null;
    if (lidSleep.active) disableLidMode();
    else if (lidSleep.pending) lidSleep.killToken();
    refreshTray();
}

function togglePlayback () {
    isPlaying ? stopPlayback() : startPlayback();
}

function toggleAllowDisplaySleep () {
    setAllowDisplaySleep(!settings.allowDisplaySleep);
}

function setAllowDisplaySleep (value) {
    settings.allowDisplaySleep = value;
    saveSettings();
    if (caffeinateProcess) {
        stopCaffeinate();
        startCaffeinate();
    }
    refreshTray();
}

function setDuration (ms) {
    duration = ms;
    if (isPlaying) armTimer();
    refreshTray();
}

async function confirmLidMode () {
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
    onBattery = powerMonitor.isOnBatteryPower();
    if (!lidModeAllowed({ lidOffOnBattery: settings.lidOffOnBattery, onBattery })) {
        notify('Lid closed mode is off on battery', 'Connect power first, or turn off Battery Guard → Turn Off Lid Closed Mode on Battery.');
        return undefined;
    }
    return runLidTask(async () => {
        if (!(await confirmLidMode())) return;
        const wasPlaying = isPlaying;
        lidStartedPlayback = !wasPlaying;
        startPlayback();
        const result = await lidSleep.enable();
        if (result.ok) {
            onBattery = powerMonitor.isOnBatteryPower();
            const allowed = lidModeAllowed({ lidOffOnBattery: settings.lidOffOnBattery, onBattery });
            if (!isPlaying || !allowed) await lidSleep.disable({ allowPrompt: true });
            if (!allowed) notify('Lid closed mode turned off', 'The Mac switched to battery while it was being turned on.');
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
        onBattery = powerMonitor.isOnBatteryPower();
        batteryMonitor = new BatteryMonitor({ onUpdate: onBatteryUpdate, onError: (error) => console.error('Battery Guard:', error) });
        createTray();
        if (app.isPackaged) app.setAsDefaultProtocolClient(URL_SCHEME);
        claudeWatcher = new ClaudeWatcher({
            onChange: () => refreshTray(),
            onError: (error) => console.error('Smart Mode:', error)
        });
        claudeWatcher.sweepOrphans();
        processWatcher = new ProcessWatcher({
            keepAwakeFlags: () => [keepAwakeArgs({ allowDisplaySleep: settings.allowDisplaySleep, ownerPid: process.pid })[0]],
            onChange: () => refreshTray(),
            onFinished: ({ name }) => notify(`${name} finished`, 'Insomnia stopped waiting for it, so the Mac can sleep again.')
        });
        applySmartMode();
        pendingUrls.splice(0).forEach(handleUrl);
        powerMonitor.on('on-battery', () => onPowerSourceChange(true));
        powerMonitor.on('on-ac', () => onPowerSourceChange(false));
        powerMonitor.on('resume', () => {
            if (isPlaying && endTime) scheduleTimers();
            const battery = powerMonitor.isOnBatteryPower();
            if (battery !== onBattery) onPowerSourceChange(battery);
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
        clearTimeout(lidIdleTimer);
        closeWarning();
        processWatcher?.unwatchAll();
        batteryMonitor?.stop();
        claudeWatcher?.stop();
        if (soundProcess) soundProcess.kill();
    });

    process.on('SIGTERM', () => app.quit());
    process.on('SIGINT', () => app.quit());
}
