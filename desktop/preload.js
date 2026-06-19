const { contextBridge, ipcRenderer } = require('electron');

const SERVER_URL = normalizeBaseUrl(process.env.SERVER_URL || 'https://boshan.s.3q.hair');
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 30000);
const PREFERRED_AUDIO_BACKEND = String(process.env.VDS_PREFERRED_AUDIO_BACKEND || '').trim().toLowerCase();
const ENABLE_NATIVE_HOST_SESSION_BRIDGE = process.env.VDS_ENABLE_NATIVE_HOST_SESSION_BRIDGE !== '0';
const VERBOSE_MEDIA_LOGS = process.env.VDS_VERBOSE_MEDIA_LOGS === '1';
const ENABLE_AGENT_HOST_CAPTURE_PROCESS = process.env.VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS === '1';
const ENABLE_NATIVE_HOST_PREVIEW_SURFACE = process.env.VDS_ENABLE_NATIVE_HOST_PREVIEW_SURFACE !== '0';
const ENABLE_NATIVE_PEER_TRANSPORT = process.env.VDS_ENABLE_NATIVE_PEER_TRANSPORT !== '0';
const ENABLE_NATIVE_SURFACE_EMBEDDING = process.env.VDS_ENABLE_NATIVE_SURFACE_EMBEDDING !== '0';
const DEBUG_PRESET = String(process.env.VDS_DEBUG_PRESET || '').trim();
const mediaEngineAudio = createMediaEngineAudioApi();

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getRuntimeConfig: () => ({
    serverUrl: SERVER_URL,
    disconnectGraceMs: DISCONNECT_GRACE_MS,
    preferredAudioBackend: PREFERRED_AUDIO_BACKEND,
    enableNativeHostSessionBridge: ENABLE_NATIVE_HOST_SESSION_BRIDGE,
    verboseMediaLogs: VERBOSE_MEDIA_LOGS,
    enableAgentHostCaptureProcess: ENABLE_AGENT_HOST_CAPTURE_PROCESS,
    enableNativeHostPreviewSurface: ENABLE_NATIVE_HOST_PREVIEW_SURFACE,
    enableNativePeerTransport: ENABLE_NATIVE_PEER_TRANSPORT,
    enableNativeSurfaceEmbedding: ENABLE_NATIVE_SURFACE_EMBEDDING,
    debugPreset: DEBUG_PRESET
  }),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  minimize: () => ipcRenderer.send('window-minimize'),
  minimizeToTray: () => ipcRenderer.send('window-minimize-to-tray'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  setDebugConfig: (config) => ipcRenderer.send('renderer-debug-config-changed', config || {}),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  getWindowBounds: () => ipcRenderer.invoke('window-get-bounds'),
  getCursorScreenPoint: () => ipcRenderer.invoke('window-get-cursor-screen-point'),
  setFullscreen: (enabled) => ipcRenderer.invoke('window-set-fullscreen', enabled),
  isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
  mediaEngine: {
    start: () => ipcRenderer.invoke('media-engine-start'),
    audio: mediaEngineAudio,
    listCaptureTargets: () => ipcRenderer.invoke('media-engine-list-capture-targets'),
    startHostSession: (options) => ipcRenderer.invoke('media-engine-start-host-session', options),
    stopHostSession: () => ipcRenderer.invoke('media-engine-stop-host-session'),
    prepareObsIngest: (options) => ipcRenderer.invoke('media-engine-prepare-obs-ingest', options),
    startAudioSession: (options) => ipcRenderer.invoke('media-engine-start-audio-session', options),
    stopAudioSession: (options) => ipcRenderer.invoke('media-engine-stop-audio-session', options),
    createPeer: (options) => ipcRenderer.invoke('media-engine-create-peer', options),
    closePeer: (options) => ipcRenderer.invoke('media-engine-close-peer', options),
    setRemoteDescription: (options) => ipcRenderer.invoke('media-engine-set-remote-description', options),
    addRemoteIceCandidate: (options) => ipcRenderer.invoke('media-engine-add-remote-ice-candidate', options),
    attachPeerMediaSource: (options) => ipcRenderer.invoke('media-engine-attach-peer-media-source', options),
    detachPeerMediaSource: (options) => ipcRenderer.invoke('media-engine-detach-peer-media-source', options),
    attachSurface: (options) => ipcRenderer.invoke('media-engine-attach-surface', options),
    updateSurface: (options) => ipcRenderer.invoke('media-engine-update-surface', options),
    detachSurface: (options) => ipcRenderer.invoke('media-engine-detach-surface', options),
    setViewerAudioDelay: (options) => ipcRenderer.invoke('media-engine-set-viewer-audio-delay', options),
    setViewerVolume: (volume) => ipcRenderer.invoke('media-engine-set-viewer-volume', volume),
    getViewerVolume: () => ipcRenderer.invoke('media-engine-get-viewer-volume'),
    getCapabilities: () => ipcRenderer.invoke('media-engine-get-capabilities'),
    getStats: (options) => ipcRenderer.invoke('media-engine-get-stats', options),
    openNatMapping: (options) => ipcRenderer.invoke('p2p-open-nat-mapping', options),
    onStatus: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('media-engine-status', listener);
      return () => ipcRenderer.off('media-engine-status', listener);
    },
    onEvent: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('media-engine-event', listener);
      return () => ipcRenderer.off('media-engine-event', listener);
    }
  },
  onMaximizedChange: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window-maximized-changed', listener);
    return () => ipcRenderer.off('window-maximized-changed', listener);
  },
  onFullscreenChange: (callback) => {
    const listener = (_event, isFullscreen) => callback(isFullscreen);
    ipcRenderer.on('window-fullscreen-changed', listener);
    return () => ipcRenderer.off('window-fullscreen-changed', listener);
  },
  onWindowBoundsChange: (callback) => {
    const listener = (_event, bounds) => callback(bounds);
    ipcRenderer.on('window-bounds-changed', listener);
    return () => ipcRenderer.off('window-bounds-changed', listener);
  },
  onCloseConfirmation: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('request-close-confirmation', listener);
    return () => ipcRenderer.off('request-close-confirmation', listener);
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

function createMediaEngineAudioApi() {
  return {
    isPlatformSupported: () => ipcRenderer.invoke('media-engine-audio-is-platform-supported'),
    checkPermission: () => ipcRenderer.invoke('media-engine-audio-check-permission'),
    getProcessList: () => ipcRenderer.invoke('media-engine-audio-get-process-list')
  };
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}
