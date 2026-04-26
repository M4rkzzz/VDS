const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, shell, screen, clipboard } = require('electron');
const childProcess = require('child_process');
const dgram = require('dgram');
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
const ENABLE_CAPTURE_TARGET_NATIVE_METADATA = process.env.VDS_ENABLE_CAPTURE_TARGET_NATIVE_METADATA !== '0';
const ENABLE_CAPTURE_TARGET_WINDOW_ICONS = process.env.VDS_ENABLE_CAPTURE_TARGET_WINDOW_ICONS === '1';
const CAPTURE_TARGET_LIST_TIMEOUT_MS = Number(process.env.VDS_CAPTURE_TARGET_LIST_TIMEOUT_MS || 2500);
const DEBUG_PRESET = String(process.env.VDS_DEBUG_PRESET || '').trim();
const DEBUG_CATEGORIES = ['connection', 'p2p', 'video', 'audio', 'update', 'misc'];
const DEBUG_CHANNELS = ['renderer', 'nativeEvents', 'nativeSteps', 'periodicStats', 'mainProcess', 'agentBreadcrumbs', 'agentStderr'];

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
const mainDebugRateLimitState = new Map();
let quitInProgress = false;
let quitFinalizeTimer = null;
let audioCapture = undefined;
let audioCaptureLoadError = null;
let audioBridgeAttached = false;
const activeNatMappings = new Map();
let emulatedFullscreenState = {
  active: false,
  bounds: null,
  maximized: false
};

configureProfilePaths();
installProcessDiagnostics();

function buildDefaultRendererDebugConfig(enabled = false) {
  return {
    categories: DEBUG_CATEGORIES.reduce((config, key) => {
      config[key] = Boolean(enabled);
      return config;
    }, {}),
    channels: DEBUG_CHANNELS.reduce((config, key) => {
      config[key] = Boolean(enabled);
      return config;
    }, {})
  };
}

function normalizeRendererDebugConfig(config, fallbackEnabled = false) {
  if (typeof config === 'boolean') {
    return buildDefaultRendererDebugConfig(config);
  }

  const normalized = buildDefaultRendererDebugConfig(fallbackEnabled);
  if (!config || typeof config !== 'object') {
    return normalized;
  }

  const hasStructuredCategories = Boolean(config.categories && typeof config.categories === 'object');
  const hasStructuredChannels = Boolean(config.channels && typeof config.channels === 'object');

  if (!hasStructuredCategories && !hasStructuredChannels) {
    for (const key of DEBUG_CATEGORIES) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        normalized.categories[key] = Boolean(config[key]);
      }
    }

    const legacyEnabled = DEBUG_CATEGORIES.some((key) => normalized.categories[key]);
    normalized.channels.renderer = legacyEnabled;
    normalized.channels.nativeEvents = legacyEnabled;
    normalized.channels.mainProcess = legacyEnabled;
    return normalized;
  }

  for (const key of DEBUG_CATEGORIES) {
    if (hasStructuredCategories && Object.prototype.hasOwnProperty.call(config.categories, key)) {
      normalized.categories[key] = Boolean(config.categories[key]);
    }
  }

  for (const key of DEBUG_CHANNELS) {
    if (hasStructuredChannels && Object.prototype.hasOwnProperty.call(config.channels, key)) {
      normalized.channels[key] = Boolean(config.channels[key]);
    }
  }

  return normalized;
}

function isRendererDebugEnabled(category = 'misc', channel = 'renderer') {
  return VERBOSE_MEDIA_LOGS ||
    (Boolean(rendererDebugConfig.categories && rendererDebugConfig.categories[category]) &&
      Boolean(rendererDebugConfig.channels && rendererDebugConfig.channels[channel]));
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
    case 'prepareObsIngest':
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
    case 'setViewerPlaybackMode':
    case 'setViewerAudioDelay':
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
  enableNativeSurfaceEmbedding: ENABLE_NATIVE_SURFACE_EMBEDDING,
  debugPreset: DEBUG_PRESET
}));

