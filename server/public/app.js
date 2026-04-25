// 生成客户端ID
const DEFAULT_SERVER_URL = 'https://boshan.s.3q.hair';
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.linphone.org:3478' },
  { urls: 'stun:stun.freeswitch.org:3478' },
  { urls: 'stun:stun.pjsip.org:3478' },
  { urls: 'stun:stun.sip.us:3478' },
  { urls: 'stun:stun.ippi.fr:3478' },
  { urls: 'stun:stun.easyvoip.com:3478' },
  { urls: 'stun:stun.ekiga.net:3478' }
];
const P2P_CONNECT_FAILFAST_MS = 15000;
const P2P_RECONNECT_DELAYS_MS = [750, 1500];

const runtimeConfig = getRuntimeConfig();
const serverBaseUrl = runtimeConfig.serverUrl;
const wsBaseUrl = toWebSocketUrl(serverBaseUrl);
const clientId = runtimeConfig.clientId || ('client_' + Math.random().toString(36).substring(2, 11));
const DEBUG_MODE_STORAGE_KEY = 'vds-debug-mode';
const DEBUG_CONFIG_STORAGE_KEY = 'vds-debug-config';
const VIEWER_PLAYBACK_PREFS_STORAGE_KEY = 'vds-viewer-playback-prefs';
const OBS_INGEST_PREFS_STORAGE_KEY = 'vds-obs-ingest-prefs';
const DEBUG_CATEGORY_DEFINITIONS = Object.freeze({
  connection: {
    label: '连接',
    description: 'WebSocket、信令、ICE、Peer 建连与重连'
  },
  p2p: {
    label: 'P2P 诊断',
    description: '候选、RTT、NACK/PLI、关键帧请求与媒体平面状态'
  },
  video: {
    label: '视频',
    description: '采集源、Surface、视频链路与预览同步'
  },
  audio: {
    label: '音频',
    description: '音频会话、音量、播放与原生音频桥'
  },
  update: {
    label: '更新',
    description: '版本检查、下载、安装与更新日志'
  },
  misc: {
    label: '杂项',
    description: '启动、能力探测、版本信息与其它诊断'
  }
});
const DEBUG_CHANNEL_DEFINITIONS = Object.freeze({
  renderer: {
    label: '渲染日志',
    description: 'app.js 常规调试输出'
  },
  nativeEvents: {
    label: '原生事件',
    description: 'media-state、peer-state、signal 事件摘要，高频事件会被节流'
  },
  nativeSteps: {
    label: '原生步骤',
    description: 'attach/createPeer/setRemoteDescription 等 step 明细，同类步骤会被节流'
  },
  periodicStats: {
    label: '周期统计',
    description: 'host/viewer 周期 stats 与抖动指标，默认按采样输出'
  },
  mainProcess: {
    label: '主进程桥接',
    description: 'IPC 调用、surface enrich、主进程媒体桥'
  },
  agentBreadcrumbs: {
    label: 'Agent Breadcrumb',
    description: 'native agent stderr breadcrumb 轨迹，主进程会按内容归并'
  },
  agentStderr: {
    label: 'Agent STDERR',
    description: 'native agent 原始 stderr 输出，仅短时间深挖时打开'
  }
});
const DEBUG_PRESET_DEFINITIONS = Object.freeze({
  quiet: {
    label: '静默',
    description: '关闭所有调试输出',
    config: {
      categories: {
        connection: false,
        p2p: false,
        video: false,
        audio: false,
        update: false,
        misc: false
      },
      channels: {
        renderer: false,
        nativeEvents: false,
        nativeSteps: false,
        periodicStats: false,
        mainProcess: false,
        agentBreadcrumbs: false,
        agentStderr: false
      }
    }
  },
  diagnose: {
    label: '排障',
    description: '推荐日常排障，默认不开高频日志',
    config: {
      categories: {
        connection: true,
        p2p: true,
        video: true,
        audio: true,
        update: true,
        misc: true
      },
      channels: {
        renderer: true,
        nativeEvents: true,
        nativeSteps: false,
        periodicStats: false,
        mainProcess: true,
        agentBreadcrumbs: false,
        agentStderr: false
      }
    }
  },
  traceVideo: {
    label: '视频追踪',
    description: '重点看视频链路，开启 step 和周期统计',
    config: {
      categories: {
        connection: true,
        p2p: false,
        video: true,
        audio: false,
        update: false,
        misc: false
      },
      channels: {
        renderer: true,
        nativeEvents: true,
        nativeSteps: true,
        periodicStats: true,
        mainProcess: true,
        agentBreadcrumbs: true,
        agentStderr: false
      }
    }
  },
  verbose: {
    label: '短时全量',
    description: '最大化日志，只适合短时间深挖问题，不建议长时间运行',
    config: {
      categories: {
        connection: true,
        p2p: false,
        video: true,
        audio: true,
        update: true,
        misc: true
      },
      channels: {
        renderer: true,
        nativeEvents: true,
        nativeSteps: true,
        periodicStats: true,
        mainProcess: true,
        agentBreadcrumbs: true,
        agentStderr: true
      }
    }
  }
});
const DEBUG_CATEGORY_KEYS = Object.keys(DEBUG_CATEGORY_DEFINITIONS);
const DEBUG_CHANNEL_KEYS = Object.keys(DEBUG_CHANNEL_DEFINITIONS);
let debugConfig = readDebugConfig();

const VIEWER_PLAYBACK_MODES = Object.freeze({
  PASSTHROUGH: 'passthrough'
});

const DEFAULT_OBS_INGEST_PORT = 61080;
const OBS_INGEST_PORT_MIN = 1024;
const OBS_INGEST_PORT_MAX = 65535;

// WebSocket连接
let ws = null;
let wsConnected = false;
let wsConnectPromise = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let pendingReconnect = false;
let resumeOnNextConnect = false;
const pendingMessages = [];
const pendingRemoteCandidates = new Map();
const MAX_PENDING_REMOTE_CANDIDATES_PER_PEER = 32;
let wsManualClose = false; // 标记是否为手动关闭

// Session state
let isHost = false;
let sessionRole = null;
let currentRoomId = null;
let localStream = null;
let myChainPosition = -1; // 观众在链中的位置
let hostId = null; // Host的clientId
let viewerJoinMode = 'lobby';
let viewerJoinPending = false;
let viewerPendingJoinSource = null;
let publicRooms = [];
let publicRoomsRefreshInFlight = false;
let publicRoomsPollTimer = null;
let publicRoomsLastError = '';
let sourceSelectionInFlight = false;

let viewerPlaybackPrefs = readViewerPlaybackPrefs();
const initialObsIngestPrefs = readObsIngestPrefs();

// 音频捕获全局变量（用于资源清理）

// 画质设置
let qualitySettings = {
  hostBackend: 'native',
  obsIngestPort: initialObsIngestPrefs.port,
  obsIngestCustomPortEnabled: initialObsIngestPrefs.customPortEnabled,
  codecPreference: 'h264',
  resolutionPreset: '1080p',
  width: 1920,
  height: 1080,
  bitrate: 10000, // kbps
  frameRate: 30,
  previewEnabled: true,
  hardwareAcceleration: true,
  hardwareEncoderPreference: 'auto',
  encoderPreset: 'balanced',
  encoderTune: 'none',
  publicRoomEnabled: false,
  keyframePolicy: '1s'
};
let qualityCapabilities = null;
let qualityCapabilitiesPromise = null;
let qualityCapabilitiesChecked = false;
let qualityUiBound = false;
let obsIngestPreview = null;
let obsIngestPreparePromise = null;
let obsIngestPrepareRequestPort = 0;

const QUALITY_BITRATE_MIN = 1000;
const QUALITY_BITRATE_MAX = 80000;
const QUALITY_BITRATE_STEP = 1000;
const QUALITY_CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264' },
  { value: 'h265', label: 'H.265' }
];
const QUALITY_RESOLUTION_OPTIONS = [
  { value: '360p', label: '360p', width: 640, height: 360 },
  { value: '480p', label: '480p', width: 854, height: 480 },
  { value: '720p', label: '720p', width: 1280, height: 720 },
  { value: '1080p', label: '1080p', width: 1920, height: 1080 },
  { value: '2k', label: '2k', width: 2560, height: 1440 },
  { value: '4k', label: '4k', width: 3840, height: 2160 }
];
const QUALITY_FPS_OPTIONS = [
  { value: 5, label: '5' },
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 90, label: '90' }
];
const QUALITY_PRESET_OPTIONS = [
  { value: 'quality', label: '质量' },
  { value: 'balanced', label: '均衡' },
  { value: 'speed', label: '速度' }
];
const QUALITY_TUNE_OPTIONS = [
  { value: 'none', label: '默认' },
  { value: 'fastdecode', label: 'fastdecode' },
  { value: 'zerolatency', label: 'zerolatency' }
];
const QUALITY_KEYFRAME_OPTIONS = [
  { value: '1s', label: '1s' },
  { value: '0.5s', label: '0.5s' },
  { value: 'all-intra', label: 'All-Intra', badge: '高带宽，高负载' }
];
const QUALITY_HARDWARE_ENCODER_PATTERN = /(?:_amf|_mf|_qsv|_nvenc|videotoolbox|_d3d12va)/i;
const PUBLIC_ROOMS_POLL_INTERVAL_MS = 500;


// Native peer/session state
const peerConnections = new Map();
let relayPc = null;
let relayStream = null;
let viewerReadySent = false;
let videoStarted = false;
let upstreamConnected = false;
let runtimeConnectionConfigPromise = null;
let updateStatusUnsubscribe = null;
let updateLogUnsubscribe = null;
let updateCheckStarted = false;
let updateModalAutoHideTimer = null;
let updateInstallTimer = null;
let updateLogPath = '';
const updateLogEntries = [];
const UPDATE_LOG_ENTRY_LIMIT = 40;
let upstreamPeerId = null;
const peerConnectionMeta = new Map();
const peerReconnectState = new Map();
const LANDING_TRANSITION_MS = 520;
const PANEL_TRANSITION_MS = 340;
const WORKSPACE_MASK_MS = 140;

const iceServers = sanitizeIceServers(DEFAULT_ICE_SERVERS);

const config = {
  iceServers: iceServers,
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle'
};

function getRuntimeConfig() {
  if (window.isElectron && window.electronAPI && typeof window.electronAPI.getRuntimeConfig === 'function') {
    const electronConfig = window.electronAPI.getRuntimeConfig() || {};
    return {
      clientId: electronConfig.clientId || null,
      serverUrl: normalizeBaseUrl(electronConfig.serverUrl || DEFAULT_SERVER_URL),
      disconnectGraceMs: Number(electronConfig.disconnectGraceMs || 30000),
      debugPreset: String(electronConfig.debugPreset || '').trim()
    };
  }

  return {
    clientId: null,
    serverUrl: normalizeBaseUrl(window.location.origin || DEFAULT_SERVER_URL),
    disconnectGraceMs: 30000,
    debugPreset: ''
  };
}

function readDebugModeFlag() {
  try {
    return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

function buildDefaultDebugConfig(enabled = false) {
  return {
    categories: DEBUG_CATEGORY_KEYS.reduce((config, key) => {
      config[key] = Boolean(enabled);
      return config;
    }, {}),
    channels: DEBUG_CHANNEL_KEYS.reduce((config, key) => {
      config[key] = Boolean(enabled);
      return config;
    }, {})
  };
}

function normalizeDebugConfig(config, fallbackEnabled = false) {
  if (typeof config === 'boolean') {
    return buildDefaultDebugConfig(config);
  }

  const normalized = buildDefaultDebugConfig(fallbackEnabled);
  if (!config || typeof config !== 'object') {
    return normalized;
  }

  const hasStructuredCategories = Boolean(config.categories && typeof config.categories === 'object');
  const hasStructuredChannels = Boolean(config.channels && typeof config.channels === 'object');

  if (!hasStructuredCategories && !hasStructuredChannels) {
    for (const key of DEBUG_CATEGORY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        normalized.categories[key] = Boolean(config[key]);
      }
    }

    const legacyEnabled = DEBUG_CATEGORY_KEYS.some((key) => normalized.categories[key]);
    normalized.channels.renderer = legacyEnabled;
    normalized.channels.nativeEvents = legacyEnabled;
    normalized.channels.mainProcess = legacyEnabled;
    return normalized;
  }

  for (const key of DEBUG_CATEGORY_KEYS) {
    if (hasStructuredCategories && Object.prototype.hasOwnProperty.call(config.categories, key)) {
      normalized.categories[key] = Boolean(config.categories[key]);
    }
  }

  for (const key of DEBUG_CHANNEL_KEYS) {
    if (hasStructuredChannels && Object.prototype.hasOwnProperty.call(config.channels, key)) {
      normalized.channels[key] = Boolean(config.channels[key]);
    }
  }

  return normalized;
}

function readDebugConfig() {
  const runtimePreset = normalizeRuntimeDebugPreset(runtimeConfig.debugPreset);
  if (runtimePreset) {
    return normalizeDebugConfig(DEBUG_PRESET_DEFINITIONS[runtimePreset].config, false);
  }

  const legacyEnabled = readDebugModeFlag();
  try {
    const raw = window.localStorage.getItem(DEBUG_CONFIG_STORAGE_KEY);
    if (!raw) {
      return buildDefaultDebugConfig(legacyEnabled);
    }
    return normalizeDebugConfig(JSON.parse(raw), legacyEnabled);
  } catch (_error) {
    return buildDefaultDebugConfig(legacyEnabled);
  }
}

function normalizeRuntimeDebugPreset(preset) {
  const normalized = String(preset || '').trim();
  if (!normalized || normalized === 'profile') {
    return '';
  }
  return Object.prototype.hasOwnProperty.call(DEBUG_PRESET_DEFINITIONS, normalized)
    ? normalized
    : '';
}

function isAnyDebugEnabled(config = debugConfig) {
  return DEBUG_CATEGORY_KEYS.some((key) => Boolean(config.categories && config.categories[key])) ||
    DEBUG_CHANNEL_KEYS.some((key) => Boolean(config.channels && config.channels[key]));
}

function isAnyDebugPathEnabled(config = debugConfig) {
  return DEBUG_CATEGORY_KEYS.some((category) => (
    DEBUG_CHANNEL_KEYS.some((channel) => isDebugLogEnabled(category, channel, config))
  ));
}

function persistDebugConfig(config) {
  try {
    window.localStorage.setItem(DEBUG_CONFIG_STORAGE_KEY, JSON.stringify(config));
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, isAnyDebugEnabled(config) ? '1' : '0');
  } catch (_error) {
    // ignore storage errors
  }
}

function syncDebugUi() {
  const debugEnabled = isAnyDebugPathEnabled();
  document.body.classList.toggle('debug-mode-enabled', debugEnabled);

  if (elements && elements.btnDebugToggle) {
    const enabledCategories = DEBUG_CATEGORY_KEYS
      .filter((key) => debugConfig.categories[key])
      .map((key) => DEBUG_CATEGORY_DEFINITIONS[key].label);
    const enabledChannels = DEBUG_CHANNEL_KEYS
      .filter((key) => debugConfig.channels[key])
      .map((key) => DEBUG_CHANNEL_DEFINITIONS[key].label);
    elements.btnDebugToggle.classList.toggle('active', debugEnabled);
    elements.btnDebugToggle.title = debugEnabled
      ? `已开启：${enabledCategories.join('、') || '无类别'} / ${enabledChannels.join('、') || '无通道'}`
      : '打开调试菜单';
    if (elements.debugMenu) {
      elements.btnDebugToggle.setAttribute(
        'aria-expanded',
        elements.debugMenu.classList.contains('hidden') ? 'false' : 'true'
      );
    }
  }

  if (elements && elements.debugMenu) {
    const checkboxes = elements.debugMenu.querySelectorAll('[data-debug-category], [data-debug-channel]');
    checkboxes.forEach((input) => {
      const category = input.getAttribute('data-debug-category');
      const channel = input.getAttribute('data-debug-channel');
      let checked = false;
      if (category) {
        checked = Boolean(debugConfig.categories[category]);
      } else if (channel) {
        checked = Boolean(debugConfig.channels[channel]);
      }
      input.checked = checked;
      const item = input.closest('.debug-menu-item');
      if (item) {
        item.classList.toggle('active', checked);
      }
    });

    const summary = elements.debugMenu.querySelector('[data-debug-summary]');
    if (summary) {
      summary.textContent = describeDebugSelection();
    }

    const presetButtons = elements.debugMenu.querySelectorAll('[data-debug-preset]');
    presetButtons.forEach((button) => {
      const presetKey = button.getAttribute('data-debug-preset');
      button.classList.toggle('active', presetKey === getActiveDebugPresetKey());
    });
  }
}

