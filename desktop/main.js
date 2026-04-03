const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, shell, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MediaAgentManager } = require('./media-agent-manager');

const SERVER_URL = normalizeBaseUrl(process.env.SERVER_URL || 'https://boshan.s.3q.hair');
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 30000);
const PREFERRED_AUDIO_BACKEND = String(process.env.VDS_PREFERRED_AUDIO_BACKEND || '').trim().toLowerCase();
const ENABLE_NATIVE_HOST_SESSION_BRIDGE = true;
const VERBOSE_MEDIA_LOGS = process.env.VDS_VERBOSE_MEDIA_LOGS === '1';
const ENABLE_AGENT_HOST_CAPTURE_PROCESS = process.env.VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS === '1';
const ENABLE_NATIVE_HOST_PREVIEW_SURFACE = true;
const ENABLE_NATIVE_PEER_TRANSPORT = true;
const ENABLE_NATIVE_SURFACE_EMBEDDING = process.env.VDS_ENABLE_NATIVE_SURFACE_EMBEDDING !== '0';
const DEBUG_CATEGORIES = ['connection', 'video', 'audio', 'update', 'misc'];

let mainWindow = null;
let tray = null;
let updateLogFilePath = null;
const updateLogSessionStamp = createUpdateLogSessionStamp();
const updateLogEntries = [];
const UPDATE_LOG_ENTRY_LIMIT = 200;
let win32WindowCaptureApi = undefined;
let mediaAgentManager = null;
let autoUpdater = null;
let autoUpdaterConfigured = false;
let rendererDebugConfig = buildDefaultRendererDebugConfig(false);
let quitInProgress = false;
let quitFinalizeTimer = null;
let audioCapture = undefined;
let audioCaptureLoadError = null;
let audioBridgeAttached = false;

configureProfilePaths();

function buildDefaultRendererDebugConfig(enabled = false) {
  return DEBUG_CATEGORIES.reduce((config, key) => {
    config[key] = Boolean(enabled);
    return config;
  }, {});
}

function normalizeRendererDebugConfig(config, fallbackEnabled = false) {
  if (typeof config === 'boolean') {
    return buildDefaultRendererDebugConfig(config);
  }

  const normalized = buildDefaultRendererDebugConfig(fallbackEnabled);
  if (!config || typeof config !== 'object') {
    return normalized;
  }

  for (const key of DEBUG_CATEGORIES) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      normalized[key] = Boolean(config[key]);
    }
  }

  return normalized;
}

function isRendererDebugEnabled(category = 'misc') {
  return VERBOSE_MEDIA_LOGS || Boolean(rendererDebugConfig[category]);
}

function getMediaEngineDebugCategory(method) {
  switch (method) {
    case 'createPeer':
    case 'closePeer':
    case 'setRemoteDescription':
    case 'addRemoteIceCandidate':
      return 'connection';
    case 'startHostSession':
    case 'stopHostSession':
    case 'attachPeerMediaSource':
    case 'detachPeerMediaSource':
    case 'attachSurface':
    case 'updateSurface':
    case 'detachSurface':
    case 'listCaptureTargets':
      return 'video';
    case 'getAudioBackendStatus':
    case 'startAudioSession':
    case 'stopAudioSession':
    case 'setViewerVolume':
    case 'getViewerVolume':
      return 'audio';
    case 'getStatus':
    case 'getCapabilities':
    case 'getStats':
    case 'start':
    case 'stop':
    default:
      return 'misc';
  }
}

app.commandLine.appendSwitch(
  'enable-features',
  'MediaFoundationVideoEncoder,WebRTC-H264WithH264EncoderImpl,WebRTC-AV1-Encoder'
);
app.commandLine.appendSwitch('enable-blink-features', 'WebRTC-AV1');
app.commandLine.appendSwitch('disable-features', 'UseSoftwareVP9Encoder');

if (process.env.HW_ACCEL === 'false') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

ipcMain.handle('get-runtime-config', () => ({
  serverUrl: SERVER_URL,
  disconnectGraceMs: DISCONNECT_GRACE_MS,
  preferredAudioBackend: PREFERRED_AUDIO_BACKEND,
  enableNativeHostSessionBridge: ENABLE_NATIVE_HOST_SESSION_BRIDGE,
  verboseMediaLogs: VERBOSE_MEDIA_LOGS,
  enableAgentHostCaptureProcess: ENABLE_AGENT_HOST_CAPTURE_PROCESS,
  enableNativeHostPreviewSurface: ENABLE_NATIVE_HOST_PREVIEW_SURFACE,
  enableNativePeerTransport: ENABLE_NATIVE_PEER_TRANSPORT,
  enableNativeSurfaceEmbedding: ENABLE_NATIVE_SURFACE_EMBEDDING
}));

