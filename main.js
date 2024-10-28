const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

// Settings management
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let settings = {
    defaultDuration: null,  // null means infinite
    iconSet: 'set1',       // 'set1' or 'set2'
    soundEnabled: true,
    startAtLogin: false
};

// Add these helper functions at the top of your main.js
function isDevelopment () {
    return !app.isPackaged;
}

// Update the settings loading function
function loadSettings () {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            settings = { ...settings, ...JSON.parse(data) };

            // Force startAtLogin to false in development
            if (isDevelopment()) {
                settings.startAtLogin = false;
            }
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Save settings to file
function saveSettings (newSettings) {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(newSettings));
        settings = { ...settings, ...newSettings };
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

// Global references
let tray = null;
let settingsWindow = null;
let aboutWindow = null;
let isPlaying = false;
let caffeinateProcess = null;
let duration = null;  // null means infinite
let endTime = null;
let durationCheckInterval = null;

function createWindow () {
    mediaWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
}

ipcMain.on('save-settings', (event, newSettings) => {
    if (isDevelopment()) {
        newSettings.startAtLogin = false;
    }

    const previousIconSet = settings.iconSet;
    saveSettings(newSettings);
    updateLoginSettings(newSettings.startAtLogin);

    if (newSettings.iconSet !== previousIconSet) {
        updateTrayMenu();
    }

    if (newSettings.defaultDuration !== settings.defaultDuration) {
        duration = newSettings.defaultDuration === 'null' ? null : parseInt(newSettings.defaultDuration);
        updateTrayMenu();
    }
});

// Add this IPC handler to check login item status
ipcMain.handle('check-login-item-status', () => {
    return app.getLoginItemSettings().openAtLogin;
});

function createSettingsWindow () {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 400,
        height: 480,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#1e1e1e',
        show: false,
        frame: true,
        resizable: false,
        fullscreenable: false
    });

    settingsWindow.loadFile('settings.html');

    settingsWindow.once('ready-to-show', () => {
        // Modify settings object for development mode
        const displaySettings = {
            ...settings,
            startAtLogin: isDevelopment() ? false : settings.startAtLogin
        };
        settingsWindow.show();
        settingsWindow.webContents.send('load-settings', displaySettings);
    });

    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function createAboutWindow () {
    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }

    aboutWindow = new BrowserWindow({
        width: 300,
        height: 400,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#1e1e1e',
        show: false,
        frame: true,
        resizable: false,
        alwaysOnTop: true,
        minimizable: false,
        fullscreenable: false
    });

    aboutWindow.loadFile('about.html');

    aboutWindow.once('ready-to-show', () => {
        aboutWindow.show();
    });

    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });
}

function updateLoginSettings (openAtLogin) {
    try {
        // Skip setting login item in development
        if (isDevelopment()) {
            console.log('Login item settings skipped in development mode');
            settings.startAtLogin = false; // Force false in development
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

    // Update settings window if it's open
    if (settingsWindow) {
        settingsWindow.webContents.send('load-settings', settings);
    }
}

function getIconPaths () {
    let iconSet = settings.iconSet || 'set1';
    iconSet = iconSet.replace('set', '');
    iconSet = iconSet === '1' ? '' : iconSet;
    return {
        active: `icon-active${iconSet}.png`,
        inactive: `icon${iconSet}.png`
    };
}

function playSound (isActivating) {
    if (!settings.soundEnabled) return;
    const sound = isActivating ? 'Pop' : 'Bottle';
    exec(`afplay /System/Library/Sounds/${sound}.aiff`);
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
                {
                    label: 'Infinite',
                    type: 'radio',
                    checked: duration === null,
                    click: () => setDuration(null)
                },
                {
                    label: '30 minutes',
                    type: 'radio',
                    checked: duration === 30 * 60 * 1000,
                    click: () => setDuration(30 * 60 * 1000)
                },
                {
                    label: '1 hour',
                    type: 'radio',
                    checked: duration === 60 * 60 * 1000,
                    click: () => setDuration(60 * 60 * 1000)
                },
                {
                    label: '2 hours',
                    type: 'radio',
                    checked: duration === 2 * 60 * 60 * 1000,
                    click: () => setDuration(2 * 60 * 60 * 1000)
                }
            ]
        },
        { type: 'separator' },
        {
            label: 'Settings',
            click: () => createSettingsWindow()
        },
        {
            label: 'About',
            click: () => createAboutWindow()
        },
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
    const icon = nativeImage.createFromPath(path.join(__dirname, iconPaths.inactive));
    icon.setTemplateImage(true);

    tray = new Tray(icon);

    // Prevent menu on left click
    tray.setIgnoreDoubleClickEvents(true);

    // Handle left-click
    tray.on('click', (event) => {
        tray.popUpContextMenu(createContextMenu());
    });

    // Handle right-click
    tray.on('right-click', (event) => {
        togglePlayback();
    });

    updateTrayMenu();
}

