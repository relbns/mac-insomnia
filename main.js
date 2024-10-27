const { app, Tray, Menu, nativeImage } = require('electron');
const { BrowserWindow } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');

// Global references
let tray = null;
let mediaWindow = null;
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

function playSound(isActivating) {
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

function createContextMenu() {
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
            label: 'Quit Insomnia',
            click: () => {
                stopCaffeinate();
                app.quit();
            }
        }
    ]);
}

function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
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

function updateTrayMenu() {
    // Only update icon and tooltip, don't set context menu
    const iconPath = isPlaying ? 'icon-active.png' : 'icon.png';
    const icon = nativeImage.createFromPath(path.join(__dirname, iconPath));
    icon.setTemplateImage(true);
    tray.setImage(icon);
    updateTrayTooltip();
}

// Initialize app
app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
        await app.dock.hide();
    }
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