ipcMain.handle('get-desktop-sources', async () => {
  try {
    return await listDesktopSources();
  } catch (error) {
    console.error('Error getting desktop sources:', error);
    return [];
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-update-log-snapshot', () => ({
  path: getUpdateLogFilePath(),
  entries: updateLogEntries.slice()
}));
ipcMain.handle('media-engine-get-status', async () => getMediaAgentManager().getStatus());
ipcMain.handle('media-engine-start', async () => getMediaAgentManager().start());
ipcMain.handle('media-engine-stop', async () => getMediaAgentManager().stop());
ipcMain.handle('media-engine-list-capture-targets', async () => {
  try {
    return await listCaptureTargets();
  } catch (error) {
    console.error('[media-agent] listCaptureTargets failed:', error);
    return [];
  }
});
ipcMain.handle('media-engine-audio-is-platform-supported', () => invokeAudioCaptureOperation('isPlatformSupported'));
ipcMain.handle('media-engine-audio-check-permission', () => invokeAudioCaptureOperation('checkPermission'));
ipcMain.handle('media-engine-audio-request-permission', () => invokeAudioCaptureOperation('requestPermission'));
ipcMain.handle('media-engine-audio-get-process-list', () => invokeAudioCaptureOperation('getProcessList'));
ipcMain.handle('media-engine-audio-get-backend-status', () => getMediaEngineAudioBridgeStatus());
ipcMain.handle('media-engine-audio-start-capture', (_event, pid) => invokeAudioCaptureOperation('startCapture', pid));
ipcMain.handle('media-engine-audio-stop-capture', () => invokeAudioCaptureOperation('stopCapture'));
ipcMain.handle('media-engine-audio-is-capturing', () => {
  try {
    const capture = getAudioCapture();
    return Boolean(audioCapture && audioCapture.isCapturing);
  } catch (error) {
    console.error('[media-engine] Failed to read audio capture state:', error);
    return false;
  }
});
ipcMain.handle('media-engine-start-host-session', async (_event, options) => invokeMediaEngineHostSessionBridge('startHostSession', options || {}));
ipcMain.handle('media-engine-stop-host-session', async (_event, options) => invokeMediaEngineHostSessionBridge('stopHostSession', options || {}));
ipcMain.handle('media-engine-get-audio-backend-status', async () => invokeMediaEngine('getAudioBackendStatus'));
ipcMain.handle('media-engine-start-audio-session', async (_event, options) => invokeMediaEngine('startAudioSession', options || {}));
ipcMain.handle('media-engine-stop-audio-session', async (_event, options) => invokeMediaEngine('stopAudioSession', options || {}));
ipcMain.handle('media-engine-create-peer', async (_event, options) => invokeMediaEngine('createPeer', options || {}));
ipcMain.handle('media-engine-close-peer', async (_event, options) => invokeMediaEngine('closePeer', options || {}));
ipcMain.handle('media-engine-set-remote-description', async (_event, options) => invokeMediaEngine('setRemoteDescription', options || {}));
ipcMain.handle('media-engine-add-remote-ice-candidate', async (_event, options) => invokeMediaEngine('addRemoteIceCandidate', options || {}));
ipcMain.handle('media-engine-attach-peer-media-source', async (_event, options) => invokeMediaEngine('attachPeerMediaSource', options || {}));
ipcMain.handle('media-engine-detach-peer-media-source', async (_event, options) => invokeMediaEngine('detachPeerMediaSource', options || {}));
ipcMain.handle('media-engine-attach-surface', async (_event, options) => invokeMediaEngine('attachSurface', enrichEmbeddedSurfaceOptions(options || {})));
ipcMain.handle('media-engine-update-surface', async (_event, options) => invokeMediaEngine('updateSurface', enrichEmbeddedSurfaceOptions(options || {})));
ipcMain.handle('media-engine-detach-surface', async (_event, options) => invokeMediaEngine('detachSurface', options || {}));
ipcMain.handle('media-engine-set-viewer-volume', async (_event, volume) => invokeMediaEngine('setViewerVolume', {
  pid: getRendererProcessId(),
  volume
}));
ipcMain.handle('media-engine-get-viewer-volume', async () => {
  try {
    return await invokeMediaEngine('getViewerVolume', {
      pid: getRendererProcessId()
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (message.includes('No active render audio session was found')) {
      return {
        volume: 1
      };
    }
    throw error;
  }
});
ipcMain.handle('media-engine-get-capabilities', async () => invokeMediaEngine('getCapabilities'));
ipcMain.handle('media-engine-get-stats', async (_event, options) => invokeMediaEngine('getStats', options || {}));
ipcMain.handle('window-is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()));
ipcMain.handle('window-get-bounds', () => {
  if (!mainWindow) {
    return null;
  }
  return mainWindow.getBounds();
});
ipcMain.handle('window-set-fullscreen', (_event, enabled) => {
  return applyWindowFullscreenState(enabled);
});
ipcMain.handle('window-is-fullscreen', () => Boolean(mainWindow && mainWindow.isFullScreen()));

ipcMain.on('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.on('window-minimize-to-tray', () => {
  if (!mainWindow) {
    return;
  }

  mainWindow.hide();
  if (!tray) {
    createTray();
  }
});

ipcMain.on('window-maximize', () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  requestAppQuit();
});

ipcMain.on('renderer-debug-config-changed', (_event, config) => {
  rendererDebugConfig = normalizeRendererDebugConfig(config, false);
});

ipcMain.on('renderer-debug-mode-changed', (_event, enabled) => {
  rendererDebugConfig = buildDefaultRendererDebugConfig(Boolean(enabled));
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    writeUpdateLog('info', 'Skip update check in dev mode because app.isPackaged is false.');
    return { devMode: true };
  }

  try {
    const updater = getAutoUpdater();
    writeUpdateLog('info', `Starting update check. version=${app.getVersion()} feed=${getUpdateFeedBaseUrl()}`);
    updater.setFeedURL({
      provider: 'generic',
      url: getUpdateFeedBaseUrl(),
      useMultipleRangeRequest: false
    });
    writeUpdateLog('info', `Feed URL configured: ${getUpdateManifestUrl()} (multi-range disabled)`);
    return await updater.checkForUpdates();
  } catch (error) {
    writeUpdateLog('error', `Update check failed before completion: ${formatLogMessage(error)}`);
    console.error('Update check error:', error);
    throw error;
  }
});

