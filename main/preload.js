const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('insomnia', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
    onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (_event, settings) => callback(settings)),
    getVersion: () => ipcRenderer.invoke('get-app-version')
});