ipcMain.handle('get-desktop-sources', async () => {
  try {
    return await listDesktopSources();
  } catch (error) {
    logMainProcessDebug('video', 'Error getting desktop sources:', error && error.message ? error.message : String(error));
    return [];
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('clipboard-write-text', (_event, text) => {
  const value = String(text || '');
  if (!value) {
    throw new Error('clipboard-text-empty');
  }
  clipboard.writeText(value);
  return { ok: true };
});
ipcMain.handle('get-update-log-snapshot', () => ({
  path: getUpdateLogFilePath(),
  entries: updateLogEntries.slice()
}));
ipcMain.handle('media-engine-get-status', async () => getMediaAgentManager().getStatus());
ipcMain.handle('media-engine-start', async () => getMediaAgentManager().start());
ipcMain.handle('media-engine-stop', async () => getMediaAgentManager().stop());
ipcMain.handle('media-engine-list-capture-targets', async () => {
  try {
    return await withTimeout(
      listCaptureTargets(),
      CAPTURE_TARGET_LIST_TIMEOUT_MS,
      'capture-target-list-timeout'
    );
  } catch (error) {
    logMainProcessDebug('video', '[media-agent] listCaptureTargets failed:', error && error.message ? error.message : String(error));
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
    logMainProcessDebug('audio', '[media-engine] Failed to read audio capture state:', error && error.message ? error.message : String(error));
    return false;
  }
});
ipcMain.handle('media-engine-start-host-session', async (_event, options) => invokeMediaEngineHostSessionBridge('startHostSession', options || {}));
ipcMain.handle('media-engine-stop-host-session', async (_event, options) => invokeMediaEngineHostSessionBridge('stopHostSession', options || {}));
ipcMain.handle('media-engine-prepare-obs-ingest', async (_event, options) => invokeMediaEngine('prepareObsIngest', options || {}));
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
ipcMain.handle('media-engine-set-viewer-playback-mode', async (_event, options) => invokeMediaEngine('setViewerPlaybackMode', options || {}));
ipcMain.handle('media-engine-set-viewer-audio-delay', async (_event, options) => invokeMediaEngine('setViewerAudioDelay', options || {}));
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
ipcMain.handle('p2p-open-nat-mapping', async (_event, options) => openP2PNatMappings(options || {}));
ipcMain.handle('window-is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()));
ipcMain.handle('window-get-bounds', () => {
  if (!mainWindow) {
    return null;
  }
  return getRendererWindowBounds();
});
ipcMain.handle('window-get-cursor-screen-point', () => {
  const point = screen.getCursorScreenPoint();
  return {
    x: Number(point && point.x) || 0,
    y: Number(point && point.y) || 0
  };
});
ipcMain.handle('window-set-fullscreen', (_event, enabled) => {
  return applyWindowFullscreenState(enabled);
});
ipcMain.handle('window-is-fullscreen', () => isWindowFullscreenActive());

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
    writeUpdateLog('info', 'quitAndInstall requested by renderer. mode=silent');
    updater.quitAndInstall(true, true);
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

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeUpdateLog('error', `[electron] renderer process gone: ${formatLogMessage(details)}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    writeUpdateLog('warn', '[electron] renderer process became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    writeUpdateLog('info', '[electron] renderer process became responsive');
  });

  mainWindow.loadFile(path.resolve(__dirname, '../server/public', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
    }
  });

  mainWindow.on('maximize', () => {
    sendToRenderer('window-maximized-changed', true);
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
  });

  mainWindow.on('unmaximize', () => {
    sendToRenderer('window-maximized-changed', false);
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
  });

  mainWindow.on('enter-full-screen', () => {
    syncWindowFullscreenZOrder(true);
    sendToRenderer('window-fullscreen-changed', true);
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
  });

  mainWindow.on('leave-full-screen', () => {
    syncWindowFullscreenZOrder(false);
    sendToRenderer('window-fullscreen-changed', false);
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
  });

  mainWindow.on('move', () => {
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
  });

  mainWindow.on('resize', () => {
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
  });

  mainWindow.on('focus', () => {
    syncWindowFullscreenZOrder(isWindowFullscreenActive());
  });

  mainWindow.on('blur', () => {
    syncWindowFullscreenZOrder(isWindowFullscreenActive());
  });

  mainWindow.on('minimize', () => {
    syncWindowFullscreenZOrder(false);
  });

  mainWindow.on('restore', () => {
    syncWindowFullscreenZOrder(isWindowFullscreenActive());
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function syncWindowFullscreenZOrder(enabled) {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') {
    return;
  }

  const shouldElevate = Boolean(enabled) && mainWindow.isFocused() && !mainWindow.isMinimized();
  logMainProcessDebug('video', '[fullscreen-zorder] sync:', {
    enabled: Boolean(enabled),
    focused: mainWindow.isFocused(),
    minimized: mainWindow.isMinimized(),
    elevate: shouldElevate
  });

  if (shouldElevate) {
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
    if (typeof mainWindow.moveTop === 'function') {
      mainWindow.moveTop();
    }
    mainWindow.focus();
    return;
  }

  mainWindow.setAlwaysOnTop(false);
}

function isWindowFullscreenActive() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (process.platform === 'win32') {
    return Boolean(emulatedFullscreenState.active);
  }

  return Boolean(mainWindow.isFullScreen());
}

function getRendererWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  if (typeof mainWindow.getContentBounds === 'function') {
    return mainWindow.getContentBounds();
  }

  return mainWindow.getBounds();
}

function applyWindowFullscreenState(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const shouldEnable = Boolean(enabled);
  if (process.platform === 'win32') {
    if (shouldEnable === emulatedFullscreenState.active) {
      syncWindowFullscreenZOrder(shouldEnable);
      return emulatedFullscreenState.active;
    }

    if (shouldEnable) {
      const display = screen.getDisplayMatching(mainWindow.getBounds());
      const displayBounds = display && display.bounds ? display.bounds : screen.getPrimaryDisplay().bounds;
      const targetBounds = {
        x: Math.round(displayBounds.x - 1),
        y: Math.round(displayBounds.y - 1),
        width: Math.round(displayBounds.width + 2),
        height: Math.round(displayBounds.height + 2)
      };
      const restoreBounds = mainWindow.isMaximized() && typeof mainWindow.getNormalBounds === 'function'
        ? mainWindow.getNormalBounds()
        : mainWindow.getBounds();

      emulatedFullscreenState = {
        active: true,
        bounds: restoreBounds,
        maximized: mainWindow.isMaximized()
      };

      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      }

      mainWindow.setBounds(targetBounds, false);
      syncWindowFullscreenZOrder(true);
      sendToRenderer('window-fullscreen-changed', true);
      sendToRenderer('window-bounds-changed', getRendererWindowBounds());
      return true;
    }

    const restoreState = emulatedFullscreenState;
    emulatedFullscreenState = {
      active: false,
      bounds: null,
      maximized: false
    };

    if (restoreState.bounds) {
      mainWindow.setBounds(restoreState.bounds, false);
    }
    if (restoreState.maximized) {
      mainWindow.maximize();
    }

    syncWindowFullscreenZOrder(false);
    sendToRenderer('window-fullscreen-changed', false);
    sendToRenderer('window-bounds-changed', getRendererWindowBounds());
    return false;
  }

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

function shouldLogMediaDebug(category = 'misc', channel = 'renderer') {
  return VERBOSE_MEDIA_LOGS || isRendererDebugEnabled(category, channel);
}

function shouldLogMediaInvoke(method, category = 'misc') {
  return shouldLogMediaDebug(category, 'mainProcess');
}

function shouldEmitMainDebugLog(key, intervalMs = 1000) {
  if (VERBOSE_MEDIA_LOGS || intervalMs <= 0) {
    return { emit: true, suppressed: 0 };
  }

  const now = Date.now();
  const state = mainDebugRateLimitState.get(key) || { lastAt: 0, suppressed: 0 };
  if (now - state.lastAt < intervalMs) {
    state.suppressed += 1;
    mainDebugRateLimitState.set(key, state);
    return { emit: false, suppressed: state.suppressed };
  }

  const suppressed = state.suppressed;
  mainDebugRateLimitState.set(key, { lastAt: now, suppressed: 0 });
  return { emit: true, suppressed };
}

function logMainProcessDebug(category, ...args) {
  if (!shouldLogMediaDebug(category, 'mainProcess')) {
    return;
  }
  console.log(...args);
}

function logMainProcessWarning(category, ...args) {
  if (!shouldLogMediaDebug(category, 'mainProcess')) {
    return;
  }
  console.warn(...args);
}

function enrichEmbeddedSurfaceOptions(options) {
  const normalized = { ...(options || {}) };
  if (shouldLogMediaDebug('video', 'mainProcess')) {
    logMainProcessDebug('video', '[media-engine surface] enrich input:', JSON.stringify(summarizeMediaEnginePayload(normalized)));
  }
  if (!normalized.embedded) {
    if (shouldLogMediaDebug('video', 'mainProcess')) {
      logMainProcessDebug('video', '[media-engine surface] non-embedded surface request');
    }
    return normalized;
  }

  const parentWindowHandle = getMainWindowHandleValue();
  if (!parentWindowHandle) {
    throw new Error('main-window-handle-unavailable');
  }
  normalized.parentWindowHandle = parentWindowHandle;
  if (shouldLogMediaDebug('video', 'mainProcess')) {
    logMainProcessDebug('video', '[media-engine surface] enrich output:', JSON.stringify(summarizeMediaEnginePayload(normalized)));
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
        logMainProcessDebug('audio', 'Media engine audio bridge ready');
      }
    }
  } catch (error) {
    audioCapture = null;
    audioCaptureLoadError = error;
    logMainProcessDebug('audio', 'Failed to setup media engine audio bridge:', error && error.message ? error.message : String(error));
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
    logMainProcessDebug('audio', `[media-engine] audio ${method} failed:`, error && error.message ? error.message : String(error));
    throw error;
  }
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  const normalizedTimeout = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeout) || normalizedTimeout <= 0) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage || 'operation-timeout')), normalizedTimeout);
    })
  ]);
}

function parseIceCandidateForMapping(candidate) {
  const raw = typeof candidate === 'string'
    ? candidate
    : String(candidate && candidate.candidate ? candidate.candidate : '');
  const parts = raw.trim().split(/\s+/);
  if (!raw || parts.length < 8) {
    return null;
  }

  const foundation = parts[0].replace(/^candidate:/, '') || 'vds';
  const component = Number(parts[1]) || 1;
  const protocol = String(parts[2] || '').toLowerCase();
  const priority = Number(parts[3]) || 1694498815;
  const address = String(parts[4] || '').trim();
  const port = Number(parts[5]);
  const typIndex = parts.findIndex((part) => String(part).toLowerCase() === 'typ');
  const type = typIndex >= 0 ? String(parts[typIndex + 1] || '').toLowerCase() : '';
  if (protocol !== 'udp' || type !== 'host' || !isValidIpv4(address) || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  return {
    foundation,
    component,
    priority,
    address,
    port,
    sdpMid: candidate && typeof candidate === 'object' ? String(candidate.sdpMid || '') : '',
    sdpMLineIndex: candidate && typeof candidate === 'object' && Number.isFinite(candidate.sdpMLineIndex)
      ? candidate.sdpMLineIndex
      : 0
  };
}

function isValidIpv4(address) {
  const parts = String(address || '').split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function ipv4ToBuffer(address) {
  return Buffer.from(String(address || '').split('.').map((part) => Number(part) & 0xff));
}

function bufferToIpv4(buffer, offset = 0) {
  if (!buffer || buffer.length < offset + 4) {
    return '';
  }
  return `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
}

function ipv6MappedIpv4FromBuffer(buffer, offset = 0) {
  if (!buffer || buffer.length < offset + 16) {
    return '';
  }
  const prefixZero = buffer.subarray(offset, offset + 10).every((value) => value === 0);
  const mapped = buffer[offset + 10] === 0xff && buffer[offset + 11] === 0xff;
  if (!prefixZero || !mapped) {
    return '';
  }
  return bufferToIpv4(buffer, offset + 12);
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, {
      windowsHide: true,
      timeout: options.timeout || 2500,
      maxBuffer: 64 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || stderr || '').trim());
    });
  });
}