ipcMain.handle('download-update', async () => {
  if (!app.isPackaged) {
    writeUpdateLog('info', 'Skip update download in dev mode because app.isPackaged is false.');
    return false;
  }

  try {
    const updater = getAutoUpdater();
    writeUpdateLog('info', 'Starting update download from renderer request.');
    await updater.downloadUpdate();
    return true;
  } catch (error) {
    writeUpdateLog('error', `Update download failed before completion: ${formatLogMessage(error)}`);
    console.error('Update download error:', error);
    return false;
  }
});

ipcMain.handle('quit-and-install', () => {
  if (app.isPackaged) {
    const updater = getAutoUpdater();
    writeUpdateLog('info', 'quitAndInstall requested by renderer.');
    updater.quitAndInstall();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'VDS',
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'app.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (targetUrl !== currentUrl) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    sendToRenderer('media-engine-status', getMediaAgentManager().getStatus());
  });

  mainWindow.loadFile(path.resolve(__dirname, '../server/public', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
    }
  });

  mainWindow.on('maximize', () => {
    sendToRenderer('window-maximized-changed', true);
    sendToRenderer('window-bounds-changed', mainWindow.getBounds());
  });

  mainWindow.on('unmaximize', () => {
    sendToRenderer('window-maximized-changed', false);
    sendToRenderer('window-bounds-changed', mainWindow.getBounds());
  });

  mainWindow.on('enter-full-screen', () => {
    syncWindowFullscreenZOrder(true);
    sendToRenderer('window-fullscreen-changed', true);
    sendToRenderer('window-bounds-changed', mainWindow.getBounds());
  });

  mainWindow.on('leave-full-screen', () => {
    syncWindowFullscreenZOrder(false);
    sendToRenderer('window-fullscreen-changed', false);
    sendToRenderer('window-bounds-changed', mainWindow.getBounds());
  });

  mainWindow.on('move', () => {
    sendToRenderer('window-bounds-changed', mainWindow.getBounds());
  });

  mainWindow.on('resize', () => {
    sendToRenderer('window-bounds-changed', mainWindow.getBounds());
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function syncWindowFullscreenZOrder(enabled) {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') {
    return;
  }

  if (enabled) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    if (typeof mainWindow.moveTop === 'function') {
      mainWindow.moveTop();
    }
    mainWindow.focus();
    return;
  }

  mainWindow.setAlwaysOnTop(false);
}

function applyWindowFullscreenState(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const shouldEnable = Boolean(enabled);
  if (shouldEnable) {
    syncWindowFullscreenZOrder(true);
  }

  mainWindow.setFullScreen(shouldEnable);

  if (!shouldEnable) {
    syncWindowFullscreenZOrder(false);
  }

  return mainWindow.isFullScreen();
}

function getRendererProcessId() {
  if (!mainWindow || !mainWindow.webContents) {
    throw new Error('main-window-unavailable');
  }

  return Number(mainWindow.webContents.getOSProcessId() || 0);
}

function createTray() {
  const iconPath = path.join(__dirname, 'app.ico');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('VDS');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    {
      label: '退出',
      click: () => {
        requestAppQuit();
      }
    }
  ]));

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function finalizeQuit() {
  if (quitFinalizeTimer) {
    clearTimeout(quitFinalizeTimer);
    quitFinalizeTimer = null;
  }

  app.isQuitting = true;

  if (tray) {
    try {
      tray.destroy();
    } catch (_error) {
      // ignore tray destroy errors during quit
    }
    tray = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }

  app.quit();
}

