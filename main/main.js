const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { ClaudeWatcher, URL_SCHEME, CLAUDE_SETTINGS, readClaudeSettings, writeClaudeSettings, hasHooks, addHooks, removeHooks } = require('./claude-watch');

// Paths
const ASSETS_PATH = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets');
const RENDERER_PATH = path.join(process.resourcesPath, 'app.asar.unpacked', 'renderer');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// Default settings
let settings = {
    defaultDuration: null, // null = infinite
    iconSet: 'set1',
    soundEnabled: true,
    startAtLogin: false,
    smartMode: false
};

// Helpers
function isDevelopment () {
    return !app.isPackaged;
}

// Settings management
function loadSettings () {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            settings = { ...settings, ...JSON.parse(data) };
            if (isDevelopment()) settings.startAtLogin = false;
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

function saveSettings (newSettings) {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(newSettings));
        settings = { ...settings, ...newSettings };
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

// Global refs
let tray = null;
let settingsWindow = null;
let aboutWindow = null;
let isPlaying = false;
let caffeinateProcess = null;
let duration = null;
let endTime = null;
let durationCheckInterval = null;
let claudeWatcher = null;
const pendingUrls = [];

// Create hidden helper window
function createWindow () {
    const mediaWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    return mediaWindow;
}

ipcMain.on('save-settings', (event, newSettings) => {
    if (isDevelopment()) newSettings.startAtLogin = false;

    const previousIconSet = settings.iconSet;
    saveSettings({ ...settings, ...newSettings });
    updateLoginSettings(newSettings.startAtLogin);

    if (newSettings.iconSet !== previousIconSet) updateTrayMenu();
    if (newSettings.defaultDuration !== settings.defaultDuration) {
        duration = newSettings.defaultDuration === 'null' ? null : parseInt(newSettings.defaultDuration);
        updateTrayMenu();
    }
});

ipcMain.handle('check-login-item-status', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('get-app-version', () => app.getVersion());

// Settings window
function createSettingsWindow () {
    if (settingsWindow) return settingsWindow.focus();

    settingsWindow = new BrowserWindow({
        width: 400,
        height: 480,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        backgroundColor: '#1e1e1e',
        show: false,
        frame: true,
        resizable: false,
        fullscreenable: false
    });

    settingsWindow.loadFile(path.join(RENDERER_PATH, 'settings.html'));
    settingsWindow.once('ready-to-show', () => {
        const displaySettings = { ...settings, startAtLogin: isDevelopment() ? false : settings.startAtLogin };
        settingsWindow.show();
        settingsWindow.webContents.send('load-settings', displaySettings);
    });

    settingsWindow.on('closed', () => (settingsWindow = null));
}

// About window
function createAboutWindow () {
    if (aboutWindow) return aboutWindow.focus();

    aboutWindow = new BrowserWindow({
        width: 300,
        height: 400,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        backgroundColor: '#1e1e1e',
        show: false,
        frame: true,
        resizable: false,
        alwaysOnTop: true,
        minimizable: false,
        fullscreenable: false
    });

    aboutWindow.loadFile(path.join(RENDERER_PATH, 'about.html'));
    aboutWindow.once('ready-to-show', () => aboutWindow.show());
    aboutWindow.on('closed', () => (aboutWindow = null));
}

// Login item
function updateLoginSettings (openAtLogin) {
    try {
        if (isDevelopment()) {
            console.log('Login item skipped in development mode');
            settings.startAtLogin = false;
            return;
        }
        app.setLoginItemSettings({
            openAtLogin,
            openAsHidden: true,
            path: process.execPath
        });
        settings.startAtLogin = openAtLogin;
    } catch (error) {
        console.log('Login item settings not available:', error.message);
        settings.startAtLogin = false;
    }

    saveSettings(settings);
    if (settingsWindow) settingsWindow.webContents.send('load-settings', settings);
}

// Icons
function getIconPaths () {
    let iconSet = settings.iconSet?.replace('set', '') || '1';
    iconSet = iconSet === '1' ? '' : iconSet;
    return {
        active: path.join(ASSETS_PATH, `icon-active${iconSet}.png`),
        inactive: path.join(ASSETS_PATH, `icon${iconSet}.png`)
    };
}

function playSound (isActivating) {
    if (!settings.soundEnabled) return;
    const sound = isActivating ? 'Pop' : 'Bottle';
    exec(`afplay /System/Library/Sounds/${sound}.aiff`);
}

// Tray management
function formatDurationLabel (ms) {
    if (ms === null) return 'Infinite';
    const minutes = ms / 60000;
    if (minutes >= 60) {
        const hours = minutes / 60;
        return `${hours} hour${hours > 1 ? 's' : ''}`;
    }
    return `${minutes} minutes`;
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
    saveSettings({ ...settings, smartMode: !settings.smartMode });
    applySmartMode();
}

function smartStatusLabel () {
    const n = claudeWatcher?.count || 0;
    if (claudeWatcher?.mode === 'hooks') return n ? `Claude is working in ${n} session${n > 1 ? 's' : ''}` : 'Claude is idle';
    return `${n} Claude Code process${n === 1 ? '' : 'es'} open (hooks not installed)`;
}

async function changeClaudeHooks (install) {
    try {
        readClaudeSettings();
    } catch (error) {
        dialog.showErrorBox('Could not read Claude Code settings', `${CLAUDE_SETTINGS} is not valid JSON, so it was left unchanged.\n\n${error.message}`);
        return;
    }
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
}

function handleUrl (url) {
    if (!claudeWatcher) {
        pendingUrls.push(url);
        return;
    }
    claudeWatcher.handleUrl(url);
}

function createContextMenu () {
    return Menu.buildFromTemplate([
        {
            label: isPlaying ? `Stop (${formatDurationLabel(duration)}) Insomnia` : `Start (${formatDurationLabel(duration)}) Insomnia`,
            click: () => togglePlayback()
        },
        { type: 'separator' },
        {
            label: 'Set Duration',
            submenu: [
                { label: 'Infinite', type: 'radio', checked: duration === null, click: () => setDuration(null) },
                { label: '30 minutes', type: 'radio', checked: duration === 30 * 60 * 1000, click: () => setDuration(30 * 60 * 1000) },
                { label: '1 hour', type: 'radio', checked: duration === 60 * 60 * 1000, click: () => setDuration(60 * 60 * 1000) },
                { label: '2 hours', type: 'radio', checked: duration === 2 * 60 * 60 * 1000, click: () => setDuration(2 * 60 * 60 * 1000) }
            ]
        },
        { type: 'separator' },
        { label: 'Smart Mode: Keep Awake While Claude Works', type: 'checkbox', checked: settings.smartMode, click: () => toggleSmartMode() },
        ...(settings.smartMode ? [{ label: smartStatusLabel(), enabled: false }] : []),
        claudeHooksInstalled()
            ? { label: 'Remove Claude Code Hooks…', click: () => changeClaudeHooks(false) }
            : { label: 'Install Claude Code Hooks…', click: () => changeClaudeHooks(true) },
        { type: 'separator' },
        { label: 'Settings', click: () => createSettingsWindow() },
        { label: 'About', click: () => createAboutWindow() },
        { type: 'separator' },
        {
            label: 'Quit Insomnia',
            click: () => {
                stopCaffeinate();
                app.quit();
            }
        }
    ]);
}

function createTray () {
    const iconPaths = getIconPaths();
    const icon = nativeImage.createFromPath(iconPaths.inactive);
    icon.setTemplateImage(true);

    tray = new Tray(icon);
    tray.setIgnoreDoubleClickEvents(true);

    tray.on('click', () => tray.popUpContextMenu(createContextMenu()));
    tray.on('right-click', () => togglePlayback());

    updateTrayMenu();
}

function startCaffeinate () {
    stopCaffeinate();
    caffeinateProcess = spawn('caffeinate', ['-dimsu', '-w', process.pid.toString()]);
    caffeinateProcess.on('error', (err) => {
        console.error('Error starting caffeinate:', err);
        stopCaffeinate();
        isPlaying = false;
        updateTrayMenu();
    });
    if (duration) {
        endTime = Date.now() + duration;
        startDurationCheck();
    }
}

function startDurationCheck () {
    clearInterval(durationCheckInterval);
    durationCheckInterval = setInterval(() => {
        if (endTime && Date.now() >= endTime) togglePlayback();
        else updateTrayTooltip();
    }, 1000);
}

function stopCaffeinate () {
    if (caffeinateProcess) {
        try {
            process.kill(caffeinateProcess.pid, 'SIGTERM');
        } catch (err) {
            console.warn('Failed to kill caffeinate process:', err.message);
        }
        caffeinateProcess = null;
    }

    clearInterval(durationCheckInterval);
    durationCheckInterval = null;
    endTime = null;
}

function setDuration (ms) {
    duration = ms;
    if (isPlaying) startCaffeinate();
    updateTrayMenu();
}

function formatTimeRemaining () {
    if (!endTime) return 'Running indefinitely';
    const remaining = Math.max(0, endTime - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours > 0 ? `${hours}h ${mins}m remaining` : `${mins}m remaining`;
}

function togglePlayback () {
    isPlaying = !isPlaying;
    playSound(isPlaying);
    isPlaying ? startCaffeinate() : stopCaffeinate();
    updateTrayMenu();
}

function updateTrayTooltip () {
    const smart = settings.smartMode ? ` - ${smartStatusLabel()}` : '';
    tray.setToolTip(isPlaying ? `Insomnia - ${formatTimeRemaining()}${smart}` : `Insomnia - Stopped${smart}`);
}

function updateTrayMenu () {
    const iconPaths = getIconPaths();
    const awake = isPlaying || Boolean(claudeWatcher?.count);
    const iconPath = awake ? iconPaths.active : iconPaths.inactive;
    try {
        const icon = nativeImage.createFromPath(iconPath);
        icon.setTemplateImage(true);
        tray.setImage(icon);
    } catch (error) {
        console.error('Error updating tray icon:', error);
        const fallback = nativeImage.createFromPath(path.join(ASSETS_PATH, awake ? 'icon-active.png' : 'icon.png'));
        fallback.setTemplateImage(true);
        tray.setImage(fallback);
    }
    updateTrayTooltip();
}

// Initialize
app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) await app.dock.hide();
    loadSettings();
    updateLoginSettings(settings.startAtLogin);
    duration = settings.defaultDuration === 'null' ? null : parseInt(settings.defaultDuration);
    createWindow();
    const { shell } = require('electron');

    // Open external links in default browser (instead of new Electron window)
    app.on('web-contents-created', (_, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
            // Open any external link in default browser
            if (!url.startsWith('file://')) {
                shell.openExternal(url);
                return { action: 'deny' };
            }
            return { action: 'allow' };
        });

        // Also intercept regular link clicks (without target="_blank")
        contents.on('will-navigate', (event, url) => {
            if (!url.startsWith('file://')) {
                event.preventDefault();
                shell.openExternal(url);
            }
        });
    });

    createTray();
    if (app.isPackaged) app.setAsDefaultProtocolClient(URL_SCHEME);
    claudeWatcher = new ClaudeWatcher({
        onChange: () => tray && updateTrayMenu(),
        onError: (error) => console.error('Smart Mode:', error)
    });
    claudeWatcher.sweepOrphans();
    applySmartMode();
    pendingUrls.splice(0).forEach(handleUrl);
}).catch(console.error);

app.on('open-url', (event, url) => {
    event.preventDefault();
    handleUrl(url);
});

// Cleanup
app.on('before-quit', () => {
    stopCaffeinate();
    claudeWatcher?.stop();
});
app.on('window-all-closed', (e) => e.preventDefault());
process.on('SIGTERM', () => { stopCaffeinate(); app.quit(); });
process.on('SIGINT', () => { stopCaffeinate(); app.quit(); });