async function resolveDefaultGatewayIpv4() {
  if (process.platform === 'win32') {
    try {
      const output = await execFilePromise('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1 -ExpandProperty NextHop)"
      ]);
      const gateway = output.split(/\r?\n/).map((line) => line.trim()).find(isValidIpv4);
      if (gateway) {
        return gateway;
      }
    } catch (error) {
      logMainProcessDebug('p2p', '[p2p-nat] Get-NetRoute failed:', error && error.message ? error.message : String(error));
    }
  }

  try {
    const command = process.platform === 'win32' ? 'route' : 'ip';
    const args = process.platform === 'win32' ? ['print', '-4', '0.0.0.0'] : ['route', 'show', 'default'];
    const output = await execFilePromise(command, args);
    const match = output.match(/(?:default\s+via|0\.0\.0\.0\s+0\.0\.0\.0)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (match && isValidIpv4(match[1])) {
      return match[1];
    }
  } catch (error) {
    logMainProcessDebug('p2p', '[p2p-nat] route lookup failed:', error && error.message ? error.message : String(error));
  }

  return '';
}

function udpRequest(address, port, payload, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.close();
      reject(new Error('udp-request-timeout'));
    }, timeoutMs);

    socket.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    });

    socket.once('message', (message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });

    socket.send(payload, port, address, (error) => {
      if (error && !settled) {
        settled = true;
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
  });
}