function propagateDebugConfig(config) {
  if (window.__vdsSetDebugModeState) {
    window.__vdsSetDebugModeState(isAnyDebugEnabled(config));
  }
  if (window.__vdsSetDebugConfigState) {
    window.__vdsSetDebugConfigState(config);
  }
  if (window.electronAPI) {
    if (typeof window.electronAPI.setDebugConfig === 'function') {
      window.electronAPI.setDebugConfig(config);
    } else if (typeof window.electronAPI.setDebugMode === 'function') {
      window.electronAPI.setDebugMode(isAnyDebugEnabled(config));
    }
  }
}

function isDebugModeEnabled() {
  return isAnyDebugPathEnabled();
}

function isDebugCategoryEnabled(category = 'misc') {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, category)) {
    return false;
  }
  return Boolean(debugConfig.categories[category]);
}

function isDebugChannelEnabled(channel = 'renderer') {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CHANNEL_DEFINITIONS, channel)) {
    return false;
  }
  return Boolean(debugConfig.channels[channel]);
}

function isDebugLogEnabled(category = 'misc', channel = 'renderer', config = debugConfig) {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, category)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CHANNEL_DEFINITIONS, channel)) {
    return false;
  }

  return Boolean(config.categories && config.categories[category]) &&
    Boolean(config.channels && config.channels[channel]);
}

