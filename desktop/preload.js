const { contextBridge, ipcRenderer } = require('electron');

const SERVER_URL = normalizeBaseUrl(process.env.SERVER_URL || 'https://boshan.s.3q.hair');
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 30000);

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => process.versions.electron,
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => process.platform,
  getRuntimeConfig: () => ({
    serverUrl: SERVER_URL,
    disconnectGraceMs: DISCONNECT_GRACE_MS
  }),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  minimize: () => ipcRenderer.send('window-minimize'),
  minimizeToTray: () => ipcRenderer.send('window-minimize-to-tray'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  showNotification: (title, body) => {
    if (Notification.isSupported()) {
      new Notification(title, { body });
    }
  },
  audioCapture: {
    isPlatformSupported: () => ipcRenderer.invoke('process-audio-capture:is-platform-supported'),
    checkPermission: () => ipcRenderer.invoke('process-audio-capture:check-permission'),
    requestPermission: () => ipcRenderer.invoke('process-audio-capture:request-permission'),
    getProcessList: () => ipcRenderer.invoke('process-audio-capture:get-process-list'),
    startCapture: (pid) => ipcRenderer.invoke('process-audio-capture:start-capture', pid),
    stopCapture: () => ipcRenderer.invoke('process-audio-capture:stop-capture'),
    isCapturing: () => ipcRenderer.invoke('process-audio-capture:is-capturing'),
    on: (eventName, callback) => {
      const id = crypto.randomUUID();
      const listener = (_event, ...args) => callback(...args);
      ipcRenderer.send(`process-audio-capture:on-${eventName}`, id);
      ipcRenderer.on(`process-audio-capture:on-${eventName}:${id}`, listener);
      return () => {
        ipcRenderer.off(`process-audio-capture:on-${eventName}:${id}`, listener);
        ipcRenderer.send(`process-audio-capture:off-${eventName}`, id);
      };
    }
  },
  onMaximizedChange: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window-maximized-changed', listener);
    return () => ipcRenderer.off('window-maximized-changed', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  getUpdateLogSnapshot: () => ipcRenderer.invoke('get-update-log-snapshot'),
  onUpdateStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.off('update-status', listener);
  },
  onUpdateLog: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-log', listener);
    return () => ipcRenderer.off('update-log', listener);
  }
});

contextBridge.exposeInMainWorld('isElectron', true);

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}
