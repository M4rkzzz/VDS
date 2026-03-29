const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, shell, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { setupAudioCaptureIpc } = require('process-audio-capture/dist/main');

const SERVER_URL = normalizeBaseUrl(process.env.SERVER_URL || 'https://boshan.s.3q.hair');
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 30000);

let mainWindow = null;
let tray = null;
let updateLogFilePath = null;
const updateLogSessionStamp = createUpdateLogSessionStamp();
const updateLogEntries = [];
const UPDATE_LOG_ENTRY_LIMIT = 200;
let win32WindowCaptureApi = undefined;

configureProfilePaths();

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

try {
  setupAudioCaptureIpc();
  console.log('Audio capture IPC ready');
} catch (error) {
  console.error('Failed to setup audio capture IPC:', error);
}

ipcMain.handle('get-runtime-config', () => ({
  serverUrl: SERVER_URL,
  disconnectGraceMs: DISCONNECT_GRACE_MS
}));

ipcMain.handle('get-desktop-sources', async () => {
  try {
    const rawSources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });

    const sources = rawSources.map(normalizeDesktopSource);
    const fullscreenFallbackSource = buildFullscreenFallbackSource(sources);
    const minimizedWindowFallbackSources = buildMinimizedWindowFallbackSources(sources);
    const orderedSources = sortDesktopSources(
      (fullscreenFallbackSource ? [fullscreenFallbackSource] : [])
        .concat(sources, minimizedWindowFallbackSources)
    );

    return orderedSources;
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
ipcMain.handle('window-is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()));

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
  app.isQuitting = true;
  if (mainWindow) {
    mainWindow.close();
  }
});

autoUpdater.logger = {
  info: (message) => writeUpdateLog('info', message),
  warn: (message) => writeUpdateLog('warn', message),
  error: (message) => writeUpdateLog('error', message)
};
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    writeUpdateLog('info', 'Skip update check in dev mode because app.isPackaged is false.');
    return { devMode: true };
  }

  try {
    writeUpdateLog('info', `Starting update check. version=${app.getVersion()} feed=${getUpdateFeedBaseUrl()}`);
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: getUpdateFeedBaseUrl(),
      useMultipleRangeRequest: false
    });
    writeUpdateLog('info', `Feed URL configured: ${getUpdateManifestUrl()} (multi-range disabled)`);
    return await autoUpdater.checkForUpdates();
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
    writeUpdateLog('info', 'Starting update download from renderer request.');
    await autoUpdater.downloadUpdate();
    return true;
  } catch (error) {
    writeUpdateLog('error', `Update download failed before completion: ${formatLogMessage(error)}`);
    console.error('Update download error:', error);
    return false;
  }
});