function isSameDebugConfig(left, right) {
  const normalizedLeft = normalizeDebugConfig(left, false);
  const normalizedRight = normalizeDebugConfig(right, false);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function getActiveDebugPresetKey(config = debugConfig) {
  return Object.keys(DEBUG_PRESET_DEFINITIONS).find((key) => (
    isSameDebugConfig(config, DEBUG_PRESET_DEFINITIONS[key].config)
  )) || '';
}

function describeDebugSelection(config = debugConfig) {
  const presetKey = getActiveDebugPresetKey(config);
  if (presetKey) {
    const preset = DEBUG_PRESET_DEFINITIONS[presetKey];
    return `当前预设：${preset.label}。${preset.description}`;
  }

  const enabledCategories = DEBUG_CATEGORY_KEYS
    .filter((key) => config.categories[key])
    .map((key) => DEBUG_CATEGORY_DEFINITIONS[key].label);
  const enabledChannels = DEBUG_CHANNEL_KEYS
    .filter((key) => config.channels[key])
    .map((key) => DEBUG_CHANNEL_DEFINITIONS[key].label);

  if (enabledCategories.length === 0 || enabledChannels.length === 0) {
    return '已自定义，但类别或通道为空，当前不会输出调试日志。';
  }

  return `自定义：${enabledCategories.length} 个类别 / ${enabledChannels.length} 个通道`;
}

function setDebugConfig(nextConfig, options = {}) {
  const { persist = true, notify = true } = options;
  debugConfig = normalizeDebugConfig(nextConfig, false);
  if (persist) {
    persistDebugConfig(debugConfig);
  }
  if (notify) {
    propagateDebugConfig(debugConfig);
  }
  syncDebugUi();
}

function readViewerPlaybackPrefs() {
  const fallback = {
    mode: VIEWER_PLAYBACK_MODES.PASSTHROUGH,
    audioDelayMs: 0
  };
  try {
    const raw = window.localStorage.getItem(VIEWER_PLAYBACK_PREFS_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    return normalizeViewerPlaybackPrefs(JSON.parse(raw));
  } catch (_error) {
    return fallback;
  }
}

function normalizeViewerPlaybackPrefs(nextPrefs) {
  const normalizedMode = VIEWER_PLAYBACK_MODES.PASSTHROUGH;
  const numericDelay = Number(nextPrefs && nextPrefs.audioDelayMs);
  const normalizedDelay = Math.max(0, Math.min(300, Number.isFinite(numericDelay) ? Math.round(numericDelay) : 0));
  return {
    mode: normalizedMode,
    audioDelayMs: normalizedDelay
  };
}

function persistViewerPlaybackPrefs() {
  try {
    window.localStorage.setItem(VIEWER_PLAYBACK_PREFS_STORAGE_KEY, JSON.stringify(viewerPlaybackPrefs));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function parseObsIngestPort(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const normalized = Math.round(numeric);
  if (normalized < OBS_INGEST_PORT_MIN || normalized > OBS_INGEST_PORT_MAX) {
    return null;
  }
  return normalized;
}

function normalizeObsIngestPort(value, fallback = DEFAULT_OBS_INGEST_PORT) {
  const parsed = parseObsIngestPort(value);
  return parsed === null ? fallback : parsed;
}

function normalizeObsIngestPrefs(nextPrefs) {
  return {
    port: normalizeObsIngestPort(nextPrefs && nextPrefs.port, DEFAULT_OBS_INGEST_PORT),
    customPortEnabled: nextPrefs && nextPrefs.customPortEnabled === true
  };
}

function readObsIngestPrefs() {
  try {
    const raw = window.localStorage.getItem(OBS_INGEST_PREFS_STORAGE_KEY);
    if (!raw) {
      return normalizeObsIngestPrefs(null);
    }
    return normalizeObsIngestPrefs(JSON.parse(raw));
  } catch (_error) {
    return normalizeObsIngestPrefs(null);
  }
}

function persistObsIngestPrefs() {
  try {
    window.localStorage.setItem(OBS_INGEST_PREFS_STORAGE_KEY, JSON.stringify({
      port: normalizeObsIngestPort(qualitySettings && qualitySettings.obsIngestPort, DEFAULT_OBS_INGEST_PORT),
      customPortEnabled: Boolean(qualitySettings && qualitySettings.obsIngestCustomPortEnabled)
    }));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function isViewerPlaybackPassthroughMode() {
  return true;
}

function isViewerJoinLocked() {
  return sessionRole === 'viewer' && Boolean(currentRoomId);
}

function renderViewerPlaybackPrefsUi() {
  if (elements.viewerPlaybackModeToggle) {
    elements.viewerPlaybackModeToggle.checked = true;
    elements.viewerPlaybackModeToggle.disabled = true;
  }
  if (elements.viewerAudioDelayControl) {
    elements.viewerAudioDelayControl.classList.remove('hidden');
  }
  if (elements.viewerAudioDelayInput) {
    elements.viewerAudioDelayInput.value = String(viewerPlaybackPrefs.audioDelayMs);
    elements.viewerAudioDelayInput.disabled = false;
  }
  if (elements.viewerAudioDelayDecrease) {
    elements.viewerAudioDelayDecrease.disabled = false;
  }
  if (elements.viewerAudioDelayIncrease) {
    elements.viewerAudioDelayIncrease.disabled = false;
  }
}

function setViewerPlaybackMode(mode) {
  viewerPlaybackPrefs = normalizeViewerPlaybackPrefs({
    ...viewerPlaybackPrefs,
    mode: VIEWER_PLAYBACK_MODES.PASSTHROUGH
  });
  persistViewerPlaybackPrefs();
  renderViewerPlaybackPrefsUi();
}

async function applyNativeViewerPlaybackPrefs({ includeMode = false } = {}) {
  if (!window.isElectron || !window.electronAPI || !window.electronAPI.mediaEngine) {
    return;
  }
  const mediaEngine = window.electronAPI.mediaEngine;
  if (includeMode && typeof mediaEngine.setViewerPlaybackMode === 'function') {
    await mediaEngine.setViewerPlaybackMode({
      mode: viewerPlaybackPrefs.mode
    });
  }
  if (typeof mediaEngine.setViewerAudioDelay === 'function') {
    await mediaEngine.setViewerAudioDelay({
      delayMs: viewerPlaybackPrefs.audioDelayMs
    });
  }
}

function setViewerAudioDelayMs(nextDelayMs, { applyNative = false } = {}) {
  viewerPlaybackPrefs = normalizeViewerPlaybackPrefs({
    ...viewerPlaybackPrefs,
    audioDelayMs: nextDelayMs
  });
  persistViewerPlaybackPrefs();
  renderViewerPlaybackPrefsUi();
  if (applyNative && sessionRole === 'viewer' && currentRoomId) {
    applyNativeViewerPlaybackPrefs({ includeMode: false }).catch((error) => {
      debugLog('audio', '[media-engine] setViewerAudioDelay failed:', error && error.message ? error.message : String(error));
    });
  }
}

function normalizeViewerJoinMode(mode) {
  return mode === 'direct' ? 'direct' : 'lobby';
}

function renderHostPublicListingUi() {
  if (!elements.hostPublicRoomEnabled) {
    return;
  }
  const isShareActive = Boolean(
    elements.btnStartShare &&
    elements.btnStartShare.classList.contains('hidden')
  );
  const isPublicRoom = Boolean(qualitySettings.publicRoomEnabled);

  elements.hostPublicRoomEnabled.checked = isPublicRoom;
  elements.hostPublicRoomEnabled.disabled = isShareActive;
  if (elements.hostPublicRoomLabel) {
    elements.hostPublicRoomLabel.classList.toggle('hidden', isShareActive);
  }
  const switchLabel = elements.hostPublicRoomEnabled.closest('.quality-switch');
  if (switchLabel) {
    switchLabel.classList.toggle('hidden', isShareActive);
  }
  if (elements.hostPublicRoomStatus) {
    elements.hostPublicRoomStatus.textContent = isPublicRoom ? '当前为公开房间' : '当前为非公开房间';
    elements.hostPublicRoomStatus.classList.toggle('hidden', !isShareActive);
  }
}

function setViewerJoinPending(pending, { source = null } = {}) {
  viewerJoinPending = Boolean(pending);
  viewerPendingJoinSource = viewerJoinPending ? source : null;
  renderViewerJoinUi();
}

function renderPublicRooms() {
  if (!elements.viewerPublicRoomsStatus || !elements.viewerPublicRoomsList) {
    return;
  }

  let statusText = '';
  if (publicRoomsRefreshInFlight && publicRooms.length === 0) {
    statusText = '正在获取公开房间...';
  } else if (publicRoomsLastError) {
    statusText = publicRoomsLastError;
  } else if (publicRooms.length === 0) {
    statusText = '当前没有公开房间';
  } else {
    statusText = `当前公开房间 ${publicRooms.length} 个`;
  }
  elements.viewerPublicRoomsStatus.textContent = statusText;

  elements.viewerPublicRoomsList.textContent = '';
  if (publicRooms.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();
  publicRooms.forEach((room) => {
    if (!room || !room.roomId) {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'viewer-public-room-button';
    button.textContent = `${String(room.roomId).toUpperCase()}·人数${Math.max(0, Number(room.viewerCount) || 0)}`;
    button.disabled = viewerJoinPending;
    button.addEventListener('click', () => {
      joinRoomById(room.roomId, { source: 'lobby' }).catch((error) => {
        showError(error && error.message ? error.message : '无法加入该房间');
      });
    });
    fragment.appendChild(button);
  });
  elements.viewerPublicRoomsList.appendChild(fragment);
}

function renderViewerJoinUi() {
  const isLobby = normalizeViewerJoinMode(viewerJoinMode) === 'lobby';

  if (elements.btnViewerJoinLobby) {
    elements.btnViewerJoinLobby.classList.toggle('is-active', isLobby);
    elements.btnViewerJoinLobby.disabled = viewerJoinPending;
  }
  if (elements.btnViewerJoinDirect) {
    elements.btnViewerJoinDirect.classList.toggle('is-active', !isLobby);
    elements.btnViewerJoinDirect.disabled = viewerJoinPending;
  }
  if (elements.btnRefreshPublicRooms) {
    elements.btnRefreshPublicRooms.classList.toggle('hidden', !isLobby);
    elements.btnRefreshPublicRooms.classList.toggle('is-refreshing', isLobby && publicRoomsRefreshInFlight);
    elements.btnRefreshPublicRooms.disabled = viewerJoinPending || publicRoomsRefreshInFlight;
  }
  if (elements.viewerPublicRoomsPanel) {
    elements.viewerPublicRoomsPanel.classList.toggle('hidden', !isLobby);
  }
  if (elements.viewerDirectJoinPanel) {
    elements.viewerDirectJoinPanel.classList.toggle('hidden', isLobby);
  }
  if (elements.roomIdInput) {
    elements.roomIdInput.disabled = viewerJoinPending;
  }
  if (elements.btnJoin) {
    elements.btnJoin.disabled = viewerJoinPending;
    elements.btnJoin.textContent = viewerJoinPending && viewerPendingJoinSource === 'direct' ? '加入中...' : '加入';
  }

  renderPublicRooms();
}

function shouldPollPublicRooms() {
  return document.body.dataset.appView === 'viewer' &&
    Boolean(elements.joinForm) &&
    !elements.joinForm.classList.contains('hidden') &&
    !Boolean(currentRoomId);
}

function stopPublicRoomsPolling() {
  if (publicRoomsPollTimer) {
    clearInterval(publicRoomsPollTimer);
    publicRoomsPollTimer = null;
  }
}

function updatePublicRoomsPollingState() {
  if (!shouldPollPublicRooms()) {
    stopPublicRoomsPolling();
    return;
  }

  if (!publicRoomsPollTimer) {
    publicRoomsPollTimer = setInterval(() => {
      refreshPublicRooms().catch(() => {});
    }, PUBLIC_ROOMS_POLL_INTERVAL_MS);
  }
}

async function refreshPublicRooms({ manual = false, force = false } = {}) {
  if (!force && publicRoomsRefreshInFlight) {
    return publicRooms;
  }

  publicRoomsRefreshInFlight = true;
  publicRoomsLastError = '';
  renderViewerJoinUi();

  try {
    const response = await fetch(`${serverBaseUrl}/api/public-rooms`, {
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    publicRooms = Array.isArray(payload && payload.rooms)
      ? payload.rooms
        .map((room) => ({
          roomId: String(room && room.roomId ? room.roomId : '').trim().toUpperCase(),
          viewerCount: Math.max(0, Number(room && room.viewerCount) || 0)
        }))
        .filter((room) => room.roomId)
      : [];
  } catch (_error) {
    publicRoomsLastError = '大厅列表暂不可用';
    if (manual) {
      showError('无法刷新公开房间列表');
    }
  } finally {
    publicRoomsRefreshInFlight = false;
    renderViewerJoinUi();
  }

  return publicRooms;
}

function setViewerJoinMode(mode) {
  viewerJoinMode = normalizeViewerJoinMode(mode);
  renderViewerJoinUi();
  updatePublicRoomsPollingState();
}

async function handleViewerJoinFailure(message) {
  const failedSource = viewerPendingJoinSource;
  await resetViewerState();
  if (failedSource === 'lobby') {
    setViewerJoinMode('lobby');
    await refreshPublicRooms({ force: true }).catch(() => {});
  } else {
    renderViewerJoinUi();
  }
  showError(message || '该房间已不存在');
}

window.__vdsHandleViewerJoinError = async (data) => {
  if (!data || data.code !== 'room-not-found') {
    return false;
  }

  const message = viewerPendingJoinSource === 'lobby'
    ? '该房间已不存在'
    : (data.message || '该房间已不存在');
  await handleViewerJoinFailure(message);
  return true;
};

window.__vdsRenderHostPublicListingUi = renderHostPublicListingUi;
window.__vdsUpdatePublicRoomsPollingState = updatePublicRoomsPollingState;
window.__vdsHandleViewerJoinSucceeded = () => {
  setViewerJoinPending(false);
  updatePublicRoomsPollingState();
};

function setDebugCategoryEnabled(category, enabled) {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, category)) {
    return;
  }
  setDebugConfig({
    ...debugConfig,
    categories: {
      ...debugConfig.categories,
      [category]: Boolean(enabled)
    }
  });
}

function setDebugChannelEnabled(channel, enabled) {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CHANNEL_DEFINITIONS, channel)) {
    return;
  }
  setDebugConfig({
    ...debugConfig,
    channels: {
      ...debugConfig.channels,
      [channel]: Boolean(enabled)
    }
  });
}

function applyDebugPreset(presetKey) {
  const preset = DEBUG_PRESET_DEFINITIONS[presetKey];
  if (!preset) {
    return;
  }

  setDebugConfig(normalizeDebugConfig(preset.config, false));
}

function handleDebugMenuInputChange(input) {
  const category = input.getAttribute('data-debug-category');
  const channel = input.getAttribute('data-debug-channel');
  if (category) {
    setDebugCategoryEnabled(category, input.checked);
    return;
  }
  if (channel) {
    setDebugChannelEnabled(channel, input.checked);
  }
}

function handleDebugMenuClick(event) {
  event.stopPropagation();
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const presetButton = target.closest('[data-debug-preset]');
  if (!(presetButton instanceof HTMLElement)) {
    return;
  }

  const presetKey = presetButton.getAttribute('data-debug-preset');
  if (presetKey) {
    applyDebugPreset(presetKey);
  }
}

function bindDebugMenuUi() {
  if (elements.btnDebugToggle) {
    elements.btnDebugToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleDebugMenu();
    });
  }

  if (!elements.debugMenu) {
    return;
  }

  elements.debugMenu.addEventListener('click', handleDebugMenuClick);
  elements.debugMenu.addEventListener('change', (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      handleDebugMenuInputChange(input);
    }
  });
}

function debugLog(category, ...args) {
  let resolvedCategory = category;
  let resolvedArgs = args;
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, resolvedCategory)) {
    resolvedArgs = [category, ...args];
    resolvedCategory = 'misc';
  }
  if (!isDebugLogEnabled(resolvedCategory, 'renderer')) {
    return;
  }
  console.log(...resolvedArgs);
}

window.__vdsIsDebugModeEnabled = isDebugModeEnabled;
window.__vdsDebugCategoryDefinitions = DEBUG_CATEGORY_DEFINITIONS;
window.__vdsDebugChannelDefinitions = DEBUG_CHANNEL_DEFINITIONS;
window.__vdsShouldDebugLog = (category = 'misc', channel = 'renderer') => isDebugLogEnabled(category, channel);
window.__vdsGetDebugConfig = () => JSON.parse(JSON.stringify(debugConfig));
window.__vdsGetViewerPlaybackPrefs = () => ({ ...viewerPlaybackPrefs });
window.__vdsRenderViewerPlaybackPrefsUi = renderViewerPlaybackPrefsUi;
window.__vdsSetDebugConfigState = (config) => {
  debugConfig = normalizeDebugConfig(config, false);
  syncDebugUi();
};
window.__vdsSetDebugModeState = (enabled) => {
  debugConfig = buildDefaultDebugConfig(Boolean(enabled));
  syncDebugUi();
};

function openDebugMenu() {
  if (!elements || !elements.debugMenu) {
    return;
  }
  elements.debugMenu.classList.remove('hidden');
  syncDebugUi();
}

function closeDebugMenu() {
  if (!elements || !elements.debugMenu) {
    return;
  }
  elements.debugMenu.classList.add('hidden');
  syncDebugUi();
}

function toggleDebugMenu() {
  if (!elements || !elements.debugMenu) {
    return;
  }
  if (elements.debugMenu.classList.contains('hidden')) {
    openDebugMenu();
  } else {
    closeDebugMenu();
  }
}

function setAppView(view) {
  document.body.dataset.appView = view;
  updatePublicRoomsPollingState();
}

function setLandingFocus(focus = 'idle') {
  document.body.dataset.landingFocus = focus || 'idle';
}

function setLandingCommit(target = 'idle') {
  document.body.dataset.landingCommit = target || 'idle';
}

function setViewTransition(state = 'idle') {
  document.body.dataset.viewTransition = state || 'idle';
}

function setWorkspaceMask(state = 'idle') {
  if (elements.workspaceTransitionMask) {
    if (state === 'host') {
      elements.workspaceTransitionMask.style.background = '#050505';
    } else if (state === 'viewer') {
      elements.workspaceTransitionMask.style.background = '#f4efe5';
    }
  }
  document.body.dataset.workspaceMask = state || 'idle';
}

function setCloseModalState(state = 'closed') {
  document.body.dataset.closeModal = state || 'closed';
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function prewarmWorkspacePanels() {
  document.body.classList.add('workspace-prewarm');
  elements.hostPanel.classList.remove('hidden');
  elements.viewerPanel.classList.remove('hidden');
  await nextPaint();
  elements.hostPanel.getBoundingClientRect();
  elements.viewerPanel.getBoundingClientRect();
  elements.hostPanel.offsetHeight;
  elements.viewerPanel.offsetHeight;
  elements.hostPanel.classList.add('hidden');
  elements.viewerPanel.classList.add('hidden');
  document.body.classList.remove('workspace-prewarm');
}

function prepareWorkspacePanel(panel) {
  if (!panel) {
    return;
  }
  panel.classList.remove('hidden');
  panel.classList.add('workspace-panel-preparing');
}

function releaseWorkspacePanel(panel) {
  if (!panel) {
    return;
  }
  panel.classList.remove('workspace-panel-preparing');
}

async function transitionToWorkspace(target) {
  const isHostTarget = target === 'host';
  const targetPanel = isHostTarget ? elements.hostPanel : elements.viewerPanel;
  const otherPanel = isHostTarget ? elements.viewerPanel : elements.hostPanel;
  setLandingFocus('idle');
  setLandingCommit(target);
  prepareWorkspacePanel(targetPanel);
  await nextPaint();
  targetPanel.getBoundingClientRect();
  targetPanel.offsetHeight;
  await waitMs(LANDING_TRANSITION_MS);

  setWorkspaceMask(target);
  await nextPaint();
  otherPanel.classList.add('hidden');
  elements.modeSelect.classList.add('hidden');
  setAppView(target);
  setViewTransition(`${target}-enter`);
  await nextPaint();
  releaseWorkspacePanel(targetPanel);
  await nextPaint();
  await waitMs(WORKSPACE_MASK_MS);
  setWorkspaceMask('idle');
  setViewTransition('idle');
  await waitMs(Math.max(PANEL_TRANSITION_MS - WORKSPACE_MASK_MS, 0));
  setLandingCommit('idle');
}

async function transitionToHome(from) {
  const panel = from === 'host' ? elements.hostPanel : elements.viewerPanel;
  setLandingFocus('idle');
  setLandingCommit(from);
  elements.modeSelect.classList.remove('hidden');
  setWorkspaceMask(from);
  setViewTransition(`${from}-exit`);
  await waitMs(PANEL_TRANSITION_MS);
  panel.classList.add('hidden');
  setAppView('home');
  setViewTransition('idle');
  await nextPaint();
  setWorkspaceMask('idle');
  await nextPaint();
  setLandingFocus('idle');
  setLandingCommit('idle');
  await waitMs(LANDING_TRANSITION_MS);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

function normalizeIceUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

  // `?transport=` is valid for turn/turns URLs but not for stun URLs.
  const lowered = value.toLowerCase();
  if (lowered.startsWith('turn:') || lowered.startsWith('turns:')) {
    return null;
  }

  if (lowered.startsWith('stun:')) {
    return value.replace(/\?.*$/, '');
  }

  return null;
}

function sanitizeIceServers(servers) {
  if (!Array.isArray(servers)) {
    return [];
  }

  return servers
    .map((server) => {
      if (!server || !server.urls) {
        return null;
      }

      const urls = Array.isArray(server.urls)
        ? server.urls.map(normalizeIceUrl).filter(Boolean)
        : normalizeIceUrl(server.urls);

      if ((Array.isArray(urls) && urls.length === 0) || (!Array.isArray(urls) && !urls)) {
        return null;
      }

      return { urls };
    })
    .filter(Boolean);
}

function toWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function ensureRuntimeConnectionConfig() {
  if (runtimeConnectionConfigPromise) {
    return runtimeConnectionConfigPromise;
  }

  runtimeConnectionConfigPromise = (async () => {
    try {
      const response = await fetch(`${serverBaseUrl}/api/config`, {
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        config.iceServers = sanitizeIceServers(data.iceServers);
      }
    } catch (error) {
      debugLog('connection', 'Using bundled ICE configuration:', error.message);
    }

    return config;
  })();

  return runtimeConnectionConfigPromise;
}

function getNativeAuthorityOverride(name, currentImpl) {
  if (!window.__vdsNativeAuthorityOverridesInstalled) {
    return null;
  }

  const candidate = window[name];
  if (typeof candidate !== 'function') {
    return null;
  }

  if (candidate === currentImpl) {
    return null;
  }

  return candidate;
}

function requireNativeAuthorityOverride(name, currentImpl) {
  const override = getNativeAuthorityOverride(name, currentImpl);
  if (!override) {
    throw new Error(`native-authority-override-missing:${name}`);
  }
  return override;
}

function queueRemoteCandidate(peerId, candidate) {
  if (!peerId || !candidate) {
    return;
  }
  if (!pendingRemoteCandidates.has(peerId)) {
    pendingRemoteCandidates.set(peerId, []);
  }
  const queued = pendingRemoteCandidates.get(peerId);
  const candidateKey = typeof candidate === 'string'
    ? candidate
    : JSON.stringify({
        candidate: candidate.candidate || '',
        sdpMid: candidate.sdpMid || '',
        sdpMLineIndex: Number.isFinite(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null
      });
  const duplicate = queued.some((entry) => {
    const entryKey = typeof entry === 'string'
      ? entry
      : JSON.stringify({
          candidate: entry.candidate || '',
          sdpMid: entry.sdpMid || '',
          sdpMLineIndex: Number.isFinite(entry.sdpMLineIndex) ? entry.sdpMLineIndex : null
        });
    return entryKey === candidateKey;
  });
  if (duplicate) {
    return;
  }

  queued.push(candidate);
  while (queued.length > MAX_PENDING_REMOTE_CANDIDATES_PER_PEER) {
    queued.shift();
  }
}

function clearPeerReconnect(peerId) {
  const state = peerReconnectState.get(peerId);
  if (state && state.timerId) {
    clearTimeout(state.timerId);
  }
  peerReconnectState.delete(peerId);
}

function clearPeerConnectionTimeout(peerId) {
  const meta = peerConnectionMeta.get(peerId);
  if (meta && meta.connectTimeoutId) {
    clearTimeout(meta.connectTimeoutId);
    meta.connectTimeoutId = null;
  }
}

function clearPeerDisconnectTimer(peerId) {
  const meta = peerConnectionMeta.get(peerId);
  if (meta && meta.disconnectTimerId) {
    clearTimeout(meta.disconnectTimerId);
    meta.disconnectTimerId = null;
  }
}

function closePeerConnection(peerId, options = {}) {
  return requireNativeAuthorityOverride('closePeerConnection', closePeerConnection)(peerId, options);
}

function clearAllPeerConnections(options = {}) {
  return requireNativeAuthorityOverride('clearAllPeerConnections', clearAllPeerConnections)(options);
}

function setViewerConnectionState(message) {
  return requireNativeAuthorityOverride('setViewerConnectionState', setViewerConnectionState)(message);
}

async function resetViewerMediaPipeline(message = '等待重新连接...') {
  upstreamConnected = false;
  viewerReadySent = false;
  videoStarted = false;
  relayStream = null;
  relayPc = null;
  await clearAllPeerConnections({ clearRetryState: true });
  elements.remoteVideo.srcObject = null;
  if (elements.viewerReceiveFps) {
    elements.viewerReceiveFps.textContent = '-';
  }
  if (elements.viewerRenderFps) {
    elements.viewerRenderFps.textContent = '-';
  }
  setViewerConnectionState(message);
}

// DOM元素
const elements = {
  btnDebugToggle: document.getElementById('btn-debug-toggle'),
  debugMenu: document.getElementById('debug-menu'),
  modeSelect: document.getElementById('mode-select'),
  workspaceTransitionMask: document.getElementById('workspace-transition-mask'),
  hostPanel: document.getElementById('host-panel'),
  viewerPanel: document.getElementById('viewer-panel'),
  btnHost: document.getElementById('btn-host'),
  btnViewer: document.getElementById('btn-viewer'),
  btnStartShare: document.getElementById('btn-start-share'),
  btnStopShare: document.getElementById('btn-stop-share'),
  hostPublicRoomLabel: document.getElementById('host-public-room-label'),
  hostPublicRoomEnabled: document.getElementById('host-public-room-enabled'),
  hostPublicRoomStatus: document.getElementById('host-public-room-status'),
  btnJoin: document.getElementById('btn-join'),
  btnLeave: document.getElementById('btn-leave'),
  btnBack: document.getElementById('btn-back'),
  btnBackViewer: document.getElementById('btn-back-viewer'),
  btnCopyRoom: document.getElementById('btn-copy-room'),
  btnViewerJoinLobby: document.getElementById('btn-viewer-join-lobby'),
  btnViewerJoinDirect: document.getElementById('btn-viewer-join-direct'),
  btnRefreshPublicRooms: document.getElementById('btn-refresh-public-rooms'),
  roomInfo: document.getElementById('room-info'),
  roomIdDisplay: document.getElementById('room-id-display'),
  roomIdInput: document.getElementById('room-id-input'),
  viewerCount: document.getElementById('viewer-count'),
  viewerRoomId: document.getElementById('viewer-room-id'),
  viewerStatus: document.getElementById('viewer-status'),
  viewerPublicRoomsPanel: document.getElementById('viewer-public-rooms-panel'),
  viewerDirectJoinPanel: document.getElementById('viewer-direct-join-panel'),
  viewerPublicRoomsStatus: document.getElementById('viewer-public-rooms-status'),
  viewerPublicRoomsList: document.getElementById('viewer-public-rooms-list'),
  viewerPlaybackModeToggle: document.getElementById('viewer-playback-mode-toggle'),
  viewerAudioDelayControl: document.getElementById('viewer-audio-delay-control'),
  viewerAudioDelayInput: document.getElementById('viewer-audio-delay-input'),
  viewerAudioDelayDecrease: document.getElementById('viewer-audio-delay-decrease'),
  viewerAudioDelayIncrease: document.getElementById('viewer-audio-delay-increase'),
  connectionStatus: document.getElementById('connection-status'),
  chainPosition: document.getElementById('chain-position'),
  viewerReceiveFps: document.getElementById('viewer-receive-fps'),
  viewerRenderFps: document.getElementById('viewer-render-fps'),
  hostStatus: document.getElementById('host-status'),
  hostStatusDetail: document.getElementById('host-status-detail'),
  hostSourceFps: document.getElementById('host-source-fps'),
  hostCaptureFps: document.getElementById('host-capture-fps'),
  hostSendFps: document.getElementById('host-send-fps'),
  localVideo: document.getElementById('local-video'),
  remoteVideo: document.getElementById('remote-video'),
  remoteVideoContainer: document.getElementById('remote-video-container'),
  waitingMessage: document.getElementById('waiting-message'),
  errorToast: document.getElementById('error-toast'),
  joinForm: document.getElementById('join-form'),
  sourceModal: document.getElementById('source-modal'),
  sourceList: document.getElementById('source-list'),
  btnConfirmSource: document.getElementById('btn-confirm-source'),
  btnCancelSource: document.getElementById('btn-cancel-source'),
  btnRefreshSources: document.getElementById('btn-refresh-sources'),
  sourceAudioEnabled: document.getElementById('source-audio-enabled'),
  sourceAudioSummary: document.getElementById('source-audio-summary'),
  sourceAudioProcessList: document.getElementById('source-audio-process-list'),
  // 画质设置弹窗
  qualityModal: document.getElementById('quality-modal'),
  qualityBackendOptions: document.getElementById('quality-backend-options'),
  qualityNativePanel: document.getElementById('quality-native-panel'),
  qualityObsPanel: document.getElementById('quality-obs-panel'),
  qualityCodecOptions: document.getElementById('quality-codec-options'),
  qualityCodecNote: document.getElementById('quality-codec-note'),
  qualityPreviewEnabled: document.getElementById('quality-preview-enabled'),
  qualityResolutionOptions: document.getElementById('quality-resolution-options'),
  qualityFpsOptions: document.getElementById('quality-fps-options'),
  qualityBitrate: document.getElementById('quality-bitrate'),
  qualityBitrateDecrease: document.getElementById('quality-bitrate-decrease'),
  qualityBitrateIncrease: document.getElementById('quality-bitrate-increase'),
  qualityHardwareAcceleration: document.getElementById('quality-hardware-acceleration'),
  qualityHardwareSupport: document.getElementById('quality-hardware-support'),
  qualityHardwareEncoderSelect: document.getElementById('quality-hardware-encoder-select'),
  qualityPresetOptions: document.getElementById('quality-preset-options'),
  qualityPresetNote: document.getElementById('quality-preset-note'),
  qualityTuneOptions: document.getElementById('quality-tune-options'),
  qualityKeyframeOptions: document.getElementById('quality-keyframe-options'),
  qualityObsCustomPortEnabled: document.getElementById('quality-obs-custom-port-enabled'),
  qualityObsCustomPortRow: document.getElementById('quality-obs-custom-port-row'),
  qualityObsPort: document.getElementById('quality-obs-port'),
  qualityObsUrl: document.getElementById('quality-obs-url'),
  qualityObsStatus: document.getElementById('quality-obs-status'),
  btnSaveObsPort: document.getElementById('btn-save-obs-port'),
  btnConfirmQuality: document.getElementById('btn-confirm-quality'),
  btnCancelQuality: document.getElementById('btn-cancel-quality'),
  // 更新进度弹窗
  updateModal: document.getElementById('update-modal'),
  updateTitle: document.getElementById('update-title'),
  updateStep: document.getElementById('update-step'),
  updateDetail: document.getElementById('update-detail'),
  updateProgressContainer: document.getElementById('update-progress-container'),
  updateProgress: document.getElementById('update-progress'),
  updatePercent: document.getElementById('update-percent'),
  updateSpeed: document.getElementById('update-speed'),
  updateTransferred: document.getElementById('update-transferred'),
  updateTime: document.getElementById('update-time'),
  updateActions: document.getElementById('update-actions'),
  btnCloseUpdate: document.getElementById('btn-close-update'),
  btnInstallUpdate: document.getElementById('btn-install-update'),
  // 标题栏按钮
  btnMinimize: document.getElementById('btn-minimize'),
  btnMaximize: document.getElementById('btn-maximize'),
  btnClose: document.getElementById('btn-close'),
  // 关闭确认弹窗
  closeModal: document.getElementById('close-modal'),
  btnCloseModalDismiss: document.getElementById('btn-close-modal-dismiss'),
  btnMinimizeToTray: document.getElementById('btn-minimize-to-tray'),
  btnExitApp: document.getElementById('btn-exit-app'),
  // 标题栏元素
  titleBar: document.querySelector('.title-bar')
};

function getResolutionPreset(value) {
  return QUALITY_RESOLUTION_OPTIONS.find((option) => option.value === value) || QUALITY_RESOLUTION_OPTIONS[3];
}

function setQualityResolutionPreset(value) {
  const preset = getResolutionPreset(value);
  qualitySettings.resolutionPreset = preset.value;
  qualitySettings.width = preset.width;
  qualitySettings.height = preset.height;
}

function setQualityBitrate(value) {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : qualitySettings.bitrate;
  const stepped = Math.round(safeValue / QUALITY_BITRATE_STEP) * QUALITY_BITRATE_STEP;
  qualitySettings.bitrate = Math.max(QUALITY_BITRATE_MIN, Math.min(QUALITY_BITRATE_MAX, stepped));
}

function normalizeHostBackend(value) {
  return String(value || '').trim().toLowerCase() === 'obs-ingest' ? 'obs-ingest' : 'native';
}

function getSelectedHostBackend() {
  return normalizeHostBackend(qualitySettings.hostBackend || 'native');
}

function isObsIngestCustomPortEnabled() {
  return Boolean(qualitySettings.obsIngestCustomPortEnabled);
}

function setObsIngestCustomPortEnabled(enabled, options = {}) {
  const { persist = true } = options;
  qualitySettings.obsIngestCustomPortEnabled = Boolean(enabled);
  if (persist) {
    persistObsIngestPrefs();
  }
  return qualitySettings.obsIngestCustomPortEnabled;
}

function getSelectedObsIngestPort() {
  return normalizeObsIngestPort(qualitySettings.obsIngestPort, DEFAULT_OBS_INGEST_PORT);
}

function getEffectiveObsIngestPort() {
  return isObsIngestCustomPortEnabled()
    ? getSelectedObsIngestPort()
    : DEFAULT_OBS_INGEST_PORT;
}

function setSelectedObsIngestPort(value, options = {}) {
  const { persist = true } = options;
  qualitySettings.obsIngestPort = normalizeObsIngestPort(value, DEFAULT_OBS_INGEST_PORT);
  if (persist) {
    persistObsIngestPrefs();
  }
  return qualitySettings.obsIngestPort;
}

function commitObsIngestPortInput() {
  if (!elements.qualityObsPort) {
    return getSelectedObsIngestPort();
  }
  const rawValue = String(elements.qualityObsPort.value || '').trim();
  const parsed = parseObsIngestPort(rawValue);
  if (parsed === null) {
    elements.qualityObsPort.value = String(getSelectedObsIngestPort());
    throw new Error(`请输入 ${OBS_INGEST_PORT_MIN}-${OBS_INGEST_PORT_MAX} 之间的端口`);
  }
  return setSelectedObsIngestPort(parsed);
}

function getObsIngestPortForPrepare(requestedPort = null) {
  if (requestedPort != null) {
    return normalizeObsIngestPort(requestedPort, DEFAULT_OBS_INGEST_PORT);
  }
  return getEffectiveObsIngestPort();
}

function buildObsIngestPublishUrl(port) {
  const normalizedPort = normalizeObsIngestPort(port, DEFAULT_OBS_INGEST_PORT);
  return `srt://127.0.0.1:${normalizedPort}?mode=caller&transtype=live`;
}

function isObsHostBackendAvailable() {
  const hostBackends = qualityCapabilities && Array.isArray(qualityCapabilities.hostBackends)
    ? qualityCapabilities.hostBackends.map((value) => String(value || '').trim().toLowerCase())
    : [];
  if (hostBackends.length === 0) {
    return true;
  }
  return hostBackends.includes('obs-ingest');
}

function buildHostBackendOptions() {
  return [
    { value: 'native', label: '原生推流' },
    {
      value: 'obs-ingest',
      label: 'OBS 推流',
      disabled: !isObsHostBackendAvailable()
    }
  ];
}

async function prepareObsIngestPreview(forceRefresh = false, requestedPort = null) {
  if (!window.isElectron || !window.electronAPI || !window.electronAPI.mediaEngine) {
    obsIngestPreview = {
      prepared: false,
      port: getSelectedObsIngestPort(),
      url: '',
      lastError: '当前环境不支持 OBS 本地推流接入'
    };
    renderQualitySettingsUi();
    return obsIngestPreview;
  }

  const mediaEngine = window.electronAPI.mediaEngine;
  if (typeof mediaEngine.prepareObsIngest !== 'function') {
    obsIngestPreview = {
      prepared: false,
      port: getSelectedObsIngestPort(),
      url: '',
      lastError: '当前构建未启用 OBS ingest'
    };
    renderQualitySettingsUi();
    return obsIngestPreview;
  }

  const targetPort = getObsIngestPortForPrepare(requestedPort);
  if (requestedPort != null && isObsIngestCustomPortEnabled()) {
    setSelectedObsIngestPort(targetPort);
  }

  if (
    !forceRefresh &&
    obsIngestPreview &&
    obsIngestPreview.prepared &&
    obsIngestPreview.url &&
    Number(obsIngestPreview.port) === targetPort
  ) {
    return obsIngestPreview;
  }

  if (obsIngestPreparePromise && !forceRefresh && obsIngestPrepareRequestPort === targetPort) {
    return obsIngestPreparePromise;
  }

  const request = (async () => {
    try {
      const result = await mediaEngine.prepareObsIngest({
        refresh: Boolean(forceRefresh),
        port: targetPort
      });
      obsIngestPreview = result && result.obsIngest
        ? result.obsIngest
        : (result || null);
      if (obsIngestPreview && Number(obsIngestPreview.port) > 0) {
        setSelectedObsIngestPort(Number(obsIngestPreview.port));
      }
      return obsIngestPreview;
    } catch (error) {
      obsIngestPreview = {
        prepared: false,
        port: targetPort,
        url: '',
        lastError: error && error.message ? error.message : String(error)
      };
      throw error;
    } finally {
      renderQualitySettingsUi();
    }
  })();

  obsIngestPreparePromise = request;
  obsIngestPrepareRequestPort = targetPort;
  try {
    return await request;
  } finally {
    if (obsIngestPreparePromise === request) {
      obsIngestPreparePromise = null;
      obsIngestPrepareRequestPort = 0;
      renderQualitySettingsUi();
    }
  }
}

async function copyObsIngestUrl() {
  const port = isObsIngestCustomPortEnabled()
    ? commitObsIngestPortInput()
    : DEFAULT_OBS_INGEST_PORT;
  const preview = (obsIngestPreview && obsIngestPreview.url && Number(obsIngestPreview.port) === port)
    ? obsIngestPreview
    : await prepareObsIngestPreview(false, port);
  const url = preview && preview.url ? String(preview.url) : '';
  if (!url) {
    throw new Error('OBS 推流地址尚未准备完成');
  }
  await copyTextToClipboard(url, {
    successMessage: 'OBS 推流地址已复制',
    failureMessage: '复制 OBS 推流地址失败'
  });
}

async function writeTextToClipboard(text) {
  const value = String(text || '');
  if (!value) {
    throw new Error('clipboard-text-empty');
  }

  if (
    window.isElectron &&
    window.electronAPI &&
    typeof window.electronAPI.writeClipboardText === 'function'
  ) {
    await window.electronAPI.writeClipboardText(value);
    return;
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand('copy');
    if (!copied) {
      throw new Error('clipboard-write-failed');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyTextToClipboard(text, {
  successMessage = '',
  failureMessage = '',
  showSuccessToast = true,
  showFailureToast = true
} = {}) {
  try {
    await writeTextToClipboard(text);
    if (showSuccessToast && successMessage) {
      showError(successMessage);
    }
    return true;
  } catch (error) {
    if (showFailureToast && failureMessage) {
      showError(failureMessage);
    }
    throw error;
  }
}

function getRequestedCodecPreference() {
  return qualitySettings.codecPreference === 'h265' ? 'h265' : 'h264';
}

function getEffectiveCodecPreference() {
  return getRequestedCodecPreference();
}

function getEnumeratedVideoEncoders() {
  const ffmpegCapabilities = qualityCapabilities && qualityCapabilities.ffmpeg
    ? qualityCapabilities.ffmpeg
    : null;
  const encoders = ffmpegCapabilities && Array.isArray(ffmpegCapabilities.videoEncoders)
    ? ffmpegCapabilities.videoEncoders
    : [];
  return encoders.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function getValidatedVideoEncoders() {
  const ffmpegCapabilities = qualityCapabilities && qualityCapabilities.ffmpeg
    ? qualityCapabilities.ffmpeg
    : null;
  const encoders = ffmpegCapabilities && Array.isArray(ffmpegCapabilities.validatedVideoEncoders)
    ? ffmpegCapabilities.validatedVideoEncoders
    : [];
  return encoders.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function getAvailableVideoEncoders() {
  const validatedEncoders = getValidatedVideoEncoders();
  return validatedEncoders.length > 0 ? validatedEncoders : getEnumeratedVideoEncoders();
}

function getLaunchableVideoEncoders() {
  return getAvailableVideoEncoders();
}

function filterHardwareVideoEncoders(encoders) {
  return (encoders || []).filter((encoder) => QUALITY_HARDWARE_ENCODER_PATTERN.test(encoder));
}

function getHardwareVideoEncoders() {
  return filterHardwareVideoEncoders(getAvailableVideoEncoders());
}

function getVideoEncoderProbes() {
  const ffmpegCapabilities = qualityCapabilities && qualityCapabilities.ffmpeg
    ? qualityCapabilities.ffmpeg
    : null;
  const probes = ffmpegCapabilities && Array.isArray(ffmpegCapabilities.videoEncoderProbes)
    ? ffmpegCapabilities.videoEncoderProbes
    : [];
  return probes
    .filter((probe) => probe && typeof probe === 'object')
    .map((probe) => ({
      name: String(probe.name || '').trim(),
      validated: probe.validated === true,
      hardware: probe.hardware === true,
      priority: Number.isFinite(Number(probe.priority)) ? Number(probe.priority) : 999,
      reason: String(probe.reason || '').trim(),
      error: String(probe.error || '').trim()
    }))
    .filter((probe) => probe.name);
}

function getAvailableH265VideoEncoders() {
  return getAvailableVideoEncoders().filter((encoder) => /(?:265|hevc)/i.test(encoder));
}

function getHardwareH265VideoEncoders() {
  return getAvailableH265VideoEncoders().filter((encoder) => QUALITY_HARDWARE_ENCODER_PATTERN.test(encoder));
}

function filterCodecEncoders(encoders, codec) {
  const normalizedCodec = codec === 'h265' ? 'h265' : 'h264';
  return (encoders || []).filter((encoder) => {
    const lowered = String(encoder || '').toLowerCase();
    if (normalizedCodec === 'h265') {
      return /(?:265|hevc)/i.test(lowered);
    }
    return /264/i.test(lowered) && !/(?:265|hevc)/i.test(lowered);
  });
}

function getValidatedHardwareEncoderProbes(codecPreference = getEffectiveCodecPreference()) {
  const codec = codecPreference === 'h265' ? 'h265' : 'h264';
  return getVideoEncoderProbes()
    .filter((probe) => probe.validated && probe.hardware)
    .filter((probe) => filterCodecEncoders([probe.name], codec).length > 0)
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.name.localeCompare(right.name);
    });
}

function getSelectedHardwareEncoderPreference() {
  const value = String(qualitySettings.hardwareEncoderPreference || 'auto').trim().toLowerCase();
  return value || 'auto';
}

function getHardwareEncoderSelectOptions(codecPreference = getEffectiveCodecPreference()) {
  const probes = getValidatedHardwareEncoderProbes(codecPreference);
  const options = [{ value: 'auto', label: '自动选择' }];
  probes.forEach((probe, index) => {
    options.push({
      value: probe.name,
      label: `${probe.name}（可用 ${index + 1}）`
    });
  });
  return options;
}

function getManualHardwareEncoder(codecPreference = getEffectiveCodecPreference()) {
  if (!qualitySettings.hardwareAcceleration) {
    return '';
  }
  const selected = getSelectedHardwareEncoderPreference();
  if (selected === 'auto') {
    return '';
  }
  const options = getHardwareEncoderSelectOptions(codecPreference);
  return options.some((option) => option.value === selected) ? selected : '';
}

function isH265CodecAvailable() {
  return getAvailableH265VideoEncoders().length > 0;
}

function buildCodecOptions() {
  return QUALITY_CODEC_OPTIONS.map((option) => {
    if (option.value !== 'h265') {
      return option;
    }
    if (isH265CodecAvailable()) {
      return option;
    }
    return {
      ...option,
      disabled: true,
      badge: 'unavailable'
    };
  });
}

function getLikelyVideoEncoder(codecPreference, hardwareAcceleration) {
  const codec = codecPreference === 'h265' ? 'h265' : 'h264';
  const manualHardwareEncoder = getManualHardwareEncoder(codec);
  if (hardwareAcceleration && manualHardwareEncoder) {
    return manualHardwareEncoder;
  }
  const availableEncoders = getLaunchableVideoEncoders();
  if (availableEncoders.length === 0) {
    return '';
  }

  const preferredEncoders = codec === 'h265'
    ? (hardwareAcceleration
      ? ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'hevc_d3d12va', 'hevc_mf', 'libx265']
      : ['libx265'])
    : (hardwareAcceleration
      ? ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_d3d12va', 'h264_mf', 'libx264', 'libopenh264']
      : ['libx264', 'libopenh264']);

  return preferredEncoders.find((encoder) => availableEncoders.includes(encoder)) || '';
}

function getPresetMappingForEncoder(encoderName) {
  const encoder = String(encoderName || '').toLowerCase();
  if (!encoder) {
    return null;
  }

  if (encoder.includes('_nvenc')) {
    return { quality: 'p7', balanced: 'p4', speed: 'p1' };
  }

  if (encoder.includes('_amf')) {
    return { quality: 'quality', balanced: 'balanced', speed: 'speed' };
  }

  if (encoder.startsWith('libx264') || encoder.startsWith('libx265')) {
    return { quality: 'slow', balanced: 'medium', speed: 'ultrafast' };
  }

  return null;
}

function buildCodecNoteText() {
  const requestedCodec = getRequestedCodecPreference();
  const effectiveCodec = getEffectiveCodecPreference();
  const likelyEncoder = getLikelyVideoEncoder(effectiveCodec, qualitySettings.hardwareAcceleration);
  const availableH265Encoders = getAvailableH265VideoEncoders();
  const hardwareH265Encoders = getHardwareH265VideoEncoders();

  if (requestedCodec === 'h265') {
    if (availableH265Encoders.length === 0) {
      return '当前设备未检测到可用的 H.265 编码器，H.265 选项会保持禁用。';
    }
    if (!qualitySettings.hardwareAcceleration) {
      return likelyEncoder
        ? `当前预计使用 ${likelyEncoder}。H.265 可用，已关闭硬件加速，将走软件编码。`
        : 'H.265 可用，已关闭硬件加速，将走软件编码。';
    }
    if (hardwareH265Encoders.length > 0) {
      return likelyEncoder
        ? `当前预计使用 ${likelyEncoder}。检测到 HEVC 硬件编码器：${hardwareH265Encoders.join('、')}。`
        : `检测到 HEVC 硬件编码器：${hardwareH265Encoders.join('、')}。`;
    }
    return likelyEncoder
      ? `当前预计使用 ${likelyEncoder}。H.265 可用，但未检测到 HEVC 硬件编码器，将走软件编码。`
      : 'H.265 可用，但未检测到 HEVC 硬件编码器，将走软件编码。';
  }

  if (likelyEncoder) {
    return `当前预计使用 ${likelyEncoder}。`;
  }

  if (!qualitySettings.hardwareAcceleration && getAvailableVideoEncoders().length > 0) {
    return '关闭硬件加速后未检测到可用的软件编码器，当前配置可能无法启动。';
  }

  return '当前直播链路将按所选编码启动。';
}

function buildHardwareSupportText() {
  const requestedCodec = getRequestedCodecPreference();
  const manualHardwareEncoder = getManualHardwareEncoder(requestedCodec);
  const availableHardwareEncoders = getHardwareVideoEncoders();
  const enumeratedHardwareEncoders = filterHardwareVideoEncoders(getEnumeratedVideoEncoders());
  const relevantHardwareEncoders = requestedCodec === 'h265'
    ? getHardwareH265VideoEncoders()
    : availableHardwareEncoders.filter((encoder) => /264/i.test(encoder) && !/(?:265|hevc)/i.test(encoder));
  const enumeratedRelevantHardwareEncoders = filterCodecEncoders(enumeratedHardwareEncoders, requestedCodec);
  const unvalidatedRelevantHardwareEncoders = enumeratedRelevantHardwareEncoders
    .filter((encoder) => !relevantHardwareEncoders.includes(encoder));
  const otherHardwareEncoders = availableHardwareEncoders.filter((encoder) => !relevantHardwareEncoders.includes(encoder));

  if (!qualityCapabilitiesChecked && window.isElectron && window.electronAPI && window.electronAPI.mediaEngine) {
    return '正在检测设备支持的硬件编码器…';
  }

  const selectedText = manualHardwareEncoder ? `手动指定：${manualHardwareEncoder}；` : '';

  if (requestedCodec === 'h265') {
    if (relevantHardwareEncoders.length > 0) {
      const prefix = '设备支持的硬件编码器：';
      const suffix = unvalidatedRelevantHardwareEncoders.length > 0
        ? `；未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`
        : '';
      return `${selectedText}${prefix}${relevantHardwareEncoders.join('、')}${suffix}`;
    }
    if (unvalidatedRelevantHardwareEncoders.length > 0) {
      return `${selectedText}未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`;
    }
    if (otherHardwareEncoders.length > 0) {
      return `${selectedText}设备支持的其他硬件编码器：${otherHardwareEncoders.join('、')}`;
    }
    return `${selectedText}未检测到可用的硬件编码器。`;
  }

  if (relevantHardwareEncoders.length === 0) {
    if (unvalidatedRelevantHardwareEncoders.length > 0) {
      return `${selectedText}未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`;
    }
    return `${selectedText}未检测到可用的硬件编码器。`;
  }

  const prefix = '设备支持的硬件编码器：';
  const suffix = unvalidatedRelevantHardwareEncoders.length > 0
    ? `；未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`
    : '';
  return `${selectedText}${prefix}${relevantHardwareEncoders.join('、')}${suffix}`;
}

function buildPresetNoteText() {
  const likelyEncoder = getLikelyVideoEncoder(getEffectiveCodecPreference(), qualitySettings.hardwareAcceleration);
  const mapping = getPresetMappingForEncoder(likelyEncoder);
  if (mapping) {
    return `预计编码器：${likelyEncoder}。质量→${mapping.quality}，均衡→${mapping.balanced}，速度→${mapping.speed}。`;
  }

  if (likelyEncoder) {
    return `预计编码器：${likelyEncoder}。当前编码器不暴露固定三挡预设，将按低延迟默认参数处理。`;
  }

  if (!qualitySettings.hardwareAcceleration && getAvailableVideoEncoders().length > 0) {
    return '关闭硬件加速后未检测到可用的软件编码器，预设参数当前不会生效。';
  }

  return '默认均衡，将按实际编码器映射到对应预设。';
}

function buildSegmentGroupMarkup(options, activeValue) {
  return options.map((option) => {
    const value = String(option.value);
    const active = String(activeValue) === value;
    const disabled = Boolean(option.disabled);
    return `
      <span class="quality-segment-item">
        <button
          type="button"
          class="quality-segment-btn${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}"
          data-value="${value}"
          ${disabled ? 'disabled' : ''}
          aria-pressed="${active ? 'true' : 'false'}"
          aria-disabled="${disabled ? 'true' : 'false'}"
        >${option.label}</button>
        ${option.badge ? `<span class="quality-segment-badge">${option.badge}</span>` : ''}
      </span>
    `;
  }).join('');
}

function renderQualitySettingsUi() {
  if (!elements.qualityModal) {
    return;
  }

  if (getSelectedHostBackend() === 'obs-ingest' && !isObsHostBackendAvailable()) {
    qualitySettings.hostBackend = 'native';
  }

  if (qualitySettings.codecPreference === 'h265' && !isH265CodecAvailable()) {
    qualitySettings.codecPreference = 'h264';
  }

  setQualityResolutionPreset(qualitySettings.resolutionPreset);
  setQualityBitrate(qualitySettings.bitrate);
  setSelectedObsIngestPort(qualitySettings.obsIngestPort, { persist: false });
  setObsIngestCustomPortEnabled(qualitySettings.obsIngestCustomPortEnabled, { persist: false });

  if (elements.qualityBackendOptions) {
    elements.qualityBackendOptions.innerHTML = buildSegmentGroupMarkup(
      buildHostBackendOptions(),
      getSelectedHostBackend()
    );
  }

  if (elements.qualityNativePanel) {
    elements.qualityNativePanel.classList.toggle('hidden', getSelectedHostBackend() !== 'native');
  }

  if (elements.qualityObsPanel) {
    elements.qualityObsPanel.classList.toggle('hidden', getSelectedHostBackend() !== 'obs-ingest');
  }

  if (elements.qualityCodecOptions) {
    elements.qualityCodecOptions.innerHTML = buildSegmentGroupMarkup(
      buildCodecOptions(),
      qualitySettings.codecPreference
    );
  }

  if (elements.qualityResolutionOptions) {
    elements.qualityResolutionOptions.innerHTML = buildSegmentGroupMarkup(
      QUALITY_RESOLUTION_OPTIONS,
      qualitySettings.resolutionPreset
    );
  }

  if (elements.qualityFpsOptions) {
    elements.qualityFpsOptions.innerHTML = buildSegmentGroupMarkup(
      QUALITY_FPS_OPTIONS,
      String(qualitySettings.frameRate)
    );
  }

  if (elements.qualityPresetOptions) {
    elements.qualityPresetOptions.innerHTML = buildSegmentGroupMarkup(
      QUALITY_PRESET_OPTIONS,
      qualitySettings.encoderPreset
    );
  }

  if (elements.qualityTuneOptions) {
    elements.qualityTuneOptions.innerHTML = buildSegmentGroupMarkup(
      QUALITY_TUNE_OPTIONS,
      qualitySettings.encoderTune
    );
  }

  if (elements.qualityKeyframeOptions) {
    elements.qualityKeyframeOptions.innerHTML = buildSegmentGroupMarkup(
      QUALITY_KEYFRAME_OPTIONS,
      qualitySettings.keyframePolicy || '1s'
    );
  }

  if (elements.qualityBitrate) {
    elements.qualityBitrate.value = String(qualitySettings.bitrate);
  }

  if (elements.qualityHardwareAcceleration) {
    elements.qualityHardwareAcceleration.checked = Boolean(qualitySettings.hardwareAcceleration);
  }

  if (elements.qualityPreviewEnabled) {
    elements.qualityPreviewEnabled.checked = qualitySettings.previewEnabled !== false;
  }

  if (elements.qualityHardwareEncoderSelect) {
    const hardwareEncoderOptions = getHardwareEncoderSelectOptions(qualitySettings.codecPreference);
    const selectedHardwareEncoder = getSelectedHardwareEncoderPreference();
    if (!hardwareEncoderOptions.some((option) => option.value === selectedHardwareEncoder)) {
      qualitySettings.hardwareEncoderPreference = 'auto';
    }
    elements.qualityHardwareEncoderSelect.innerHTML = hardwareEncoderOptions.map((option) => {
      const selected = option.value === getSelectedHardwareEncoderPreference();
      return `<option value="${option.value}"${selected ? ' selected' : ''}>${option.label}</option>`;
    }).join('');
    elements.qualityHardwareEncoderSelect.disabled =
      !qualitySettings.hardwareAcceleration || hardwareEncoderOptions.length <= 1;
  }

  if (elements.qualityCodecNote) {
    elements.qualityCodecNote.textContent = buildCodecNoteText();
  }

  if (elements.qualityHardwareSupport) {
    elements.qualityHardwareSupport.textContent = buildHardwareSupportText();
  }

  if (elements.qualityPresetNote) {
    elements.qualityPresetNote.textContent = buildPresetNoteText();
  }

  if (elements.qualityObsCustomPortEnabled) {
    elements.qualityObsCustomPortEnabled.checked = isObsIngestCustomPortEnabled();
  }

  if (elements.qualityObsCustomPortRow) {
    elements.qualityObsCustomPortRow.classList.toggle('hidden', !isObsIngestCustomPortEnabled());
  }

  if (elements.qualityObsPort) {
    elements.qualityObsPort.value = String(getSelectedObsIngestPort());
  }

  if (elements.qualityObsUrl) {
    const requestedPort = getEffectiveObsIngestPort();
    const obsUrl = obsIngestPreview && obsIngestPreview.url && Number(obsIngestPreview.port) === requestedPort
      ? String(obsIngestPreview.url)
      : buildObsIngestPublishUrl(requestedPort);
    elements.qualityObsUrl.textContent = obsUrl;
  }

  if (elements.qualityObsStatus) {
    const requestedPort = getEffectiveObsIngestPort();
    if (obsIngestPreparePromise) {
      elements.qualityObsStatus.textContent = `正在检查并预留 127.0.0.1:${requestedPort}...`;
    } else if (obsIngestPreview && obsIngestPreview.lastError && Number(obsIngestPreview.port) === requestedPort) {
      elements.qualityObsStatus.textContent = `端口 ${requestedPort} 不可用：${obsIngestPreview.lastError}`;
    } else if (obsIngestPreview && obsIngestPreview.url && Number(obsIngestPreview.port) === requestedPort) {
      elements.qualityObsStatus.textContent = isObsIngestCustomPortEnabled()
        ? `当前使用自定义端口 ${requestedPort}。确认后会复制地址并进入等待推流状态。`
        : `当前使用默认端口 ${requestedPort}。确认后会复制地址并进入等待推流状态。`;
    } else {
      elements.qualityObsStatus.textContent = `默认端口是 ${DEFAULT_OBS_INGEST_PORT}，打开“自定义推流地址”后可以改成你习惯的固定端口。`;
    }
  }

  if (elements.btnSaveObsPort) {
    elements.btnSaveObsPort.disabled = Boolean(obsIngestPreparePromise);
  }

  if (elements.btnConfirmQuality) {
    elements.btnConfirmQuality.textContent = getSelectedHostBackend() === 'obs-ingest'
      ? '复制并开始'
      : '确认并继续';
  }
}

async function refreshQualityCapabilities(force = false) {
  if (!force && qualityCapabilities) {
    return qualityCapabilities;
  }

  if (qualityCapabilitiesPromise) {
    return qualityCapabilitiesPromise;
  }

  qualityCapabilitiesPromise = (async () => {
    if (!window.isElectron || !window.electronAPI || !window.electronAPI.mediaEngine) {
      qualityCapabilities = null;
      return null;
    }

    try {
      if (typeof window.electronAPI.mediaEngine.getCapabilities === 'function') {
        qualityCapabilities = await window.electronAPI.mediaEngine.getCapabilities();
      } else {
        qualityCapabilities = null;
      }
    } catch (error) {
      qualityCapabilities = null;
      debugLog('video', 'Failed to query native media capabilities:', error.message);
    } finally {
      qualityCapabilitiesChecked = true;
      renderQualitySettingsUi();
    }

    return qualityCapabilities;
  })();

  try {
    return await qualityCapabilitiesPromise;
  } finally {
    qualityCapabilitiesPromise = null;
  }
}

function bindQualitySegmentGroup(container, onSelect) {
  if (!container) {
    return;
  }

  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    onSelect(button.dataset.value || '');
  });
}

function bindQualitySettingsUi() {
  if (qualityUiBound) {
    return;
  }
  qualityUiBound = true;

  bindQualitySegmentGroup(elements.qualityBackendOptions, (value) => {
    qualitySettings.hostBackend = normalizeHostBackend(value);
    renderQualitySettingsUi();
    if (qualitySettings.hostBackend === 'obs-ingest') {
      prepareObsIngestPreview(false, getEffectiveObsIngestPort()).catch((error) => {
        showError(error && error.message ? error.message : '无法准备 OBS 推流地址');
      });
    }
  });

  bindQualitySegmentGroup(elements.qualityCodecOptions, (value) => {
    qualitySettings.codecPreference = value === 'h265' ? 'h265' : 'h264';
    renderQualitySettingsUi();
  });

  bindQualitySegmentGroup(elements.qualityResolutionOptions, (value) => {
    setQualityResolutionPreset(value);
    renderQualitySettingsUi();
  });

  bindQualitySegmentGroup(elements.qualityFpsOptions, (value) => {
    qualitySettings.frameRate = Number(value) || 30;
    renderQualitySettingsUi();
  });

  bindQualitySegmentGroup(elements.qualityPresetOptions, (value) => {
    qualitySettings.encoderPreset = QUALITY_PRESET_OPTIONS.some((option) => option.value === value)
      ? value
      : 'balanced';
    renderQualitySettingsUi();
  });

  bindQualitySegmentGroup(elements.qualityTuneOptions, (value) => {
    qualitySettings.encoderTune = QUALITY_TUNE_OPTIONS.some((option) => option.value === value)
      ? value
      : 'none';
    renderQualitySettingsUi();
  });

  bindQualitySegmentGroup(elements.qualityKeyframeOptions, (value) => {
    qualitySettings.keyframePolicy = QUALITY_KEYFRAME_OPTIONS.some((option) => option.value === value)
      ? value
      : '1s';
    renderQualitySettingsUi();
  });

  if (elements.qualityHardwareAcceleration) {
    elements.qualityHardwareAcceleration.addEventListener('change', () => {
      qualitySettings.hardwareAcceleration = Boolean(elements.qualityHardwareAcceleration.checked);
      renderQualitySettingsUi();
    });
  }

  if (elements.qualityPreviewEnabled) {
    elements.qualityPreviewEnabled.addEventListener('change', () => {
      qualitySettings.previewEnabled = Boolean(elements.qualityPreviewEnabled.checked);
      renderQualitySettingsUi();
    });
  }

  if (elements.qualityHardwareEncoderSelect) {
    elements.qualityHardwareEncoderSelect.addEventListener('change', () => {
      const value = String(elements.qualityHardwareEncoderSelect.value || 'auto').trim().toLowerCase();
      qualitySettings.hardwareEncoderPreference = value || 'auto';
      renderQualitySettingsUi();
    });
  }

  if (elements.qualityBitrateDecrease) {
    elements.qualityBitrateDecrease.addEventListener('click', () => {
      setQualityBitrate(qualitySettings.bitrate - QUALITY_BITRATE_STEP);
      renderQualitySettingsUi();
    });
  }

  if (elements.qualityBitrateIncrease) {
    elements.qualityBitrateIncrease.addEventListener('click', () => {
      setQualityBitrate(qualitySettings.bitrate + QUALITY_BITRATE_STEP);
      renderQualitySettingsUi();
    });
  }

  if (elements.qualityBitrate) {
    const syncBitrate = () => {
      setQualityBitrate(elements.qualityBitrate.value);
      renderQualitySettingsUi();
    };
    elements.qualityBitrate.addEventListener('change', syncBitrate);
    elements.qualityBitrate.addEventListener('blur', syncBitrate);
  }

  if (elements.qualityObsCustomPortEnabled) {
    elements.qualityObsCustomPortEnabled.addEventListener('change', () => {
      const enabled = Boolean(elements.qualityObsCustomPortEnabled.checked);
      setObsIngestCustomPortEnabled(enabled);
      renderQualitySettingsUi();
      prepareObsIngestPreview(true, getEffectiveObsIngestPort()).catch((error) => {
        showError(error && error.message ? error.message : '无法准备 OBS 推流地址');
      });
    });
  }

  if (elements.qualityObsPort) {
    const syncObsPortFromInput = () => {
      try {
        commitObsIngestPortInput();
        renderQualitySettingsUi();
      } catch (error) {
        showError(error && error.message ? error.message : 'OBS 端口无效');
      }
    };
    elements.qualityObsPort.addEventListener('change', syncObsPortFromInput);
    elements.qualityObsPort.addEventListener('blur', syncObsPortFromInput);
    elements.qualityObsPort.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }
      event.preventDefault();
      if (elements.btnSaveObsPort) {
        elements.btnSaveObsPort.click();
      } else {
        syncObsPortFromInput();
      }
    });
  }

  if (elements.btnSaveObsPort) {
    elements.btnSaveObsPort.addEventListener('click', () => {
      try {
        const port = commitObsIngestPortInput();
        renderQualitySettingsUi();
        prepareObsIngestPreview(true, port).catch((error) => {
          showError(error && error.message ? error.message : '无法保存 OBS 推流地址');
        });
      } catch (error) {
        showError(error && error.message ? error.message : 'OBS 端口无效');
      }
    });
  }
}

async function openQualityModal() {
  bindQualitySettingsUi();
  renderQualitySettingsUi();
  elements.qualityModal.classList.remove('hidden');
  refreshQualityCapabilities().catch(() => {});
  if (getSelectedHostBackend() === 'obs-ingest') {
    prepareObsIngestPreview(false, getEffectiveObsIngestPort()).catch(() => {});
  }
}

async function confirmQualitySelection() {
  if (getSelectedHostBackend() === 'obs-ingest') {
    const port = isObsIngestCustomPortEnabled()
      ? commitObsIngestPortInput()
      : DEFAULT_OBS_INGEST_PORT;
    await copyObsIngestUrl();
    elements.qualityModal.classList.add('hidden');
    await prepareObsIngestPreview(false, port);
    await startScreenShareWithObsIngest({ port });
    return;
  }
  elements.qualityModal.classList.add('hidden');
  await showSourceSelection();
}

function cancelQualitySelection() {
  elements.qualityModal.classList.add('hidden');
}

window.__vdsRefreshQualitySettingsUi = renderQualitySettingsUi;

function renderDebugMenu() {
  if (!elements.debugMenu) {
    return;
  }

  const presetItems = Object.entries(DEBUG_PRESET_DEFINITIONS).map(([key, definition]) => `
    <button class="debug-menu-preset" type="button" data-debug-preset="${key}" title="${definition.description}">
      <span class="debug-menu-preset-label">${definition.label}</span>
      <span class="debug-menu-preset-description">${definition.description}</span>
    </button>
  `).join('');

  const categoryItems = DEBUG_CATEGORY_KEYS.map((key) => {
    const definition = DEBUG_CATEGORY_DEFINITIONS[key];
    return `
      <label class="debug-menu-item">
        <span class="debug-menu-item-main">
          <input type="checkbox" data-debug-category="${key}">
          <span class="debug-menu-item-label">${definition.label}</span>
        </span>
        <span class="debug-menu-item-description">${definition.description}</span>
      </label>
    `;
  }).join('');

  const regularChannelItems = DEBUG_CHANNEL_KEYS
    .filter((key) => key !== 'agentStderr')
    .map((key) => {
      const definition = DEBUG_CHANNEL_DEFINITIONS[key];
      return `
        <label class="debug-menu-item">
          <span class="debug-menu-item-main">
            <input type="checkbox" data-debug-channel="${key}">
            <span class="debug-menu-item-label">${definition.label}</span>
          </span>
          <span class="debug-menu-item-description">${definition.description}</span>
        </label>
      `;
    }).join('');

  const agentStderrDefinition = DEBUG_CHANNEL_DEFINITIONS.agentStderr;
  const advancedChannelItems = `
    <label class="debug-menu-item debug-menu-item-warning">
      <span class="debug-menu-item-main">
        <input type="checkbox" data-debug-channel="agentStderr">
        <span class="debug-menu-item-label">${agentStderrDefinition.label}</span>
      </span>
      <span class="debug-menu-item-description">${agentStderrDefinition.description}</span>
    </label>
  `;

  elements.debugMenu.innerHTML = `
    <div class="debug-menu-header">
      <span class="debug-menu-title">调试控制台</span>
      <span class="debug-menu-subtitle">先选快速模式；需要缩小范围时，再勾选问题范围和输出内容。</span>
    </div>
    <div class="debug-menu-summary" data-debug-summary>当前为静默模式</div>
    <div class="debug-menu-section">
      <span class="debug-menu-section-title">快速模式</span>
      <p class="debug-menu-section-hint">日常先用“排障”；只有短时间复现才用“短时全量”。</p>
      <div class="debug-menu-presets">${presetItems}</div>
    </div>
    <div class="debug-menu-section">
      <span class="debug-menu-section-title">问题范围</span>
      <p class="debug-menu-section-hint">选择要看的业务范围。至少需要一个范围和一个输出内容同时开启。</p>
      <div class="debug-menu-body">${categoryItems}</div>
    </div>
    <div class="debug-menu-section">
      <span class="debug-menu-section-title">输出内容</span>
      <p class="debug-menu-section-hint">越靠下越细，日志量越大；周期统计和 breadcrumb 已做采样。</p>
      <div class="debug-menu-body">${regularChannelItems}</div>
    </div>
    <div class="debug-menu-section">
      <span class="debug-menu-section-title">深度诊断</span>
      <p class="debug-menu-section-hint">只在复现窗口很短、必须看 agent 原始 stderr 时打开。</p>
      <div class="debug-menu-body">${advancedChannelItems}</div>
    </div>
    <div class="debug-menu-footer">
      <button class="debug-menu-action" type="button" data-debug-preset="quiet">恢复静默</button>
    </div>
  `;
}

// 根据运行环境显示/隐藏标题栏
if (!window.isElectron) {
  elements.titleBar.style.display = 'none';
}

renderDebugMenu();
bindDebugMenuUi();
bindQualitySettingsUi();
renderQualitySettingsUi();
renderViewerPlaybackPrefsUi();
renderViewerJoinUi();
renderHostPublicListingUi();

prewarmWorkspacePanels().catch(() => {});

// 事件绑定
elements.btnHost.addEventListener('click', () => showHostPanel());
elements.btnViewer.addEventListener('click', () => showViewerPanel());
elements.btnStartShare.addEventListener('click', startScreenShare);
elements.btnStopShare.addEventListener('click', stopScreenShare);
elements.btnJoin.addEventListener('click', joinRoom);
if (elements.hostPublicRoomEnabled) {
  elements.hostPublicRoomEnabled.addEventListener('change', (event) => {
    qualitySettings.publicRoomEnabled = Boolean(event.target.checked);
    renderHostPublicListingUi();
  });
}
if (elements.btnViewerJoinLobby) {
  elements.btnViewerJoinLobby.addEventListener('click', () => {
    setViewerJoinMode('lobby');
    refreshPublicRooms({ manual: true, force: true }).catch(() => {});
  });
}
if (elements.btnViewerJoinDirect) {
  elements.btnViewerJoinDirect.addEventListener('click', () => {
    setViewerJoinMode('direct');
  });
}
if (elements.btnRefreshPublicRooms) {
  elements.btnRefreshPublicRooms.addEventListener('click', () => {
    refreshPublicRooms({ manual: true, force: true }).catch(() => {});
  });
}
elements.btnLeave.addEventListener('click', leaveRoom);
elements.btnBack.addEventListener('click', goBack);
elements.btnBackViewer.addEventListener('click', goBackViewer);
elements.btnCopyRoom.addEventListener('click', () => {
  copyRoomId().catch(() => {});
});
if (elements.viewerAudioDelayInput) {
  elements.viewerAudioDelayInput.addEventListener('input', (event) => {
    setViewerAudioDelayMs(event.target.value, {
      applyNative: true
    });
  });
}
if (elements.viewerAudioDelayDecrease) {
  elements.viewerAudioDelayDecrease.addEventListener('click', () => {
    setViewerAudioDelayMs(viewerPlaybackPrefs.audioDelayMs - 10, {
      applyNative: true
    });
  });
}
if (elements.viewerAudioDelayIncrease) {
  elements.viewerAudioDelayIncrease.addEventListener('click', () => {
    setViewerAudioDelayMs(viewerPlaybackPrefs.audioDelayMs + 10, {
      applyNative: true
    });
  });
}

// 屏幕源选择弹窗事件
elements.btnConfirmSource.addEventListener('click', confirmSourceAndShare);
elements.btnCancelSource.addEventListener('click', cancelSourceSelection);
elements.btnRefreshSources.addEventListener('click', refreshSources);

// 音频进程选择弹窗事件
elements.sourceAudioEnabled.addEventListener('change', updateSourceAudioUi);

// 画质设置弹窗事件
elements.btnConfirmQuality.addEventListener('click', () => {
  confirmQualitySelection().catch((error) => {
    debugLog('video', 'Failed to confirm quality selection:', error && error.message ? error.message : String(error));
    showError(error && error.message ? error.message : '无法开始共享');
  });
});

elements.btnCancelQuality.addEventListener('click', cancelQualitySelection);

// 标题栏按钮事件
elements.btnCloseUpdate.addEventListener('click', hideUpdateModal);
elements.btnInstallUpdate.addEventListener('click', () => {
  clearScheduledUpdateInstall();
  hideUpdateModal();
  if (window.electronAPI && window.electronAPI.quitAndInstall) {
    window.electronAPI.quitAndInstall();
  }
});

elements.btnMinimize.addEventListener('click', () => {
  window.electronAPI.minimize();
});

elements.btnMaximize.addEventListener('click', async () => {
  window.electronAPI.maximize();
  // 切换最大化图标
  const isMax = await window.electronAPI.isMaximized();
  updateMaximizeButton(isMax);
});

elements.btnClose.addEventListener('click', () => {
  setCloseModalState('open');
  elements.closeModal.classList.remove('hidden');
});

document.addEventListener('click', () => {
  closeDebugMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeDebugMenu();
  }
});