function requestAppQuit() {
  if (quitInProgress) {
    return;
  }
  quitInProgress = true;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  quitFinalizeTimer = setTimeout(() => {
    app.isQuitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    app.exit(0);
  }, 5000);

  Promise.resolve()
    .then(async () => {
      if (mediaAgentManager) {
        await mediaAgentManager.stop();
      }
    })
    .catch((error) => {
      console.error('[media-agent] Failed to stop during quit:', error);
    })
    .finally(() => {
      finalizeQuit();
    });
}

function shouldLogMediaDebug(category = 'misc') {
  // Terminal/media-engine diagnostics should only be enabled explicitly via
  // environment variable, not by renderer-persisted debug menu state.
  return VERBOSE_MEDIA_LOGS;
}

function shouldLogMediaInvoke(method, category = 'misc') {
  return shouldLogMediaDebug(category);
}

function enrichEmbeddedSurfaceOptions(options) {
  const normalized = { ...(options || {}) };
  if (shouldLogMediaDebug('video')) {
    console.log('[media-engine surface] enrich input:', JSON.stringify(summarizeMediaEnginePayload(normalized)));
  }
  if (!normalized.embedded) {
    if (shouldLogMediaDebug('video')) {
      console.log('[media-engine surface] non-embedded surface request');
    }
    return normalized;
  }

  const parentWindowHandle = getMainWindowHandleValue();
  if (!parentWindowHandle) {
    throw new Error('main-window-handle-unavailable');
  }
  normalized.parentWindowHandle = parentWindowHandle;
  if (shouldLogMediaDebug('video')) {
    console.log('[media-engine surface] enrich output:', JSON.stringify(summarizeMediaEnginePayload(normalized)));
  }
  return normalized;
}

function getMainWindowHandleValue() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const handleBuffer = mainWindow.getNativeWindowHandle();
  if (!handleBuffer || !handleBuffer.length) {
    return null;
  }

  let handleValue = 0n;
  for (let index = handleBuffer.length - 1; index >= 0; index -= 1) {
    handleValue = (handleValue << 8n) + BigInt(handleBuffer[index]);
  }
  if (handleValue === 0n) {
    return null;
  }

  return `0x${handleValue.toString(16)}`;
}

function attachMediaEngineAudioBridge() {
  const capture = getAudioCapture();
  if (!capture || typeof capture.on !== 'function' || audioBridgeAttached) {
    return;
  }

  capture.on('audio-data', (audioData) => {
    sendToRenderer('media-engine-audio-data', audioData);
  });

  capture.on('capturing', (capturing) => {
    sendToRenderer('media-engine-audio-capturing', Boolean(capturing));
  });
  audioBridgeAttached = true;
}

function getAudioCapture() {
  if (audioCapture !== undefined) {
    return audioCapture;
  }

  try {
    const loaded = require('process-audio-capture/dist');
    audioCapture = loaded && loaded.audioCapture ? loaded.audioCapture : null;
    audioCaptureLoadError = null;
    if (audioCapture) {
      attachMediaEngineAudioBridge();
      if (shouldLogMediaDebug('audio')) {
        console.log('Media engine audio bridge ready');
      }
    }
  } catch (error) {
    audioCapture = null;
    audioCaptureLoadError = error;
    console.error('Failed to setup media engine audio bridge:', error);
  }

  return audioCapture;
}

function invokeAudioCaptureOperation(method, ...args) {
  const capture = getAudioCapture();
  if (!capture || typeof capture[method] !== 'function') {
    throw new Error(`audio-capture-method-unavailable:${method}`);
  }

  try {
    return capture[method](...args);
  } catch (error) {
    console.error(`[media-engine] audio ${method} failed:`, error);
    throw error;
  }
}

async function listDesktopSources() {
  const rawSources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });

  return sortDesktopSources(rawSources.map(normalizeDesktopSource));
}

async function listCaptureTargets() {
  const sources = await listDesktopSources();
  const audioDiscovery = inspectAudioDiscovery();
  const windowMetadata = getTopLevelWindowMetadataMap();

  return sources.map((source) => buildCaptureTarget(source, audioDiscovery, windowMetadata));
}

function inspectAudioDiscovery() {
  const snapshot = {
    supported: false,
    permissionStatus: 'unsupported',
    permission: null,
    processes: [],
    error: null
  };

  try {
    const capture = getAudioCapture();
    snapshot.supported = Boolean(capture && capture.isPlatformSupported && capture.isPlatformSupported());
    if (!snapshot.supported) {
      if (audioCaptureLoadError) {
        snapshot.error = audioCaptureLoadError.message;
      }
      return snapshot;
    }

    snapshot.permission = capture.checkPermission ? capture.checkPermission() : { status: 'unknown' };
    snapshot.permissionStatus = String(snapshot.permission && snapshot.permission.status ? snapshot.permission.status : 'unknown');

    if (snapshot.permissionStatus === 'authorized' && capture.getProcessList) {
      const processes = capture.getProcessList();
      snapshot.processes = Array.isArray(processes) ? processes : [];
    }
  } catch (error) {
    snapshot.permissionStatus = 'error';
    snapshot.error = error.message;
  }

  return snapshot;
}