ipcMain.handle('quit-and-install', () => {
  if (app.isPackaged) {
    writeUpdateLog('info', 'quitAndInstall requested by renderer.');
    autoUpdater.quitAndInstall();
  }
});

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

  mainWindow.loadFile(path.resolve(__dirname, '../server/public', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
    }
  });

  mainWindow.on('maximize', () => {
    sendToRenderer('window-maximized-changed', true);
  });

  mainWindow.on('unmaximize', () => {
    sendToRenderer('window-maximized-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
        app.isQuitting = true;
        app.quit();
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

function getUpdateFeedBaseUrl() {
  return `${SERVER_URL}/updates/`;
}

function getUpdateManifestUrl() {
  return `${getUpdateFeedBaseUrl()}latest.yml`;
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
  if (source.captureMode === 'fullscreen-display-fallback') {
    return 0;
  }

  if (!source.isSynthetic && source.kind === 'window') {
    return 1;
  }

  if (source.captureMode === 'minimized-window-fallback') {
    return 2;
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

function buildFullscreenFallbackSource(sources) {
  if (process.platform !== 'win32') {
    return null;
  }

  const fullscreenWindow = getActiveFullscreenWindowInfo();
  if (!fullscreenWindow) {
    return null;
  }

  const windowSourceExists = sources.some((source) => {
    if (source.kind !== 'window') {
      return false;
    }

    return normalizeComparableWindowTitle(source.name) === normalizeComparableWindowTitle(fullscreenWindow.title);
  });

  if (windowSourceExists) {
    return null;
  }

  const displaySource = sources.find((source) => (
    source.kind === 'screen' &&
    String(source.displayId || '') === String(fullscreenWindow.displayId || '')
  ));

  if (!displaySource) {
    return null;
  }

  const title = fullscreenWindow.title || `PID ${fullscreenWindow.pid}`;
  console.log(`Adding fullscreen display fallback source for "${title}" on display ${fullscreenWindow.displayId}`);
  return {
    ...displaySource,
    id: displaySource.id,
    name: `${title} [全屏回退]`,
    kind: 'screen',
    isSynthetic: true,
    captureMode: 'fullscreen-display-fallback',
    fallbackWindowPid: fullscreenWindow.pid,
    fallbackWindowTitle: title,
    fallbackReason: 'Windows 独占全屏窗口通常不会出现在常规窗口列表中；此项会改为采集该窗口所在显示器。'
  };
}

function buildMinimizedWindowFallbackSources(sources) {
  if (process.platform !== 'win32') {
    return [];
  }

  const api = getWin32WindowCaptureApi();
  if (!api || !api.EnumWindows || !api.IsIconic) {
    return [];
  }

  const existingWindowHandles = new Set(
    sources
      .map((source) => getDesktopWindowHandleFromSourceId(source && source.id))
      .filter(Boolean)
  );
  const fallbackSources = [];

  try {
    api.EnumWindows((hwnd) => {
      if (!hwnd) {
        return true;
      }

      if (api.IsWindowVisible && !api.IsWindowVisible(hwnd)) {
        return true;
      }

      if (api.IsIconic && !api.IsIconic(hwnd)) {
        return true;
      }

      if (api.GetWindow && api.GW_OWNER && api.GetWindow(hwnd, api.GW_OWNER)) {
        return true;
      }

      const title = getWindowTitle(api, hwnd);
      if (!title) {
        return true;
      }

      const hwndValue = getWindowHandleValue(api, hwnd);
      if (!hwndValue || existingWindowHandles.has(hwndValue)) {
        return true;
      }

      const pid = getWindowProcessId(api, hwnd);
      if (!pid || pid === process.pid) {
        return true;
      }

      existingWindowHandles.add(hwndValue);
      fallbackSources.push({
        id: createDesktopWindowSourceId(hwndValue, pid),
        name: `${title} [最小化窗口]`,
        kind: 'window',
        displayId: null,
        isSynthetic: true,
        captureMode: 'minimized-window-fallback',
        fallbackWindowPid: pid,
        fallbackWindowTitle: title,
        fallbackWindowHandle: hwndValue,
        fallbackReason: 'Windows 最小化到任务栏的窗口通常不会出现在常规窗口列表中；此项会按窗口句柄直接尝试附着。窗口保持最小化时，部分应用可能只输出静帧或黑屏。',
        appIcon: null,
        thumbnail: null
      });
      return true;
    }, 0);
  } catch (error) {
    console.warn('Unable to enumerate minimized windows for source selection:', error);
    return [];
  }

  if (fallbackSources.length > 0) {
    console.log(`Added ${fallbackSources.length} minimized window fallback source(s).`);
  }

  return fallbackSources;
}

function normalizeComparableWindowTitle(title) {
  return String(title || '')
    .replace(/\s*\[(fullscreen -> display capture|全屏回退)\]\s*$/i, '')
    .replace(/\s*\[(minimized window|最小化窗口)\]\s*$/i, '')
    .trim()
    .toLowerCase();
}

function getActiveFullscreenWindowInfo() {
  const api = getWin32WindowCaptureApi();
  if (!api) {
    return null;
  }

  try {
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) {
      return null;
    }

    if (api.IsWindowVisible && !api.IsWindowVisible(hwnd)) {
      return null;
    }

    const pid = [0];
    const threadId = api.GetWindowThreadProcessId(hwnd, pid);
    if (!threadId || !pid[0]) {
      return null;
    }

    const rect = {};
    if (!api.GetWindowRect(hwnd, rect)) {
      return null;
    }

    const width = Number(rect.right) - Number(rect.left);
    const height = Number(rect.bottom) - Number(rect.top);
    if (width < 320 || height < 240) {
      return null;
    }

    const center = {
      x: Number(rect.left) + Math.round(width / 2),
      y: Number(rect.top) + Math.round(height / 2)
    };
    const display = screen.getDisplayNearestPoint(center);
    if (!display || !isRectCloseToDisplay(rect, display.bounds)) {
      return null;
    }

    return {
      pid: Number(pid[0]),
      title: getWindowTitle(api, hwnd),
      displayId: String(display.id)
    };
  } catch (error) {
    console.warn('Unable to inspect foreground fullscreen window:', error);
    return null;
  }
}

function isRectCloseToDisplay(rect, bounds) {
  const tolerance = 12;
  const width = Number(rect.right) - Number(rect.left);
  const height = Number(rect.bottom) - Number(rect.top);

  return (
    Math.abs(Number(rect.left) - Number(bounds.x)) <= tolerance &&
    Math.abs(Number(rect.top) - Number(bounds.y)) <= tolerance &&
    Math.abs(width - Number(bounds.width)) <= tolerance &&
    Math.abs(height - Number(bounds.height)) <= tolerance
  );
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

function createDesktopWindowSourceId(hwndValue, pid) {
  const sameProcessFlag = Number(pid) === process.pid ? 1 : 0;
  return `window:${hwndValue}:${sameProcessFlag}`;
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
      GetWindowThreadProcessId: user32.func('DWORD __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ DWORD *lpdwProcessId)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)'),
      GetWindow: user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)'),
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, long lParam)'),
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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