// 关闭确认弹窗事件
elements.btnMinimizeToTray.addEventListener('click', () => {
  setCloseModalState('closed');
  elements.closeModal.classList.add('hidden');
  window.electronAPI.minimizeToTray();
});

elements.btnCloseModalDismiss.addEventListener('click', () => {
  setCloseModalState('closed');
  elements.closeModal.classList.add('hidden');
});

elements.btnExitApp.addEventListener('click', () => {
  setCloseModalState('closed');
  elements.closeModal.classList.add('hidden');
  window.electronAPI.close();
});

// 更新最大化按钮图标
function updateMaximizeButton(isMaximized) {
  const btn = elements.btnMaximize;
  if (isMaximized) {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="3" y="0" width="9" height="9" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="0" y="3" width="9" height="9" stroke="currentColor" stroke-width="1.5" fill="rgba(255,255,255,0.1)"/></svg>';
  } else {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
  }
}

// 监听窗口最大化状态变化（双击标题栏等情况）
if (window.electronAPI && window.electronAPI.onMaximizedChange) {
  window.electronAPI.onMaximizedChange((isMaximized) => {
    updateMaximizeButton(isMaximized);
  });
}

// 页面导航
initializeStartupTasks().catch((error) => {
  debugLog('misc', 'Startup initialization failed:', error.message);
});