function startCaffeinate () {
    stopCaffeinate(); // Clear any existing process

    // Start caffeinate process to prevent sleep
    caffeinateProcess = spawn('caffeinate', ['-d', '-i', '-m']);

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
    if (durationCheckInterval) {
        clearInterval(durationCheckInterval);
    }

    durationCheckInterval = setInterval(() => {
        if (endTime && Date.now() >= endTime) {
            togglePlayback();
        } else {
            updateTrayTooltip();
        }
    }, 1000);
}

function stopCaffeinate () {
    if (caffeinateProcess) {
        caffeinateProcess.kill();
        caffeinateProcess = null;
    }

    if (durationCheckInterval) {
        clearInterval(durationCheckInterval);
        durationCheckInterval = null;
    }

    endTime = null;
}

function setDuration (ms) {
    duration = ms;
    if (isPlaying) {
        startCaffeinate();
    }
    updateTrayMenu();
}

function formatTimeRemaining () {
    if (!endTime) return 'Running indefinitely';

    const remaining = Math.max(0, endTime - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours > 0) {
        return `${hours}h ${mins}m remaining`;
    }
    return `${mins}m remaining`;
}

function togglePlayback () {
    isPlaying = !isPlaying;

    if (isPlaying) {
        playSound(true);
        startCaffeinate();
    } else {
        playSound(false);
        stopCaffeinate();
    }

    updateTrayMenu();
}

function updateTrayTooltip () {
    if (!isPlaying) {
        tray.setToolTip('Insomnia - Stopped');
        return;
    }

    tray.setToolTip(`Insomnia - ${formatTimeRemaining()}`);
}

function updateTrayMenu () {
    const iconPaths = getIconPaths();
    const iconPath = isPlaying ? iconPaths.active : iconPaths.inactive;
    try {
        const icon = nativeImage.createFromPath(path.join(__dirname, iconPath));
        icon.setTemplateImage(true);
        tray.setImage(icon);
    } catch (error) {
        console.error('Error updating tray icon:', error);
        // Fallback to default icon if alternative icon fails to load
        const defaultIcon = nativeImage.createFromPath(path.join(__dirname, isPlaying ? 'icon-active.png' : 'icon.png'));
        defaultIcon.setTemplateImage(true);
        tray.setImage(defaultIcon);
    }

    updateTrayTooltip();
}


// Initialize app
app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
        await app.dock.hide();
    }
    loadSettings();
    updateLoginSettings(settings.startAtLogin);
    duration = settings.defaultDuration === 'null' ? null : parseInt(settings.defaultDuration);
    createWindow();
    createTray();
}).catch(console.error);

// Cleanup
app.on('before-quit', () => {
    stopCaffeinate();
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

// Handle process termination
process.on('SIGTERM', () => {
    stopCaffeinate();
    app.quit();
});

process.on('SIGINT', () => {
    stopCaffeinate();
    app.quit();
});