function getMediaEngineAudioBridgeStatus() {
  const discovery = inspectAudioDiscovery();
  return {
    implementation: 'main-process-process-audio-capture',
    backendMode: 'renderer-web-audio-bridge',
    supported: discovery.supported,
    permissionStatus: discovery.permissionStatus,
    isCapturing: Boolean(getAudioCapture() && getAudioCapture().isCapturing),
    processCount: Array.isArray(discovery.processes) ? discovery.processes.length : 0,
    error: discovery.error || null
  };
}

function buildCaptureTarget(source, audioDiscovery, windowMetadata) {
  const sourceHandle = getDesktopWindowHandleFromSourceId(source.id);
  const windowInfo = sourceHandle ? windowMetadata.get(String(sourceHandle)) : null;
  const pid = normalizePid(windowInfo && windowInfo.pid);
  const title = (windowInfo && windowInfo.title) || source.name;
  const audioCandidates = buildAudioCandidatesForSource(title, pid, audioDiscovery);

  return {
    id: source.id,
    sourceId: source.id,
    title,
    appName: deriveAppName(source, title),
    kind: source.kind === 'screen' ? 'display' : 'window',
    state: getCaptureTargetState(source),
    captureMode: source.captureMode,
    displayId: source.displayId || null,
    pid,
    hwnd: sourceHandle || null,
    thumbnail: source.thumbnail || null,
    icon: source.appIcon || null,
    isSynthetic: false,
    audioSupported: audioDiscovery.supported,
    audioPermissionStatus: audioDiscovery.permissionStatus,
    audioCandidates,
    defaultAudioMode: audioCandidates.length > 0 ? 'process' : 'none',
    defaultAudioTargetId: audioCandidates.length > 0 ? audioCandidates[0].id : null,
    warnings: buildCaptureTargetWarnings(source, pid, audioCandidates, audioDiscovery),
    discoveryProvider: 'electron'
  };
}

function buildAudioCandidatesForSource(title, pid, audioDiscovery) {
  if (!audioDiscovery.supported || audioDiscovery.permissionStatus !== 'authorized') {
    return [];
  }

  const processes = Array.isArray(audioDiscovery.processes) ? audioDiscovery.processes : [];
  if (!processes.length) {
    return [];
  }

  const exactMatches = pid
    ? processes.filter((processInfo) => normalizePid(processInfo.pid) === pid)
    : [];
  if (exactMatches.length > 0) {
    return exactMatches.map((processInfo) => buildAudioCandidate(processInfo, 1, 'window-pid-match'));
  }

  const normalizedTitle = normalizeProcessMatchValue(title);
  if (!normalizedTitle) {
    return [];
  }

  const fuzzyMatches = [];
  for (const processInfo of processes) {
    const processToken = normalizeProcessMatchValue(processInfo.name);
    if (!processToken) {
      continue;
    }

    if (normalizedTitle.includes(processToken) || processToken.includes(normalizedTitle)) {
      fuzzyMatches.push(buildAudioCandidate(processInfo, 0.35, 'window-title-match'));
    }

    if (fuzzyMatches.length >= 3) {
      break;
    }
  }

  return fuzzyMatches;
}

function buildAudioCandidate(processInfo, confidence, reason) {
  const pid = normalizePid(processInfo && processInfo.pid);
  const processName = String(processInfo && processInfo.name ? processInfo.name : `PID ${pid || 'unknown'}`);

  return {
    id: pid ? `process:${pid}` : `process:${processName}`,
    mode: 'process',
    pid,
    processName,
    confidence,
    reason
  };
}

function buildCaptureTargetWarnings(source, pid, audioCandidates, audioDiscovery) {
  const warnings = [];

  if (!audioDiscovery.supported) {
    return warnings;
  }

  if (pid && audioDiscovery.permissionStatus !== 'authorized') {
    warnings.push('Process audio capture is available but permission has not been granted yet.');
    return warnings;
  }

  if (pid && audioDiscovery.permissionStatus === 'authorized' && audioCandidates.length === 0) {
    warnings.push('No active audio session could be matched to this capture target.');
  }

  if (audioDiscovery.error) {
    warnings.push(`Audio discovery warning: ${audioDiscovery.error}`);
  }

  return warnings;
}