async function showHostPanel() {
  await transitionToWorkspace('host');
  isHost = true;
  renderHostPublicListingUi();
  elements.hostStatus.textContent = '正在连接...';
  elements.hostStatus.classList.add('waiting');
  try {
    await ensureRuntimeConnectionConfig();
    await waitForWsConnected();
  } catch (_error) {
    showError('无法连接到信令服务器');
  }
}

async function showViewerPanel() {
  await transitionToWorkspace('viewer');
  isHost = false;
  setViewerJoinMode('lobby');
  renderViewerJoinUi();
  updatePublicRoomsPollingState();
  refreshPublicRooms({ force: true }).catch(() => {});
  elements.connectionStatus.textContent = '正在连接...';
  try {
    await ensureRuntimeConnectionConfig();
    await waitForWsConnected();
  } catch (_error) {
    showError('无法连接到信令服务器');
  }
}

async function goBack() {
  try {
    await stopScreenShare();
  } catch (error) {
    debugLog('video', 'Failed to stop share while leaving host panel:', error && error.message ? error.message : String(error));
  }
  disconnectWebSocket();
  await transitionToHome('host');
}

async function goBackViewer() {
  await leaveRoom();
  await transitionToHome('viewer');
}

// WebSocket连接

// 等待WebSocket连接

