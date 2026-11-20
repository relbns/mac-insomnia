const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('insomnia', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
    onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (_event, settings) => callback(settings)),
    getVersion: () => ipcRenderer.invoke('get-app-version'),
    fitWindow: (height) => ipcRenderer.send('fit-window', height),
    sendTestNotification: () => ipcRenderer.invoke('send-test-notification'),
    openNotificationSettings: () => ipcRenderer.invoke('open-notification-settings'),
    openGuide: () => ipcRenderer.send('open-guide'),
    openSettings: () => ipcRenderer.send('open-settings'),
    copyText: (text) => ipcRenderer.send('copy-text', text),
    installClaudeHooks: () => ipcRenderer.invoke('install-claude-hooks')
});