async function requestNatPmpExternalAddress(gateway) {
  const response = await udpRequest(gateway, 5351, Buffer.from([0, 0]), 1200);
  if (response.length < 12 || response[0] !== 0 || response[1] !== 128 || response.readUInt16BE(2) !== 0) {
    throw new Error('nat-pmp-public-address-failed');
  }
  return bufferToIpv4(response, 8);
}

async function requestNatPmpUdpMapping(gateway, internalPort, lifetimeSeconds) {
  const request = Buffer.alloc(12);
  request[0] = 0;
  request[1] = 1;
  request.writeUInt16BE(internalPort, 4);
  request.writeUInt16BE(internalPort, 6);
  request.writeUInt32BE(lifetimeSeconds, 8);
  const response = await udpRequest(gateway, 5351, request, 1200);
  if (response.length < 16 || response[0] !== 0 || response[1] !== 129 || response.readUInt16BE(2) !== 0) {
    throw new Error('nat-pmp-map-udp-failed');
  }
  return {
    protocol: 'nat-pmp',
    internalPort: response.readUInt16BE(8),
    externalPort: response.readUInt16BE(10),
    lifetimeSeconds: response.readUInt32BE(12)
  };
}

async function requestPcpUdpMapping(gateway, internalPort, lifetimeSeconds) {
  const nonce = Buffer.alloc(12);
  for (let index = 0; index < nonce.length; index += 1) {
    nonce[index] = Math.floor(Math.random() * 256);
  }
  const request = Buffer.alloc(60);
  request[0] = 2;
  request[1] = 1;
  request.writeUInt32BE(lifetimeSeconds, 4);
  nonce.copy(request, 24);
  request[36] = 17;
  request.writeUInt16BE(internalPort, 40);
  request.writeUInt16BE(internalPort, 42);
  const response = await udpRequest(gateway, 5351, request, 1500);
  if (response.length < 60 || response[0] !== 2 || response[1] !== 129 || response[3] !== 0) {
    throw new Error('pcp-map-udp-failed');
  }
  const externalAddress = ipv6MappedIpv4FromBuffer(response, 44);
  if (!externalAddress) {
    throw new Error('pcp-external-ipv4-unavailable');
  }
  return {
    protocol: 'pcp',
    internalPort: response.readUInt16BE(40),
    externalPort: response.readUInt16BE(42),
    externalAddress,
    lifetimeSeconds: response.readUInt32BE(4)
  };
}