// 发送消息

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (wsConnectPromise) {
    return wsConnectPromise;
  }

  wsManualClose = false;
  pendingReconnect = false;

  wsConnectPromise = new Promise((resolve, reject) => {
    let settled = false;

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    ws = new WebSocket(wsBaseUrl);

    ws.onopen = async () => {
      debugLog('connection', 'WebSocket connected');
      wsConnected = true;
      wsReconnectAttempts = 0;
      wsConnectPromise = null;

      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
      if (resumeOnNextConnect && currentRoomId && sessionRole) {
        removePendingMessages((entry) => {
          if (!entry || typeof entry !== 'object') {
            return false;
          }

          return entry.type === 'join-room' ||
            entry.type === 'create-room' ||
            entry.type === 'resume-session';
        });
        sendRawMessage({
          type: 'resume-session',
          roomId: currentRoomId,
          clientId: clientId,
          role: sessionRole,
          needsMediaReconnect: sessionRole === 'viewer' && !upstreamConnected
        });
        resumeOnNextConnect = false;
      }

      flushPendingMessages();
      settle(resolve);
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      try {
        await handleMessage(data);
      } catch (error) {
        debugLog('connection', 'Unhandled message processing error:', error && error.message ? error.message : String(error));
      }
    };

    ws.onclose = () => {
      debugLog('connection', 'WebSocket disconnected');
      wsConnected = false;
      wsConnectPromise = null;

      if (wsManualClose) {
        debugLog('connection', 'Manual close, skipping reconnect');
        return;
      }

      resumeOnNextConnect = Boolean(currentRoomId && sessionRole);
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      debugLog('connection', 'WebSocket error:', error && error.message ? error.message : String(error));

      if (!settled) {
        wsConnectPromise = null;
        settle(reject, new Error('websocket-connect-failed'));
      }
    };
  });

  return wsConnectPromise;
}

function scheduleReconnect() {
  if (pendingReconnect) {
    return;
  }

  pendingReconnect = true;
  const maxDelay = 30000;
  const baseDelay = 1000;
  const delay = Math.min(baseDelay * Math.pow(2, wsReconnectAttempts), maxDelay);

  debugLog('connection', `Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts + 1})...`);

  if (isHost && elements.hostStatus) {
    elements.hostStatus.textContent = '正在重连...';
    elements.hostStatus.classList.add('waiting');
  } else if (!isHost && elements.connectionStatus) {
    elements.connectionStatus.textContent = '正在重连...';
  }

  wsReconnectTimer = setTimeout(() => {
    pendingReconnect = false;
    wsReconnectAttempts++;
    connectWebSocket().catch(() => {});
  }, delay);
}

