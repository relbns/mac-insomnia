const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('insomnia', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
    getVersion: () => ipcRenderer.invoke('get-app-version')
});