function deriveAppName(source, title) {
  if (source.kind === 'screen') {
    return 'Display';
  }

  const comparableTitle = normalizeComparableWindowTitle(title || source.name || '');
  if (!comparableTitle) {
    return 'Window';
  }

  const dashIndex = comparableTitle.lastIndexOf(' - ');
  if (dashIndex > 0) {
    return comparableTitle.slice(dashIndex + 3).trim();
  }

  return comparableTitle;
}

function getCaptureTargetState(source) {
  if (source.kind === 'screen') {
    return 'display';
  }

  return 'normal';
}

function normalizePid(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function normalizeProcessMatchValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

function getTopLevelWindowMetadataMap() {
  const api = getWin32WindowCaptureApi();
  const metadata = new Map();
  if (!api || !api.EnumWindows) {
    return metadata;
  }

  try {
    api.EnumWindows((hwnd) => {
      if (!hwnd) {
        return true;
      }

      if (api.GetWindow && api.GW_OWNER && api.GetWindow(hwnd, api.GW_OWNER)) {
        return true;
      }

      const handleValue = getWindowHandleValue(api, hwnd);
      if (!handleValue) {
        return true;
      }

      const title = getWindowTitle(api, hwnd);
      if (!title) {
        return true;
      }

      metadata.set(String(handleValue), {
        hwnd: String(handleValue),
        pid: getWindowProcessId(api, hwnd),
        title,
        isVisible: api.IsWindowVisible ? Boolean(api.IsWindowVisible(hwnd)) : true,
        isMinimized: api.IsIconic ? Boolean(api.IsIconic(hwnd)) : false
      });

      return true;
    }, 0);
  } catch (error) {
    console.warn('Unable to build top-level window metadata map:', error);
  }

  return metadata;
}

function getMediaAgentManager() {
  if (!mediaAgentManager) {
    mediaAgentManager = new MediaAgentManager({ logger: console });
    mediaAgentManager.on('status', (status) => {
      sendToRenderer('media-engine-status', status);
    });
    mediaAgentManager.on('event', (event) => {
      if (event && event.event === 'audio-data') {
        sendToRenderer('media-engine-native-audio-data', event.params || null);
        return;
      }

      sendToRenderer('media-engine-event', event);
    });
  }

  return mediaAgentManager;
}

async function invokeMediaEngine(method, params) {
  const debugCategory = getMediaEngineDebugCategory(method);
  if (shouldLogMediaInvoke(method, debugCategory)) {
    console.log(`[media-agent invoke] ${method} request:`, JSON.stringify(summarizeMediaEnginePayload(params)));
  }
  try {
    const result = await getMediaAgentManager().invoke(method, params);
    if (shouldLogMediaInvoke(method, debugCategory)) {
      console.log(`[media-agent invoke] ${method} result:`, JSON.stringify(summarizeMediaEnginePayload(result)));
    }
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (method === 'getViewerVolume' && message.includes('No active render audio session was found')) {
      throw error;
    }
    console.error(`[media-agent] ${method} failed:`, error);
    throw error;
  }
}

async function invokeMediaEngineHostSessionBridge(method, params) {
  if (!ENABLE_NATIVE_HOST_SESSION_BRIDGE) {
    return {
      running: false,
      implementation: 'disabled'
    };
  }

  try {
    return await invokeMediaEngine(method, params);
  } catch (error) {
    console.error(`[media-agent bridge] ${method} failed:`, error);
    throw error;
  }
}

function summarizeMediaEnginePayload(value, depth = 0) {
  if (value == null) {
    return value;
  }

  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (
      Object.prototype.hasOwnProperty.call(value, 'embeddedParentDebug') ||
      Object.prototype.hasOwnProperty.call(value, 'surfaceWindowDebug')
    )
  ) {
    return {
      attached: value.attached,
      running: value.running,
      decoderReady: value.decoderReady,
      decodedFramesRendered: value.decodedFramesRendered,
      processId: value.processId,
      implementation: value.implementation,
      layout: summarizeMediaEnginePayload(value.layout, depth + 1),
      windowTitle: value.windowTitle,
      reason: value.reason,
      lastError: summarizeMediaEnginePayload(value.lastError, depth + 1),
      embeddedParentDebug: summarizeMediaEnginePayload(value.embeddedParentDebug, depth + 1),
      surfaceWindowDebug: summarizeMediaEnginePayload(value.surfaceWindowDebug, depth + 1)
    };
  }

  if (depth >= 2) {
    if (Array.isArray(value)) {
      return `[array:${value.length}]`;
    }
    if (typeof value === 'object') {
      return '[object]';
    }
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}...<${value.length}>` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => summarizeMediaEnginePayload(entry, depth + 1));
  }

  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = summarizeMediaEnginePayload(entry, depth + 1);
    }
    return output;
  }

  return value;
}

function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require('electron-updater'));
  }

  configureAutoUpdater();
  return autoUpdater;
}

function configureAutoUpdater() {
  if (!autoUpdater || autoUpdaterConfigured) {
    return;
  }

  autoUpdater.logger = {
    info: (message) => writeUpdateLog('info', message),
    warn: (message) => writeUpdateLog('warn', message),
    error: (message) => writeUpdateLog('error', message)
  };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    writeUpdateLog('info', `checking-for-update: currentVersion=${app.getVersion()} manifest=${getUpdateManifestUrl()}`);
    sendToRenderer('update-status', {
      status: 'checking',
      currentVersion: app.getVersion(),
      feedUrl: getUpdateManifestUrl()
    });
  });

  autoUpdater.on('update-available', (info) => {
    writeUpdateLog('info', `update-available: currentVersion=${app.getVersion()} nextVersion=${info.version} files=${formatUpdateFiles(info.files)}`);
    sendToRenderer('update-status', {
      status: 'available',
      version: info.version,
      currentVersion: app.getVersion(),
      feedUrl: getUpdateManifestUrl(),
      releaseDate: info.releaseDate || null
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    writeUpdateLog('info', `update-not-available: currentVersion=${app.getVersion()} latestVersion=${(info && info.version) || app.getVersion()}`);
    sendToRenderer('update-status', {
      status: 'not-available',
      version: (info && info.version) || app.getVersion(),
      currentVersion: app.getVersion(),
      feedUrl: getUpdateManifestUrl()
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    writeUpdateLog(
      'info',
      `download-progress: percent=${safeNumber(progress.percent).toFixed(2)} transferred=${safeNumber(progress.transferred)} total=${safeNumber(progress.total)} bytesPerSecond=${safeNumber(progress.bytesPerSecond)}`
    );
    sendToRenderer('update-status', {
      status: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred,
      remaining: progress.remaining,
      currentVersion: app.getVersion(),
      feedUrl: getUpdateManifestUrl()
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    writeUpdateLog('info', `update-downloaded: version=${info.version} releaseDate=${info.releaseDate || 'n/a'}`);
    cacheDownloadedInstallerForDifferentialUpdate(info.downloadedFile);
    sendToRenderer('update-status', {
      status: 'downloaded',
      version: info.version,
      currentVersion: app.getVersion(),
      feedUrl: getUpdateManifestUrl()
    });
  });

  autoUpdater.on('error', (error) => {
    writeUpdateLog('error', `autoUpdater error event: ${formatLogMessage(error)}`);
    sendToRenderer('update-status', {
      status: 'error',
      error: error.message,
      currentVersion: app.getVersion(),
      feedUrl: getUpdateManifestUrl()
    });
  });

  autoUpdaterConfigured = true;
}

function getUpdateFeedBaseUrl() {
  return `${SERVER_URL}/updates/`;
}

function getUpdateManifestUrl() {
  return `${getUpdateFeedBaseUrl()}latest.yml`;
}

function getAutoUpdaterCacheDir() {
  if (!autoUpdater || !autoUpdater.downloadedUpdateHelper || !autoUpdater.downloadedUpdateHelper.cacheDir) {
    return '';
  }
  return String(autoUpdater.downloadedUpdateHelper.cacheDir || '');
}

function cacheDownloadedInstallerForDifferentialUpdate(downloadedFile) {
  const cacheDir = getAutoUpdaterCacheDir();
  const sourcePath = String(downloadedFile || '').trim();
  if (!cacheDir || !sourcePath) {
    writeUpdateLog('warn', 'Differential update cache seed skipped: updater cache dir or downloaded file is missing.');
    return;
  }

  if (!fs.existsSync(sourcePath)) {
    writeUpdateLog('warn', `Differential update cache seed skipped: downloaded installer not found at ${sourcePath}`);
    return;
  }

  const targetPath = path.join(cacheDir, 'installer.exe');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    writeUpdateLog('info', `Seeded differential update installer cache: ${targetPath}`);
  } catch (error) {
    writeUpdateLog('warn', `Failed to seed differential update installer cache: ${formatLogMessage(error)}`);
  }
}

function normalizeDesktopSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: String(source.id || '').startsWith('screen:') ? 'screen' : 'window',
    displayId: getDesktopSourceDisplayId(source),
    isSynthetic: false,
    captureMode: String(source.id || '').startsWith('screen:') ? 'display' : 'window',
    appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
    thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null
  };
}

function sortDesktopSources(sources) {
  return sources
    .filter(Boolean)
    .sort((left, right) => {
      const leftScore = getDesktopSourceSortScore(left);
      const rightScore = getDesktopSourceSortScore(right);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }

      return String(left.name || '').localeCompare(String(right.name || ''));
    });
}

function getDesktopSourceSortScore(source) {
  if (source.kind === 'window') {
    return 1;
  }

  return 3;
}

function getDesktopSourceDisplayId(source) {
  if (source && source.display_id != null) {
    return String(source.display_id);
  }

  const match = String(source && source.id ? source.id : '').match(/^screen:([^:]+):/);
  return match ? String(match[1]) : null;
}





function normalizeComparableWindowTitle(title) {
  return String(title || '').trim().toLowerCase();
}





function getWindowTitle(api, hwnd) {
  try {
    const wcharCount = 1024;
    const buffer = Buffer.alloc(wcharCount * 2);
    const length = api.GetWindowTextW(hwnd, buffer, wcharCount);
    if (!length) {
      return '';
    }

    return buffer.toString('utf16le', 0, length * 2).replace(/\0+$/, '').trim();
  } catch (_error) {
    return '';
  }
}

function getWindowProcessId(api, hwnd) {
  try {
    const pid = [0];
    const threadId = api.GetWindowThreadProcessId(hwnd, pid);
    if (!threadId || !pid[0]) {
      return 0;
    }

    return Number(pid[0]);
  } catch (_error) {
    return 0;
  }
}

function getWindowHandleValue(api, hwnd) {
  try {
    const value = api.koffi.address(hwnd);
    return value ? value.toString() : null;
  } catch (_error) {
    return null;
  }
}

function getDesktopWindowHandleFromSourceId(sourceId) {
  const match = String(sourceId || '').match(/^window:(\d+):/);
  return match ? match[1] : null;
}



function getWin32WindowCaptureApi() {
  if (process.platform !== 'win32') {
    return null;
  }

  if (win32WindowCaptureApi !== undefined) {
    return win32WindowCaptureApi;
  }

  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
    const HWND = koffi.alias('HWND', HANDLE);
    const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, long lParam)');
    const RECT = koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long'
    });
    const DWORD = koffi.alias('DWORD', 'uint32_t');

    win32WindowCaptureApi = {
      koffi,
      GW_OWNER: 4,
      GetForegroundWindow: user32.func('HWND __stdcall GetForegroundWindow(void)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(HWND hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)'),
      GetWindowThreadProcessId: user32.func('DWORD __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ DWORD *lpdwProcessId)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)'),
      GetWindow: user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)'),
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, long lParam)'),
      EnumChildWindows: user32.func('bool __stdcall EnumChildWindows(HWND hWndParent, EnumWindowsProc *lpEnumFunc, long lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hWnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(HWND hWnd)')
    };
  } catch (error) {
    console.warn('Win32 fullscreen source detection unavailable:', error);
    win32WindowCaptureApi = null;
  }

  return win32WindowCaptureApi;
}

function getUpdateLogFilePath() {
  if (!updateLogFilePath) {
    updateLogFilePath = path.join(app.getPath('userData'), `update-${updateLogSessionStamp}.log`);
  }

  return updateLogFilePath;
}

function createUpdateLogSessionStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

function writeUpdateLog(level, message) {
  const normalizedLevel = String(level || 'info').toUpperCase();
  const normalizedMessage = formatLogMessage(message);
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${normalizedLevel}] ${normalizedMessage}`;

  updateLogEntries.push({
    timestamp,
    level: normalizedLevel.toLowerCase(),
    message: normalizedMessage,
    line
  });

  if (updateLogEntries.length > UPDATE_LOG_ENTRY_LIMIT) {
    updateLogEntries.shift();
  }

  const consoleMethod = normalizedLevel === 'ERROR'
    ? 'error'
    : normalizedLevel === 'WARN'
      ? 'warn'
      : 'log';
  console[consoleMethod](line);

  try {
    fs.mkdirSync(path.dirname(getUpdateLogFilePath()), { recursive: true });
    fs.appendFileSync(getUpdateLogFilePath(), line + os.EOL, 'utf8');
  } catch (error) {
    console.error('[update-log] Failed to persist update log:', error);
  }

  sendToRenderer('update-log', {
    timestamp,
    level: normalizedLevel.toLowerCase(),
    message: normalizedMessage,
    line,
    path: getUpdateLogFilePath()
  });
}

function formatLogMessage(value) {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value == null) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function formatUpdateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return 'none';
  }

  return files
    .map((file) => `${file.url || 'unknown'} (${safeNumber(file.size)})`)
    .join(', ');
}

function safeNumber(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function configureProfilePaths() {
  const profileName = process.env.VDS_PROFILE || (!app.isPackaged ? `dev-${process.pid}` : '');
  if (!profileName) {
    return;
  }

  const profileRoot = path.join(os.tmpdir(), 'vds-profiles', profileName);
  app.setPath('userData', path.join(profileRoot, 'userData'));
  app.setPath('sessionData', path.join(profileRoot, 'sessionData'));
  console.log(`Using Electron profile: ${profileName}`);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

app.isQuitting = false;

app.whenReady().then(() => {
  getMediaAgentManager();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (quitFinalizeTimer) {
    clearTimeout(quitFinalizeTimer);
    quitFinalizeTimer = null;
  }
  if (mediaAgentManager) {
    mediaAgentManager.stop().catch((error) => {
      console.error('[media-agent] Failed to stop before quit:', error);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