function disconnectWebSocket() {
  wsManualClose = true;
  pendingReconnect = false;
  resumeOnNextConnect = false;
  wsConnectPromise = null;

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectAttempts = 0;

  if (ws) {
    ws.close();
    ws = null;
  }

  wsConnected = false;
}

async function waitForWsConnected(timeoutMs = 10000) {
  if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  await Promise.race([
    connectWebSocket(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('websocket-timeout')), timeoutMs);
    })
  ]);
}

function sendRawMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function removePendingMessages(predicate) {
  if (typeof predicate !== 'function' || pendingMessages.length === 0) {
    return;
  }

  for (let index = pendingMessages.length - 1; index >= 0; index -= 1) {
    if (predicate(pendingMessages[index])) {
      pendingMessages.splice(index, 1);
    }
  }
}

function flushPendingMessages() {
  while (pendingMessages.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    sendRawMessage(pendingMessages.shift());
  }
}

function sendMessage(data, options = {}) {
  const { queueIfDisconnected = true } = options;

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendRawMessage(data);
    return true;
  }

  if (!queueIfDisconnected) {
    return false;
  }

  pendingMessages.push(data);
  connectWebSocket().catch(() => {});
  return false;
}

function registerUpdateStatusListener() {
  if (updateStatusUnsubscribe || !window.electronAPI || !window.electronAPI.onUpdateStatus) {
    return;
  }

  updateStatusUnsubscribe = window.electronAPI.onUpdateStatus((status) => {
    debugLog('update', 'Update status:', status);
    applyUpdateStatus(status);
  });
}

async function registerUpdateLogListener() {
  if (!window.electronAPI) {
    return;
  }

  if (typeof window.electronAPI.getUpdateLogSnapshot === 'function') {
    try {
      const snapshot = await window.electronAPI.getUpdateLogSnapshot();
      updateLogPath = snapshot && snapshot.path ? snapshot.path : updateLogPath;

      if (snapshot && Array.isArray(snapshot.entries)) {
        snapshot.entries.forEach(rememberUpdateLogEntry);
      }
    } catch (error) {
      debugLog('update', 'Unable to load updater log snapshot:', error.message);
    }
  }

  if (updateLogUnsubscribe || !window.electronAPI.onUpdateLog) {
    return;
  }

  updateLogUnsubscribe = window.electronAPI.onUpdateLog((entry) => {
    rememberUpdateLogEntry(entry);
  });
}

function initializeStartupTasks() {
  if (!window.electronAPI) {
    return Promise.resolve();
  }

  return (async () => {
    await registerUpdateLogListener();
    registerUpdateStatusListener();

    if (window.electronAPI.getAppVersion) {
      await initVersion();
    }

    if (!updateCheckStarted && window.electronAPI.checkForUpdates) {
      updateCheckStarted = true;
      await checkForUpdates();
    }
  })();
}

setDebugConfig(debugConfig);

function getUpdateManifestUrl() {
  return `${serverBaseUrl}/updates/latest.yml`;
}

function clearUpdateModalAutoHide() {
  if (updateModalAutoHideTimer) {
    clearTimeout(updateModalAutoHideTimer);
    updateModalAutoHideTimer = null;
  }
}

function clearScheduledUpdateInstall() {
  if (updateInstallTimer) {
    clearTimeout(updateInstallTimer);
    updateInstallTimer = null;
  }
}

function scheduleSilentUpdateInstall(delayMs = 5000) {
  clearScheduledUpdateInstall();
  updateInstallTimer = setTimeout(() => {
    updateInstallTimer = null;
    if (window.electronAPI && window.electronAPI.quitAndInstall) {
      window.electronAPI.quitAndInstall();
    }
  }, Math.max(0, Number(delayMs) || 0));
}

function scheduleUpdateModalAutoHide(delayMs = 1800) {
  clearUpdateModalAutoHide();
  updateModalAutoHideTimer = setTimeout(() => {
    elements.updateModal.classList.add('hidden');
    updateModalAutoHideTimer = null;
  }, delayMs);
}

function hideUpdateModal() {
  clearUpdateModalAutoHide();
  clearScheduledUpdateInstall();
  elements.updateModal.classList.add('hidden');
}

function rememberUpdateLogEntry(entry) {
  if (!entry) {
    return;
  }

  if (entry.path) {
    updateLogPath = entry.path;
  }

  updateLogEntries.push(entry);
  if (updateLogEntries.length > UPDATE_LOG_ENTRY_LIMIT) {
    updateLogEntries.shift();
  }

  const level = entry.level ? String(entry.level).toUpperCase() : 'INFO';
  debugLog('update', `[Updater:${level}]`, entry.message || entry.line || '');
}

function getRecentUpdateLogTail(limit = 5) {
  if (!updateLogEntries.length) {
    return '';
  }

  return updateLogEntries
    .slice(-limit)
    .map((entry) => entry.line || `[${entry.level || 'info'}] ${entry.message || ''}`)
    .join('\n');
}

function buildUpdateDiagnosticDetail(baseDetail, includeTail = false) {
  const sections = [];

  if (baseDetail) {
    sections.push(baseDetail);
  }

  if (updateLogPath) {
    sections.push(`日志文件：${updateLogPath}`);
  }

  if (includeTail) {
    const tail = getRecentUpdateLogTail();
    if (tail) {
      sections.push(`最近更新日志：\n${tail}`);
    }
  }

  return sections.join('\n\n');
}

function renderUpdateModal(options = {}) {
  const {
    title = '正在检查更新',
    step = '',
    detail = '',
    showProgress = true,
    indeterminate = false,
    progressPercent = 0,
    speedText = '0 MB/秒',
    transferredText = '0 / 0 MB',
    timeText = '剩余时间：计算中...',
    showCloseButton = false,
    closeLabel = '关闭',
    showInstallButton = false,
    installLabel = '立即安装'
  } = options;

  const normalizedPercent = Math.max(0, Math.min(100, Number(progressPercent) || 0));

  elements.updateModal.classList.remove('hidden');
  elements.updateTitle.textContent = title;
  elements.updateStep.textContent = step;
  elements.updateDetail.textContent = detail;
  elements.updateProgressContainer.classList.toggle('hidden', !showProgress);
  elements.updateActions.classList.toggle('hidden', !showCloseButton && !showInstallButton);
  elements.btnCloseUpdate.classList.toggle('hidden', !showCloseButton);
  elements.btnCloseUpdate.textContent = closeLabel;
  elements.btnInstallUpdate.classList.toggle('hidden', !showInstallButton);
  elements.btnInstallUpdate.textContent = installLabel;
  elements.updateProgress.classList.toggle('indeterminate', indeterminate);
  elements.updateProgress.style.width = indeterminate ? '35%' : normalizedPercent + '%';
  elements.updatePercent.textContent = indeterminate ? '检查中' : normalizedPercent.toFixed(1) + '%';
  elements.updateSpeed.textContent = speedText;
  elements.updateTransferred.textContent = transferredText;
  elements.updateTime.textContent = timeText;
}

function applyUpdateStatus(status) {
  clearUpdateModalAutoHide();
  clearScheduledUpdateInstall();

  const activeVersion = status.currentVersion || currentVersion;
  const targetVersion = status.version || activeVersion;
  const feedUrl = status.feedUrl || getUpdateManifestUrl();

  if (status.status === 'checking') {
    renderUpdateModal({
      title: '正在检查更新',
      step: '第 1 步 / 共 3 步：连接更新源并比较版本',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}`),
      showProgress: true,
      indeterminate: true,
      speedText: '等待响应',
      transferredText: '清单文件：latest.yml',
      timeText: '正在请求更新元数据'
    });
    return;
  }

  if (status.status === 'available') {
    renderUpdateModal({
      title: `发现新版本：v${targetVersion}`,
      step: '第 2 步 / 共 3 步：已发现更新，开始下载',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n最新版本：v${targetVersion}\n更新源：${feedUrl}`),
      showProgress: true,
      progressPercent: 0,
      speedText: '正在准备下载',
      transferredText: '0 / 待下载',
      timeText: '正在初始化下载'
    });

    if (window.electronAPI && window.electronAPI.downloadUpdate) {
      window.electronAPI.downloadUpdate();
    }
    return;
  }

  if (status.status === 'downloading') {
    const percent = Number.isFinite(status.percent) ? status.percent : 0;
    const speed = formatBytes(status.bytesPerSecond);
    const transferred = formatBytes(status.transferred);
    const total = formatBytes(status.total);
    const remaining = status.remaining > 0 ? formatTime(status.remaining) : '计算中...';

    renderUpdateModal({
      title: '正在下载更新',
      step: `第 3 步 / 共 3 步：已下载 ${percent.toFixed(1)}%`,
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}`),
      showProgress: true,
      progressPercent: percent,
      speedText: speed + '/秒',
      transferredText: `${transferred} / ${total}`,
      timeText: '剩余时间：' + remaining
    });
    return;
  }

  if (status.status === 'downloaded') {
    renderUpdateModal({
      title: `更新已下载：v${targetVersion}`,
      step: '下载完成，正在安装。',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n待安装版本：v${targetVersion}`),
      showProgress: true,
      progressPercent: 100,
      speedText: '下载完成',
      transferredText: '100%',
      timeText: '即将自动重启并静默安装更新',
      showCloseButton: false,
      showInstallButton: false
    });
    scheduleSilentUpdateInstall(1200);
    return;
  }

  if (status.status === 'not-available') {
    renderUpdateModal({
      title: '当前已是最新版本',
      step: '版本比较完成',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源版本：v${targetVersion}\n未发现更高版本，此窗口将自动关闭。`),
      showProgress: false,
      showCloseButton: true
    });
    scheduleUpdateModalAutoHide(2000);
    return;
  }

  if (status.status === 'error') {
    renderUpdateModal({
      title: '检查更新失败',
      step: '无法完成本次更新检查',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}\n错误信息：${status.error || '未知错误'}`, true),
      showProgress: false,
      showCloseButton: true
    });
  }
}

// Host: 显示屏幕源选择弹窗
async function showSourceSelection() {
  if (sourceSelectionInFlight) {
    return;
  }

  sourceSelectionInFlight = true;
  if (elements.btnConfirmQuality) {
    elements.btnConfirmQuality.disabled = true;
  }

  try {
    await waitForWsConnected();

    if (!window.isElectron || !window.electronAPI || !window.electronAPI.mediaEngine) {
      throw new Error('native-electron-runtime-required');
    }

    debugLog('video', 'Getting capture targets for selection...');
    const sources = await window.electronAPI.mediaEngine.listCaptureTargets();

    if (!sources || sources.length === 0) {
      throw new Error('No capture target available');
    }

    showSourceModal(sources);
  } catch (error) {
    debugLog('video', 'Error loading sources:', error && error.message ? error.message : String(error));
    showError('Failed to list capture targets: ' + error.message);
  } finally {
    sourceSelectionInFlight = false;
    if (elements.btnConfirmQuality) {
      elements.btnConfirmQuality.disabled = false;
    }
  }
}

// 刷新屏幕源列表
async function refreshSources() {
  try {
    debugLog('video', 'Refreshing source list...');
    const btn = elements.btnRefreshSources;
    btn.style.animation = 'spin 1s linear infinite';

    let sources = [];

    // 检测是否在Electron环境中
    if (window.isElectron) {
      sources = await window.electronAPI.mediaEngine.listCaptureTargets();
    }

    if (!sources || sources.length === 0) {
      showError('没有找到可用的屏幕源');
    } else {
      showSourceModal(sources);
    }

    btn.style.animation = '';
  } catch (error) {
    debugLog('video', 'Error refreshing sources:', error && error.message ? error.message : String(error));
    showError('刷新失败: ' + error.message);
    elements.btnRefreshSources.style.animation = '';
  }
}