function buildMappedIceCandidate(candidate, mapping, externalAddress) {
  const publicIp = mapping.externalAddress || externalAddress;
  if (!isValidIpv4(publicIp) || !mapping.externalPort) {
    return null;
  }
  const foundation = `${candidate.foundation}mp`;
  return {
    candidate: `candidate:${foundation} ${candidate.component} udp ${Math.max(1, candidate.priority - 1000)} ${publicIp} ${mapping.externalPort} typ srflx raddr ${candidate.address} rport ${candidate.port}`,
    sdpMid: candidate.sdpMid || 'video',
    sdpMLineIndex: Number.isFinite(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : 0
  };
}

async function openP2PNatMappings(options = {}) {
  const lifetimeSeconds = Math.max(60, Math.min(600, Number(options.lifetimeSeconds) || 180));
  const rawCandidates = Array.isArray(options.candidates) ? options.candidates : [];
  const candidates = rawCandidates.map(parseIceCandidateForMapping).filter(Boolean);
  const uniqueByPort = new Map();
  for (const candidate of candidates) {
    if (!uniqueByPort.has(candidate.port)) {
      uniqueByPort.set(candidate.port, candidate);
    }
  }

  if (uniqueByPort.size === 0) {
    return {
      ok: false,
      reason: 'no-host-udp-candidates',
      candidates: []
    };
  }

  const gateway = await resolveDefaultGatewayIpv4();
  if (!gateway) {
    return {
      ok: false,
      reason: 'default-gateway-not-found',
      candidates: []
    };
  }

  let publicAddress = '';
  try {
    publicAddress = await requestNatPmpExternalAddress(gateway);
  } catch (error) {
    logMainProcessDebug('p2p', '[p2p-nat] NAT-PMP public address failed:', error && error.message ? error.message : String(error));
  }

  const mappedCandidates = [];
  const errors = [];
  for (const candidate of uniqueByPort.values()) {
    try {
      let mapping;
      try {
        mapping = await requestNatPmpUdpMapping(gateway, candidate.port, lifetimeSeconds);
        if (!publicAddress) {
          throw new Error('nat-pmp-public-address-unavailable');
        }
        mapping.externalAddress = publicAddress;
      } catch (natPmpError) {
        mapping = await requestPcpUdpMapping(gateway, candidate.port, lifetimeSeconds);
        errors.push(`nat-pmp:${candidate.port}:${natPmpError && natPmpError.message ? natPmpError.message : String(natPmpError)}`);
      }

      const mappedCandidate = buildMappedIceCandidate(candidate, mapping, publicAddress);
      if (mappedCandidate) {
        mappedCandidates.push(mappedCandidate);
        activeNatMappings.set(`${candidate.address}:${candidate.port}`, {
          gateway,
          internalPort: candidate.port,
          protocol: mapping.protocol,
          expiresAt: Date.now() + mapping.lifetimeSeconds * 1000
        });
      }
    } catch (error) {
      errors.push(`${candidate.port}:${error && error.message ? error.message : String(error)}`);
    }
  }

  return {
    ok: mappedCandidates.length > 0,
    protocol: mappedCandidates.length > 0 ? 'nat-pmp/pcp' : '',
    gateway,
    candidates: mappedCandidates,
    errors,
    reason: mappedCandidates.length > 0 ? 'nat-mapping-ready' : 'nat-mapping-failed'
  };
}

function releaseActiveNatMappings() {
  for (const mapping of activeNatMappings.values()) {
    if (!mapping || !mapping.gateway || !mapping.internalPort) {
      continue;
    }
    if (mapping.protocol === 'nat-pmp') {
      requestNatPmpUdpMapping(mapping.gateway, mapping.internalPort, 0).catch(() => {});
    } else if (mapping.protocol === 'pcp') {
      requestPcpUdpMapping(mapping.gateway, mapping.internalPort, 0).catch(() => {});
    }
  }
  activeNatMappings.clear();
}

async function listDesktopSources(options = {}) {
  const includeNativeFallbacks = options.includeNativeFallbacks === true;
  const windowMetadata = options.windowMetadata instanceof Map
    ? options.windowMetadata
    : null;
  const rawSources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: ENABLE_CAPTURE_TARGET_WINDOW_ICONS
  });

  const normalizedSources = sortDesktopSources(rawSources.map(normalizeDesktopSource).filter(Boolean));
  if (!includeNativeFallbacks) {
    return normalizedSources;
  }

  const syntheticSources = buildSyntheticFullscreenSources(normalizedSources, windowMetadata);
  const minimizedSources = buildSyntheticMinimizedSources(normalizedSources, windowMetadata);
  return sortDesktopSources(normalizedSources.concat(syntheticSources, minimizedSources));
}

async function listCaptureTargets() {
  const windowMetadata = ENABLE_CAPTURE_TARGET_NATIVE_METADATA
    ? await getTopLevelWindowMetadataMap()
    : new Map();
  const sources = await listDesktopSources({
    includeNativeFallbacks: ENABLE_CAPTURE_TARGET_NATIVE_METADATA,
    windowMetadata
  });
  const audioDiscovery = createDeferredAudioDiscoverySnapshot();
  const displayMetadata = getDisplayMetadataMap();

  return sources.map((source) => buildCaptureTarget(source, audioDiscovery, windowMetadata, displayMetadata));
}

function createDeferredAudioDiscoverySnapshot() {
  return {
    supported: false,
    permissionStatus: 'deferred',
    permission: null,
    processes: [],
    error: null
  };
}