// 显示源选择弹窗
function parseSelectedSourceAudioCandidates(selectedItem) {
  if (!selectedItem || !selectedItem.dataset.audioCandidates) {
    return [];
  }

  try {
    const parsed = JSON.parse(selectedItem.dataset.audioCandidates);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function withClientTimeout(promise, timeoutMs, timeoutMessage) {
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

function normalizeAudioProcessMatchValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

function buildClientAudioCandidate(processInfo, confidence, reason) {
  const pid = Number(processInfo && processInfo.pid);
  const normalizedPid = Number.isFinite(pid) && pid > 0 ? pid : null;
  const processName = String(processInfo && processInfo.name ? processInfo.name : `PID ${normalizedPid || 'unknown'}`);

  return {
    id: normalizedPid ? `process:${normalizedPid}` : `process:${processName}`,
    mode: 'process',
    pid: normalizedPid,
    processName,
    confidence,
    reason
  };
}

function matchAudioCandidatesForSource(source, processList) {
  const processes = Array.isArray(processList) ? processList : [];
  if (!source || !processes.length) {
    return [];
  }

  const sourcePid = Number(source.pid);
  const normalizedPid = Number.isFinite(sourcePid) && sourcePid > 0 ? sourcePid : null;
  if (normalizedPid) {
    const exactMatches = processes.filter((processInfo) => Number(processInfo && processInfo.pid) === normalizedPid);
    if (exactMatches.length > 0) {
      return exactMatches.map((processInfo) => buildClientAudioCandidate(processInfo, 1, 'window-pid-match'));
    }
  }

  const normalizedTitle = normalizeAudioProcessMatchValue(source.title || source.name || '');
  if (!normalizedTitle) {
    return [];
  }

  const fuzzyMatches = [];
  for (const processInfo of processes) {
    const processToken = normalizeAudioProcessMatchValue(processInfo && processInfo.name);
    if (!processToken) {
      continue;
    }

    if (normalizedTitle.includes(processToken) || processToken.includes(normalizedTitle)) {
      fuzzyMatches.push(buildClientAudioCandidate(processInfo, 0.35, 'window-title-match'));
    }

    if (fuzzyMatches.length >= 3) {
      break;
    }
  }

  return fuzzyMatches;
}

async function discoverAudioCandidatesForSource(source) {
  const audioApi = window.electronAPI &&
    window.electronAPI.mediaEngine &&
    window.electronAPI.mediaEngine.audio;
  if (!audioApi || !audioApi.isPlatformSupported || !audioApi.checkPermission || !audioApi.getProcessList) {
    return [];
  }

  try {
    const supported = await withClientTimeout(audioApi.isPlatformSupported(), 1500, 'audio-platform-probe-timeout');
    if (!supported) {
      return [];
    }

    const permission = await withClientTimeout(audioApi.checkPermission(), 1500, 'audio-permission-probe-timeout');
    const permissionStatus = String(permission && permission.status ? permission.status : 'unknown');
    if (permissionStatus !== 'authorized') {
      return [];
    }

    const processList = await withClientTimeout(audioApi.getProcessList(), 2500, 'audio-process-list-timeout');
    return matchAudioCandidatesForSource(source, processList);
  } catch (error) {
    debugLog('audio', '[source-audio] deferred audio discovery failed:', error && error.message ? error.message : String(error));
    return [];
  }
}

function getSelectedSourceItem() {
  return document.querySelector('.source-item.selected');
}

function getSelectedCaptureSource() {
  const selectedItem = getSelectedSourceItem();
  if (!selectedItem) {
    return null;
  }

  if (selectedItem.__captureSource && typeof selectedItem.__captureSource === 'object') {
    return selectedItem.__captureSource;
  }

  const sourceId = selectedItem.dataset.id ? String(selectedItem.dataset.id).trim() : '';
  if (!sourceId) {
    return null;
  }

    return {
      id: sourceId,
      sourceId,
      title: selectedItem.dataset.name || '',
      name: selectedItem.dataset.name || '',
      displayId: selectedItem.dataset.displayId || null,
      nativeMonitorIndex: selectedItem.dataset.nativeMonitorIndex || null,
      hwnd: selectedItem.dataset.hwnd || null,
      pid: selectedItem.dataset.pid ? Number(selectedItem.dataset.pid) : null,
      state: selectedItem.dataset.state || 'normal',
      isMinimized: selectedItem.dataset.isMinimized === 'true'
    };
  }

function updateSourceAudioUi() {
  const selectedItem = getSelectedSourceItem();
  const candidates = parseSelectedSourceAudioCandidates(selectedItem);
  const selectedIndex = Math.max(0, Number(selectedItem && selectedItem.dataset.audioIndex) || 0);
  const selectedCandidate = candidates[selectedIndex] || null;
  const audioEnabled = Boolean(elements.sourceAudioEnabled && elements.sourceAudioEnabled.checked);
  const shouldShowCandidateList = audioEnabled && candidates.length > 1;

  if (elements.sourceAudioProcessList) {
    elements.sourceAudioProcessList.innerHTML = '';
    if (shouldShowCandidateList) {
      candidates.forEach((candidate, index) => {
        const row = document.createElement('div');
        row.className = `source-audio-process-item${index === selectedIndex ? ' selected' : ''}`;
        row.textContent = `${candidate.processName || 'PID'} (${candidate.pid || 'n/a'})`;
        row.tabIndex = 0;
        row.addEventListener('click', () => {
          if (!selectedItem) {
            return;
          }
          selectedItem.dataset.audioIndex = String(index);
          updateSourceAudioUi();
          debugLog('audio', '[source-audio] selected candidate:', candidate.processName || candidate.pid || 'n/a');
        });
        row.addEventListener('keydown', (event) => {
          if (!event || (event.key !== 'Enter' && event.key !== ' ')) {
            return;
          }
          event.preventDefault();
          row.click();
        });
        elements.sourceAudioProcessList.appendChild(row);
      });
    }
    elements.sourceAudioProcessList.classList.toggle('hidden', !shouldShowCandidateList);
  }

  if (!elements.sourceAudioSummary) {
    return;
  }

  if (!audioEnabled) {
    elements.sourceAudioSummary.textContent = '当前仅共享画面';
    return;
  }

  if (!selectedCandidate) {
    elements.sourceAudioSummary.textContent = '当前目标没有可用的进程音频匹配';
    return;
  }

  if (shouldShowCandidateList) {
    elements.sourceAudioSummary.textContent = `检测到 ${candidates.length} 个音频进程，请手动选择`;
    return;
  }

  elements.sourceAudioSummary.textContent = `当前音频目标: ${selectedCandidate.processName || 'PID'} (${selectedCandidate.pid})`;
}

function showSourceModal(sources) {
  const modal = document.getElementById('source-modal');
  const sourceList = document.getElementById('source-list');

  // 清空并生成源选项
  sourceList.innerHTML = '';

  sources.forEach((source, index) => {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.dataset.id = source.id;
    item.dataset.name = source.title || source.name || '';
    item.dataset.displayId = source.displayId != null ? String(source.displayId) : '';
    item.dataset.nativeMonitorIndex = source.nativeMonitorIndex != null ? String(source.nativeMonitorIndex) : '';
    item.dataset.hwnd = source.hwnd != null ? String(source.hwnd) : '';
    item.dataset.pid = source.pid != null ? String(source.pid) : '';
    item.dataset.state = source.state || 'normal';
    item.dataset.isMinimized = source.isMinimized ? 'true' : 'false';
    item.dataset.audioCandidates = JSON.stringify(Array.isArray(source.audioCandidates) ? source.audioCandidates : []);
    item.dataset.audioIndex = '0';
    item.__captureSource = source;

    // 缩略图
    if (source.thumbnail) {
      const img = document.createElement('img');
      img.src = source.thumbnail;
      item.appendChild(img);
    }

    // 名称
    const name = document.createElement('p');
    name.className = 'source-item-title';
    name.textContent = source.title || source.name || '';
    item.appendChild(name);

    const subtitle = document.createElement('p');
    subtitle.className = 'source-item-subtitle';
    subtitle.textContent = buildCaptureSourceSubtitle(source);
    item.appendChild(subtitle);

    const status = buildCaptureSourceStatus(source);
    if (status) {
      const statusText = document.createElement('p');
      statusText.className = 'source-item-status';
      statusText.textContent = status;
      item.appendChild(statusText);
    }

    // 点击选择
    item.addEventListener('click', () => {
      // 移除其他选中状态
      document.querySelectorAll('.source-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      updateSourceAudioUi();
    });

    sourceList.appendChild(item);

    // 默认选中第一个
    if (index === 0) {
      item.classList.add('selected');
    }
  });

  // 显示弹窗
  if (elements.sourceAudioEnabled) {
    elements.sourceAudioEnabled.checked = true;
  }
  updateSourceAudioUi();
  modal.classList.remove('hidden');
}

function buildCaptureSourceSubtitle(source) {
  const parts = [];
  const kindLabel = source && source.kind === 'display' ? '显示器' : '窗口';
  parts.push(kindLabel);

  if (source && source.kind === 'display') {
    const displayIndex = Number(source.nativeMonitorIndex);
    if (Number.isFinite(displayIndex) && displayIndex >= 0) {
      parts.push(`屏幕 ${displayIndex + 1}`);
    } else if (source.displayId != null && String(source.displayId).trim()) {
      parts.push(`显示器 ${source.displayId}`);
    }
  } else {
    const label = source && source.appName
      ? String(source.appName)
      : (source && source.title ? String(source.title) : '');
    if (label) {
      parts.push(label);
    }
  }

  return parts.join(' · ');
}

function buildCaptureSourceStatus(source) {
  if (!source) {
    return '';
  }
  if (source.state === 'minimized') {
    return '已最小化';
  }
  if (source.state === 'exclusive-fullscreen') {
    return '独占全屏';
  }
  return '';
}

// 确认选择并开始共享
// 保存当前选择的屏幕源
let currentCaptureSource = null;

async function confirmSourceAndShare() {
  const selectedSource = getSelectedCaptureSource();
  if (!selectedSource) {
    showError('Please select a capture target');
    return;
  }

  currentCaptureSource = selectedSource;
  document.getElementById('source-modal').classList.add('hidden');
  try {
    await showAudioProcessSelection();
  } catch (error) {
    debugLog('video', 'Failed to start native share session:', error && error.message ? error.message : String(error));
    showError(error && error.message ? error.message : 'failed-to-start-native-share');
  }
}

// 显示音频进程选择弹窗

// 确认音频进程选择

// 跳过音频捕获

// Active source-audio path: one modal only, no secondary audio modal.
async function showAudioProcessSelection() {
  const selectedItem = getSelectedSourceItem();
  const audioEnabled = Boolean(elements.sourceAudioEnabled && elements.sourceAudioEnabled.checked);

  if (!audioEnabled) {
    await startScreenShareWithSource(currentCaptureSource);
    return;
  }

  let audioCandidates = parseSelectedSourceAudioCandidates(selectedItem);
  if (!audioCandidates.length) {
    audioCandidates = await discoverAudioCandidatesForSource(currentCaptureSource);
    if (selectedItem && audioCandidates.length) {
      selectedItem.dataset.audioCandidates = JSON.stringify(audioCandidates);
      selectedItem.dataset.audioIndex = '0';
      updateSourceAudioUi();
    }
  }

  const audioIndex = Math.max(0, Number(selectedItem && selectedItem.dataset.audioIndex) || 0);
  const audioCandidate = audioCandidates[audioIndex] || null;

  if (!audioCandidate || !audioCandidate.pid) {
    showError('当前窗口没有可用音频，将仅共享画面');
    await startScreenShareWithSource(currentCaptureSource);
    return;
  }

  await startScreenShareWithAudio(currentCaptureSource, Number(audioCandidate.pid));
}

async function confirmAudioProcess() {
  await showAudioProcessSelection();
}

async function skipAudioCapture() {
  await startScreenShareWithSource(currentCaptureSource);
}

// 取消选择
function cancelSourceSelection() {
  currentCaptureSource = null;
  document.getElementById('source-modal').classList.add('hidden');
}

// 捕获窗口音频（自动选择进程）

// 根据sourceId开始屏幕共享
async function startScreenShareWithSource(source) {
  return requireNativeAuthorityOverride('startScreenShareWithSource', startScreenShareWithSource)(source);
}

// 使用指定PID捕获窗口音频
async function startScreenShareWithAudio(source, audioPid) {
  return requireNativeAuthorityOverride('startScreenShareWithAudio', startScreenShareWithAudio)(source, audioPid);
}

async function startScreenShareWithObsIngest(options = {}) {
  return requireNativeAuthorityOverride('startScreenShareWithObsIngest', startScreenShareWithObsIngest)(options);
}

async function startScreenShare() {
  await openQualityModal();
}

// Viewer: 加入房间
async function joinRoomById(roomId, { source = 'direct' } = {}) {
  const normalizedRoomId = String(roomId || '').toUpperCase().trim();
  if (viewerJoinPending) {
    return;
  }
  if (!normalizedRoomId) {
    showError('请输入房间号');
    return;
  }

  setViewerJoinPending(true, {
    source
  });

  if (elements.roomIdInput && source !== 'direct') {
    elements.roomIdInput.value = normalizedRoomId;
  }

  try {
    await applyNativeViewerPlaybackPrefs({
      includeMode: true
    });
  } catch (error) {
    debugLog('audio', '[media-engine] apply viewer playback prefs before join failed:', error && error.message ? error.message : String(error));
  }

  currentRoomId = normalizedRoomId;
  sessionRole = 'viewer';
  updatePublicRoomsPollingState();
  sendMessage({
    type: 'join-room',
    roomId: normalizedRoomId,
    clientId: clientId,
    viewerPlaybackMode: viewerPlaybackPrefs.mode,
    viewerAudioDelayMs: viewerPlaybackPrefs.audioDelayMs
  });
  renderViewerPlaybackPrefsUi();
}

async function joinRoom() {
  const roomId = elements.roomIdInput.value.toUpperCase().trim();
  if (!roomId) {
    showError('请输入房间号');
    return;
  }
  return joinRoomById(roomId, { source: 'direct' });
}

// Viewer: 离开房间
async function leaveRoom() {
  sendMessage({
    type: 'leave-room',
    roomId: currentRoomId,
    clientId: clientId
  }, { queueIfDisconnected: false });

  // resetViewerState 会清理 peerConnections
  await resetViewerState();
}

// 更新观众数量
function updateViewerCount(viewerId, leftPosition) {
  const countElement = elements.viewerCount;
  let count = parseInt(countElement.textContent) || 0;

  if (viewerId) {
    count++;
  } else if (leftPosition !== undefined) {
    count = Math.max(0, count - 1);
  }

  countElement.textContent = count;
}

async function copyRoomId(options = {}) {
  const roomId = String((options && options.roomId) || currentRoomId || '').trim();
  if (!roomId) {
    if (options.showFailureToast !== false) {
      showError('当前没有房间号可复制');
    }
    return false;
  }

  await copyTextToClipboard(roomId, {
    successMessage: Object.prototype.hasOwnProperty.call(options, 'successMessage')
      ? options.successMessage
      : '房间号已复制',
    failureMessage: Object.prototype.hasOwnProperty.call(options, 'failureMessage')
      ? options.failureMessage
      : '复制房间号失败',
    showSuccessToast: options.showSuccessToast !== false,
    showFailureToast: options.showFailureToast !== false
  });

  return true;
}

window.__vdsCopyRoomIdToClipboard = copyRoomId;

// 显示错误
function showError(message) {
  elements.errorToast.textContent = message;
  elements.errorToast.classList.remove('hidden');
  setTimeout(() => {
    elements.errorToast.classList.add('hidden');
  }, 3000);
}

// Native mainline only

// 版本检查和自动更新
let currentVersion = '1.6.2'; // 默认版本（Electron环境会动态获取）

// 初始化版本号（从 Electron app 获取）
async function initVersion() {
  if (window.electronAPI && window.electronAPI.getAppVersion) {
    try {
      currentVersion = await window.electronAPI.getAppVersion();
      debugLog('misc', 'App version:', currentVersion);
    } catch (err) {
      debugLog('misc', 'Failed to get app version:', err);
    }
  }
}

// 格式化字节数
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 格式化时间（毫秒转可读格式）
function formatTime(ms) {
  if (!ms || ms <= 0) return '未知';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return hours + '小时' + (minutes % 60) + '分钟';
  } else if (minutes > 0) {
    return minutes + '分钟' + (seconds % 60) + '秒';
  } else {
    return seconds + '秒';
  }
}

async function checkForUpdates() {
  if (!window.electronAPI || !window.electronAPI.checkForUpdates) {
    return null;
  }

  try {
    renderUpdateModal({
      title: '正在检查更新',
      step: '正在准备更新请求...',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${currentVersion}\n更新源：${getUpdateManifestUrl()}`),
      showProgress: true,
      indeterminate: true,
      speedText: '等待响应',
      transferredText: '清单文件：latest.yml',
      timeText: '正在请求更新元数据'
    });

    debugLog('update', 'Checking for updates...');
    const result = await window.electronAPI.checkForUpdates();

    if (result && result.devMode) {
      hideUpdateModal();
    }

    return result;
  } catch (error) {
    debugLog('update', 'Update check failed:', error.message);
    applyUpdateStatus({
      status: 'error',
      currentVersion,
      feedUrl: getUpdateManifestUrl(),
      error: error.message
    });
    return null;
  }
}

async function stopScreenShare() {
  const override = getNativeAuthorityOverride('stopScreenShare', stopScreenShare);
  if (override) {
    return override();
  }

  if (window.isElectron && window.electronAPI && window.electronAPI.mediaEngine) {
    try {
      const mediaEngine = window.electronAPI.mediaEngine;
      await Promise.all([
        typeof mediaEngine.stopAudioSession === 'function'
          ? mediaEngine.stopAudioSession({}).catch(() => {})
          : Promise.resolve(null),
        typeof mediaEngine.stopHostSession === 'function'
          ? mediaEngine.stopHostSession({}).catch(() => {})
          : Promise.resolve(null)
      ]);
    } catch (_error) {
      // Best-effort native cleanup when overrides were not installed successfully.
    }
  }

  if (currentRoomId && sessionRole === 'host') {
    sendMessage({
      type: 'leave-room',
      roomId: currentRoomId,
      clientId
    }, { queueIfDisconnected: false });
  }

  currentRoomId = null;
  sessionRole = null;
  hostId = null;
  upstreamPeerId = null;
  relayPc = null;
  relayStream = null;
  localStream = null;
  upstreamConnected = false;
  viewerReadySent = false;
  videoStarted = false;
  elements.roomInfo.classList.add('hidden');
  elements.viewerCount.textContent = '0';
  elements.btnStartShare.classList.remove('hidden');
  elements.btnStopShare.classList.add('hidden');
  elements.hostStatus.textContent = '准备就绪';
  elements.hostStatus.classList.remove('waiting');
  renderHostPublicListingUi();
}

async function resetViewerState() {
  currentRoomId = null;
  sessionRole = null;
  hostId = null;
  upstreamPeerId = null;
  myChainPosition = -1;
  viewerReadySent = false;
  videoStarted = false;
  upstreamConnected = false;
  relayPc = null;
  relayStream = null;
  setViewerJoinPending(false);

  await clearAllPeerConnections({ clearRetryState: true });
  elements.joinForm.classList.remove('hidden');
  elements.viewerStatus.classList.add('hidden');
  elements.btnLeave.classList.add('hidden');
  elements.remoteVideo.srcObject = null;
  elements.waitingMessage.classList.remove('hidden');
  elements.connectionStatus.textContent = '等待连接...';
  elements.connectionStatus.classList.remove('connected');
  if (elements.viewerReceiveFps) {
    elements.viewerReceiveFps.textContent = '-';
  }
  if (elements.viewerRenderFps) {
    elements.viewerRenderFps.textContent = '-';
  }
  renderViewerPlaybackPrefsUi();
  renderViewerJoinUi();
  updatePublicRoomsPollingState();
}

async function handleMessage(data) {
  return requireNativeAuthorityOverride('handleMessage', handleMessage)(data);
}

function createPeerConnection(peerId, isInitiator, kind = 'direct') {
  return requireNativeAuthorityOverride('createPeerConnection', createPeerConnection)(peerId, isInitiator, kind);
}

async function createOffer(viewerId, options = {}) {
  return requireNativeAuthorityOverride('createOffer', createOffer)(viewerId, options);
}

async function createOfferToNextViewer(nextViewerId, options = {}) {
  return requireNativeAuthorityOverride('createOfferToNextViewer', createOfferToNextViewer)(nextViewerId, options);
}

async function handleOffer(data) {
  return requireNativeAuthorityOverride('handleOffer', handleOffer)(data);
}

async function handleAnswer(data) {
  return requireNativeAuthorityOverride('handleAnswer', handleAnswer)(data);
}

async function handleIceCandidate(data) {
  return requireNativeAuthorityOverride('handleIceCandidate', handleIceCandidate)(data);
}