function inspectAudioDiscovery(options = {}) {
  const includeProcesses = options.includeProcesses === true;
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

    if (includeProcesses && snapshot.permissionStatus === 'authorized' && capture.getProcessList) {
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
  const discovery = inspectAudioDiscovery({ includeProcesses: false });
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

function getDisplayMetadataMap() {
  const metadata = new Map();
  const displays = screen.getAllDisplays();
  displays.forEach((display, index) => {
    metadata.set(String(display.id), {
      nativeMonitorIndex: index,
      bounds: display.bounds || null,
      scaleFactor: display.scaleFactor || 1,
      isPrimary: Boolean(display.internal || index === 0)
    });
  });
  return metadata;
}

function buildCaptureTarget(source, audioDiscovery, windowMetadata, displayMetadata) {
  const sourceHandle = source && source.hwnd ? String(source.hwnd) : getDesktopWindowHandleFromSourceId(source.id);
  const windowInfo = sourceHandle ? windowMetadata.get(String(sourceHandle)) : null;
  const pid = normalizePid(windowInfo && windowInfo.pid);
  const title = (windowInfo && windowInfo.title) || source.name;
  const audioCandidates = buildAudioCandidatesForSource(title, pid, audioDiscovery);
  const displayInfo = source.displayId && displayMetadata ? displayMetadata.get(String(source.displayId)) : null;

  return {
    id: source.id,
    sourceId: source.id,
    name: title,
    title,
    appName: deriveAppName(source, title),
    kind: source.kind === 'screen' ? 'display' : 'window',
    state: getCaptureTargetState(source, windowInfo),
    captureMode: source.captureMode,
    displayId: source.displayId || null,
    nativeMonitorIndex: displayInfo ? displayInfo.nativeMonitorIndex : null,
    displayBounds: displayInfo && displayInfo.bounds ? {
      x: displayInfo.bounds.x,
      y: displayInfo.bounds.y,
      width: displayInfo.bounds.width,
      height: displayInfo.bounds.height
    } : null,
    pid,
    hwnd: sourceHandle || null,
    thumbnail: source.thumbnail || null,
    icon: source.appIcon || null,
    isSynthetic: Boolean(source && source.isSynthetic),
    isMinimized: Boolean(windowInfo && windowInfo.isMinimized) || source.syntheticKind === 'minimized-window',
    audioSupported: audioDiscovery.supported,
    audioPermissionStatus: audioDiscovery.permissionStatus,
    audioCandidates,
    defaultAudioMode: audioCandidates.length > 0 ? 'process' : 'none',
    defaultAudioTargetId: audioCandidates.length > 0 ? audioCandidates[0].id : null,
    warnings: buildCaptureTargetWarnings(source, pid, audioCandidates, audioDiscovery),
    discoveryProvider: source && source.isSynthetic ? 'win32-fallback' : 'electron'
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

function getCaptureTargetState(source, windowInfo) {
  if (source && source.syntheticKind === 'minimized-window') {
    return 'minimized';
  }
  if (windowInfo && windowInfo.isMinimized) {
    return 'minimized';
  }
  if (source && source.isSynthetic) {
    return 'exclusive-fullscreen';
  }
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

async function getTopLevelWindowMetadataMap() {
  const helperMetadata = await getTopLevelWindowMetadataMapFromHelper();
  if (helperMetadata) {
    return helperMetadata;
  }

  if (process.env.VDS_CAPTURE_TARGET_METADATA_IN_PROCESS !== '1') {
    return new Map();
  }

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
        rect: getWindowRect(api, hwnd),
        isForeground: api.GetForegroundWindow && api.GetForegroundWindow() === hwnd,
        isVisible: api.IsWindowVisible ? Boolean(api.IsWindowVisible(hwnd)) : true,
        isMinimized: api.IsIconic ? Boolean(api.IsIconic(hwnd)) : false
      });

      return true;
    }, 0);
  } catch (error) {
    logMainProcessWarning('video', 'Unable to build top-level window metadata map:', error);
  }

  return metadata;
}

function getTopLevelWindowMetadataMapFromHelper() {
  if (process.platform !== 'win32') {
    return Promise.resolve(new Map());
  }

  const helperPath = path.join(__dirname, 'window-metadata-helper.js');
  const timeoutMs = Number(process.env.VDS_CAPTURE_TARGET_METADATA_TIMEOUT_MS || 1200);
  const electronRunAsNode = process.execPath && /electron(?:\.exe)?$/i.test(path.basename(process.execPath));
  const env = {
    ...process.env,
    VDS_PARENT_PROCESS_ID: String(process.pid)
  };
  if (electronRunAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = childProcess.spawn(process.execPath, [helperPath], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (metadata) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(metadata);
    };

    const timeoutId = setTimeout(() => {
      if (child && !child.killed) {
        child.kill();
      }
      const rate = shouldEmitMainDebugLog('capture-target-metadata-helper-timeout', 5000);
      if (rate.emit) {
        logMainProcessWarning('video', '[capture-targets] metadata helper timed out', rate.suppressed ? `suppressed=${rate.suppressed}` : '');
      }
      finish(null);
    }, Math.max(300, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    child.once('error', (error) => {
      const rate = shouldEmitMainDebugLog('capture-target-metadata-helper-error', 5000);
      if (rate.emit) {
        logMainProcessWarning('video', '[capture-targets] metadata helper failed:', error && error.message ? error.message : String(error), rate.suppressed ? `suppressed=${rate.suppressed}` : '');
      }
      finish(null);
    });

    child.once('exit', (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const rate = shouldEmitMainDebugLog(`capture-target-metadata-helper-exit:${code}`, 5000);
        if (rate.emit) {
          logMainProcessWarning('video', '[capture-targets] metadata helper exited:', code, stderr.trim(), rate.suppressed ? `suppressed=${rate.suppressed}` : '');
        }
        finish(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const windows = Array.isArray(parsed && parsed.windows) ? parsed.windows : [];
        const metadata = new Map();
        for (const entry of windows) {
          const hwnd = String(entry && entry.hwnd ? entry.hwnd : '').trim();
          const title = String(entry && entry.title ? entry.title : '').trim();
          if (!hwnd || !title) {
            continue;
          }
          metadata.set(hwnd, {
            hwnd,
            pid: normalizePid(entry.pid),
            title,
            rect: entry.rect || null,
            isForeground: Boolean(entry.isForeground),
            isVisible: entry.isVisible !== false,
            isMinimized: Boolean(entry.isMinimized)
          });
        }
        finish(metadata);
      } catch (error) {
        const rate = shouldEmitMainDebugLog('capture-target-metadata-helper-parse', 5000);
        if (rate.emit) {
          logMainProcessWarning('video', '[capture-targets] metadata helper returned invalid JSON:', error && error.message ? error.message : String(error), rate.suppressed ? `suppressed=${rate.suppressed}` : '');
        }
        finish(null);
      }
    });
  });
}

function buildSyntheticFullscreenSources(existingSources, windowMetadata = null) {
  if (!(windowMetadata instanceof Map) || windowMetadata.size === 0) {
    return [];
  }

  try {
    const foregroundWindow = Array.from(windowMetadata.values()).find((windowInfo) => windowInfo && windowInfo.isForeground);
    if (!foregroundWindow) {
      return [];
    }

    const handleValue = String(foregroundWindow.hwnd || '').trim();
    if (!handleValue || hasDesktopSourceForWindowHandle(existingSources, handleValue)) {
      return [];
    }

    const title = String(foregroundWindow.title || '').trim();
    const pid = normalizePid(foregroundWindow.pid);
    const rect = foregroundWindow.rect || null;
    if (!title || !pid || pid === process.pid || !rect) {
      return [];
    }

    if (!foregroundWindow.isVisible || foregroundWindow.isMinimized) {
      return [];
    }

    const display = findDisplayForFullscreenRect(rect);
    if (!display) {
      return [];
    }

    const syntheticSource = {
      id: `window:${handleValue}:synthetic`,
      name: title,
      kind: 'window',
      displayId: String(display.id),
      isSynthetic: true,
      syntheticKind: 'exclusive-fullscreen',
      captureMode: 'window',
      appIcon: null,
      thumbnail: null,
      hwnd: String(handleValue)
    };
    logMainProcessDebug('video', '[capture-targets] synthesized exclusive fullscreen source:', syntheticSource);
    return [syntheticSource];
  } catch (error) {
    logMainProcessWarning('video', 'Failed to synthesize exclusive fullscreen source:', error);
    return [];
  }
}

function buildSyntheticMinimizedSources(existingSources, windowMetadata = null) {
  if (!(windowMetadata instanceof Map)) {
    return [];
  }
  if (!windowMetadata || windowMetadata.size === 0) {
    return [];
  }

  const syntheticSources = [];
  for (const windowInfo of windowMetadata.values()) {
    if (!windowInfo || !windowInfo.isMinimized) {
      continue;
    }

    const handleValue = String(windowInfo.hwnd || '').trim();
    const pid = normalizePid(windowInfo.pid);
    const title = String(windowInfo.title || '').trim();
    if (!handleValue || !pid || pid === process.pid || !title) {
      continue;
    }
    if (hasDesktopSourceForWindowHandle(existingSources, handleValue)) {
      continue;
    }

    syntheticSources.push({
      id: `window:${handleValue}:minimized`,
      name: title,
      kind: 'window',
      displayId: null,
      isSynthetic: true,
      syntheticKind: 'minimized-window',
      captureMode: 'window',
      appIcon: null,
      thumbnail: null,
      hwnd: handleValue
    });
  }

  if (syntheticSources.length > 0) {
    logMainProcessDebug('video', '[capture-targets] synthesized minimized window sources:', syntheticSources);
  }
  return syntheticSources;
}

function hasDesktopSourceForWindowHandle(sources, hwnd) {
  const wanted = String(hwnd || '').trim();
  if (!wanted) {
    return false;
  }

  return Array.isArray(sources) && sources.some((source) => {
    if (!source) {
      return false;
    }
    if (source.hwnd && String(source.hwnd).trim() === wanted) {
      return true;
    }
    return getDesktopWindowHandleFromSourceId(source.id) === wanted;
  });
}

function getWindowRect(api, hwnd) {
  try {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!api.GetWindowRect(hwnd, rect)) {
      return null;
    }
    return {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: Number(rect.right) || 0,
      bottom: Number(rect.bottom) || 0
    };
  } catch (_error) {
    return null;
  }
}

function findDisplayForFullscreenRect(rect) {
  if (!rect) {
    return null;
  }

  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const bounds = display && display.bounds ? display.bounds : null;
    if (!bounds) {
      continue;
    }

    const overlapWidth = Math.max(0, Math.min(rect.right, bounds.x + bounds.width) - Math.max(rect.left, bounds.x));
    const overlapHeight = Math.max(0, Math.min(rect.bottom, bounds.y + bounds.height) - Math.max(rect.top, bounds.y));
    const overlapArea = overlapWidth * overlapHeight;
    const displayArea = Math.max(1, bounds.width * bounds.height);
    const widthDelta = Math.abs((rect.right - rect.left) - bounds.width);
    const heightDelta = Math.abs((rect.bottom - rect.top) - bounds.height);
    const overlapRatio = overlapArea / displayArea;

    if (overlapRatio >= 0.95 && widthDelta <= 8 && heightDelta <= 8) {
      return display;
    }
  }

  return null;
}

function getMediaAgentManager() {
  if (!mediaAgentManager) {
    mediaAgentManager = new MediaAgentManager({
      logger: {
        log: (...args) => {
          if (shouldLogMediaDebug('video', 'agentStderr')) {
            logMainProcessDebug('video', ...args);
          }
        },
        warn: (...args) => {
          const message = args.map((entry) => String(entry)).join(' ');
          if (message.includes('[media-agent breadcrumb]')) {
            if (shouldLogMediaDebug('video', 'agentBreadcrumbs')) {
              const normalizedMessage = message.replace(/\bt=\d+\b/g, 't=*');
              const rate = shouldEmitMainDebugLog(`agent-breadcrumb:${normalizedMessage}`, 1000);
              if (rate.emit) {
                logMainProcessWarning('video', ...args, rate.suppressed ? `suppressed=${rate.suppressed}` : '');
              }
            }
            return;
          }
          if (shouldLogMediaDebug('video', 'agentStderr')) {
            logMainProcessWarning('video', ...args);
          }
        },
        error: (...args) => {
          console.error(...args);
        }
      }
    });
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
    logMainProcessDebug(debugCategory, `[media-agent invoke] ${method} request:`, JSON.stringify(summarizeMediaEnginePayload(params)));
  }
  try {
    const result = await getMediaAgentManager().invoke(method, params);
    if (shouldLogMediaInvoke(method, debugCategory)) {
      logMainProcessDebug(debugCategory, `[media-agent invoke] ${method} result:`, JSON.stringify(summarizeMediaEnginePayload(result)));
    }
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (method === 'getViewerVolume' && message.includes('No active render audio session was found')) {
      throw error;
    }
    if (method === 'stopAudioSession' && message.includes('media-agent-stopped')) {
      logMainProcessDebug('audio', '[media-agent] stopAudioSession ignored because agent is already stopped');
      return {
        stopped: false,
        implementation: 'media-agent-stopped'
      };
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
    const result = await invokeMediaEngine(method, params);
    if (method === 'stopHostSession') {
      const manager = getMediaAgentManager();
      try {
        await manager.stop();
      } catch (restartStopError) {
        const rate = shouldEmitMainDebugLog('host-session-bridge:stop-shutdown-failed', 5000);
        if (rate.emit) {
          logMainProcessWarning(
            'connection',
            '[media-agent bridge] stopHostSession agent shutdown failed:',
            restartStopError,
            rate.suppressed ? `suppressed=${rate.suppressed}` : ''
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await manager.start();
      } catch (restartStartError) {
        const rate = shouldEmitMainDebugLog('host-session-bridge:stop-restart-failed', 5000);
        if (rate.emit) {
          logMainProcessWarning(
            'connection',
            '[media-agent bridge] stopHostSession agent restart failed:',
            restartStartError,
            rate.suppressed ? `suppressed=${rate.suppressed}` : ''
          );
        }
      }
    }
    return result;
  } catch (error) {
    if (method === 'stopHostSession') {
      const manager = getMediaAgentManager();
      try {
        await manager.stop();
      } catch (restartStopError) {
        const rate = shouldEmitMainDebugLog('host-session-bridge:recovery-shutdown-failed', 5000);
        if (rate.emit) {
          logMainProcessWarning(
            'connection',
            '[media-agent bridge] stopHostSession recovery shutdown failed:',
            restartStopError,
            rate.suppressed ? `suppressed=${rate.suppressed}` : ''
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await manager.start();
      } catch (restartStartError) {
        const rate = shouldEmitMainDebugLog('host-session-bridge:recovery-restart-failed', 5000);
        if (rate.emit) {
          logMainProcessWarning(
            'connection',
            '[media-agent bridge] stopHostSession recovery restart failed:',
            restartStartError,
            rate.suppressed ? `suppressed=${rate.suppressed}` : ''
          );
        }
      }
    }
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
  try {
    if (!source || !source.id) {
      return null;
    }

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
  } catch (error) {
    logMainProcessDebug('video', '[capture-targets] failed to normalize desktop source:', error && error.message ? error.message : String(error));
    return null;
  }
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
    logMainProcessWarning('video', 'Win32 fullscreen source detection unavailable:', error);
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
  logMainProcessDebug('misc', `Using Electron profile: ${profileName}`);
}

function installProcessDiagnostics() {
  process.on('uncaughtException', (error) => {
    writeUpdateLog('error', `[electron] uncaughtException: ${formatLogMessage(error)}`);
  });

  process.on('unhandledRejection', (reason) => {
    writeUpdateLog('error', `[electron] unhandledRejection: ${formatLogMessage(reason)}`);
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    writeUpdateLog('error', {
      event: '[electron] app render-process-gone',
      url: webContents && !webContents.isDestroyed() ? webContents.getURL() : '',
      details
    });
  });

  app.on('child-process-gone', (_event, details) => {
    writeUpdateLog('error', {
      event: '[electron] child-process-gone',
      details
    });
  });
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
  releaseActiveNatMappings();
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
