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

const runtimeConfig = getRuntimeConfig();
const serverBaseUrl = runtimeConfig.serverUrl;
const wsBaseUrl = toWebSocketUrl(serverBaseUrl);
const clientId = runtimeConfig.clientId || ('client_' + Math.random().toString(36).substring(2, 11));
const DEBUG_MODE_STORAGE_KEY = 'vds-debug-mode';
const DEBUG_CONFIG_STORAGE_KEY = 'vds-debug-config';
const DEBUG_CATEGORY_DEFINITIONS = Object.freeze({
  connection: {
    label: '连接',
    description: 'WebSocket、信令、ICE、Peer 建连与重连'
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
const DEBUG_CATEGORY_KEYS = Object.keys(DEBUG_CATEGORY_DEFINITIONS);
let debugConfig = readDebugConfig();

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

// 音频捕获全局变量（用于资源清理）

// 画质设置
let qualitySettings = {
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
  encoderTune: 'none'
};
let qualityCapabilities = null;
let qualityCapabilitiesPromise = null;
let qualityCapabilitiesChecked = false;
let qualityUiBound = false;

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
const QUALITY_HARDWARE_ENCODER_PATTERN = /(?:_amf|_mf|_qsv|_nvenc|videotoolbox|_d3d12va)/i;


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
      disconnectGraceMs: Number(electronConfig.disconnectGraceMs || 30000)
    };
  }

  return {
    clientId: null,
    serverUrl: normalizeBaseUrl(window.location.origin || DEFAULT_SERVER_URL),
    disconnectGraceMs: 30000
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
  return DEBUG_CATEGORY_KEYS.reduce((config, key) => {
    config[key] = Boolean(enabled);
    return config;
  }, {});
}

function normalizeDebugConfig(config, fallbackEnabled = false) {
  const normalized = buildDefaultDebugConfig(fallbackEnabled);
  if (!config || typeof config !== 'object') {
    return normalized;
  }

  for (const key of DEBUG_CATEGORY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      normalized[key] = Boolean(config[key]);
    }
  }

  return normalized;
}

function readDebugConfig() {
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

function isAnyDebugEnabled(config = debugConfig) {
  return DEBUG_CATEGORY_KEYS.some((key) => Boolean(config[key]));
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
  const debugEnabled = isAnyDebugEnabled();
  document.body.classList.toggle('debug-mode-enabled', debugEnabled);

  if (elements && elements.btnDebugToggle) {
    const enabledLabels = DEBUG_CATEGORY_KEYS
      .filter((key) => debugConfig[key])
      .map((key) => DEBUG_CATEGORY_DEFINITIONS[key].label);
    elements.btnDebugToggle.classList.toggle('active', debugEnabled);
    elements.btnDebugToggle.title = enabledLabels.length > 0
      ? `已开启调试：${enabledLabels.join('、')}`
      : '打开调试菜单';
    if (elements.debugMenu) {
      elements.btnDebugToggle.setAttribute(
        'aria-expanded',
        elements.debugMenu.classList.contains('hidden') ? 'false' : 'true'
      );
    }
  }

  if (elements && elements.debugMenu) {
    const checkboxes = elements.debugMenu.querySelectorAll('[data-debug-category]');
    checkboxes.forEach((input) => {
      const key = input.getAttribute('data-debug-category');
      input.checked = Boolean(key && debugConfig[key]);
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
  return isAnyDebugEnabled();
}

function isDebugCategoryEnabled(category = 'misc') {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, category)) {
    return false;
  }
  return Boolean(debugConfig[category]);
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

function setDebugCategoryEnabled(category, enabled) {
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, category)) {
    return;
  }
  setDebugConfig({
    ...debugConfig,
    [category]: Boolean(enabled)
  });
}

function debugLog(category, ...args) {
  let resolvedCategory = category;
  let resolvedArgs = args;
  if (!Object.prototype.hasOwnProperty.call(DEBUG_CATEGORY_DEFINITIONS, resolvedCategory)) {
    resolvedArgs = [category, ...args];
    resolvedCategory = 'misc';
  }
  if (!isDebugCategoryEnabled(resolvedCategory)) {
    return;
  }
  console.log(...resolvedArgs);
}

window.__vdsIsDebugModeEnabled = isDebugModeEnabled;
window.__vdsDebugCategoryDefinitions = DEBUG_CATEGORY_DEFINITIONS;
window.__vdsShouldDebugLog = (category = 'misc') => isDebugCategoryEnabled(category);
window.__vdsGetDebugConfig = () => ({ ...debugConfig });
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
  if (value.startsWith('stun:')) {
    return value.replace(/\?.*$/, '');
  }

  return value;
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

      return {
        ...server,
        urls
      };
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
  btnJoin: document.getElementById('btn-join'),
  btnLeave: document.getElementById('btn-leave'),
  btnBack: document.getElementById('btn-back'),
  btnBackViewer: document.getElementById('btn-back-viewer'),
  btnCopyRoom: document.getElementById('btn-copy-room'),
  roomInfo: document.getElementById('room-info'),
  roomIdDisplay: document.getElementById('room-id-display'),
  roomIdInput: document.getElementById('room-id-input'),
  viewerCount: document.getElementById('viewer-count'),
  viewerRoomId: document.getElementById('viewer-room-id'),
  viewerStatus: document.getElementById('viewer-status'),
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
  btnChangeSourceAudio: document.getElementById('btn-change-source-audio'),
  sourceAudioProcessList: document.getElementById('source-audio-process-list'),
  // 画质设置弹窗
  qualityModal: document.getElementById('quality-modal'),
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

  if (qualitySettings.codecPreference === 'h265' && !isH265CodecAvailable()) {
    qualitySettings.codecPreference = 'h264';
  }

  setQualityResolutionPreset(qualitySettings.resolutionPreset);
  setQualityBitrate(qualitySettings.bitrate);

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
}

async function openQualityModal() {
  bindQualitySettingsUi();
  renderQualitySettingsUi();
  elements.qualityModal.classList.remove('hidden');
  refreshQualityCapabilities().catch(() => {});
}

async function confirmQualitySelection() {
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

  const items = DEBUG_CATEGORY_KEYS.map((key) => {
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

  elements.debugMenu.innerHTML = `
    <div class="debug-menu-header">
      <span class="debug-menu-title">调试日志</span>
      <span class="debug-menu-subtitle">按链路分类启用前端诊断输出</span>
    </div>
    <div class="debug-menu-body">${items}</div>
  `;
}

// 根据运行环境显示/隐藏标题栏
if (!window.isElectron) {
  elements.titleBar.style.display = 'none';
}

renderDebugMenu();
bindQualitySettingsUi();
renderQualitySettingsUi();

prewarmWorkspacePanels().catch(() => {});

// 事件绑定
elements.btnHost.addEventListener('click', () => showHostPanel());
elements.btnViewer.addEventListener('click', () => showViewerPanel());
elements.btnStartShare.addEventListener('click', startScreenShare);
elements.btnStopShare.addEventListener('click', stopScreenShare);
elements.btnJoin.addEventListener('click', joinRoom);
elements.btnLeave.addEventListener('click', leaveRoom);
elements.btnBack.addEventListener('click', goBack);
elements.btnBackViewer.addEventListener('click', goBackViewer);
elements.btnCopyRoom.addEventListener('click', copyRoomId);

// 屏幕源选择弹窗事件
elements.btnConfirmSource.addEventListener('click', confirmSourceAndShare);
elements.btnCancelSource.addEventListener('click', cancelSourceSelection);
elements.btnRefreshSources.addEventListener('click', refreshSources);

// 音频进程选择弹窗事件
elements.sourceAudioEnabled.addEventListener('change', updateSourceAudioUi);
elements.btnChangeSourceAudio.addEventListener('click', cycleSelectedSourceAudioCandidate);

// 画质设置弹窗事件
elements.btnConfirmQuality.addEventListener('click', () => {
  confirmQualitySelection().catch((error) => {
    console.error('Failed to confirm quality selection:', error);
    showError(error && error.message ? error.message : '无法继续打开采集源列表');
  });
});

elements.btnCancelQuality.addEventListener('click', cancelQualitySelection);

// 标题栏按钮事件
elements.btnCloseUpdate.addEventListener('click', hideUpdateModal);
elements.btnInstallUpdate.addEventListener('click', () => {
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

if (elements.btnDebugToggle) {
  elements.btnDebugToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDebugMenu();
  });
}

if (elements.debugMenu) {
  elements.debugMenu.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  elements.debugMenu.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const category = input.getAttribute('data-debug-category');
    if (!category) {
      return;
    }
    setDebugCategoryEnabled(category, input.checked);
  });
}

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
    console.error('Failed to stop share while leaving host panel:', error);
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
        console.error('Unhandled message processing error:', error);
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
      console.error('WebSocket error:', error);

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

function scheduleUpdateModalAutoHide(delayMs = 1800) {
  clearUpdateModalAutoHide();
  updateModalAutoHideTimer = setTimeout(() => {
    elements.updateModal.classList.add('hidden');
    updateModalAutoHideTimer = null;
  }, delayMs);
}

function hideUpdateModal() {
  clearUpdateModalAutoHide();
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
      step: '下载完成，可以开始安装。',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n待安装版本：v${targetVersion}`),
      showProgress: true,
      progressPercent: 100,
      speedText: '下载完成',
      transferredText: '100%',
      timeText: '点击“立即安装”后将重启并应用更新',
      showCloseButton: true,
      closeLabel: '稍后',
      showInstallButton: true
    });
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
    console.error('Error loading sources:', error);
    showError('Failed to list capture targets: ' + error.message);
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
    console.error('Error refreshing sources:', error);
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
      displayId: selectedItem.dataset.displayId || null,
      nativeMonitorIndex: selectedItem.dataset.nativeMonitorIndex || null,
      hwnd: selectedItem.dataset.hwnd || null
    };
  }

function updateSourceAudioUi() {
  const selectedItem = getSelectedSourceItem();
  const candidates = parseSelectedSourceAudioCandidates(selectedItem);
  const selectedIndex = Math.max(0, Number(selectedItem && selectedItem.dataset.audioIndex) || 0);
  const selectedCandidate = candidates[selectedIndex] || null;
  const audioEnabled = Boolean(elements.sourceAudioEnabled && elements.sourceAudioEnabled.checked);

  if (elements.sourceAudioProcessList) {
    elements.sourceAudioProcessList.innerHTML = '';
    candidates.forEach((candidate, index) => {
      const row = document.createElement('div');
      row.className = `source-audio-process-item${index === selectedIndex ? ' selected' : ''}`;
      row.textContent = `${candidate.processName || 'PID'} (${candidate.pid || 'n/a'})`;
      elements.sourceAudioProcessList.appendChild(row);
    });
    elements.sourceAudioProcessList.classList.toggle('hidden', candidates.length === 0);
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

  elements.sourceAudioSummary.textContent = `当前音频目标: ${selectedCandidate.processName || 'PID'} (${selectedCandidate.pid})`;
}

function cycleSelectedSourceAudioCandidate() {
  const selectedItem = getSelectedSourceItem();
  if (!selectedItem) {
    return;
  }

  const candidates = parseSelectedSourceAudioCandidates(selectedItem);
  if (candidates.length <= 1) {
    updateSourceAudioUi();
    return;
  }

  const currentIndex = Math.max(0, Number(selectedItem.dataset.audioIndex) || 0);
  selectedItem.dataset.audioIndex = String((currentIndex + 1) % candidates.length);
  updateSourceAudioUi();
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
    item.dataset.name = source.name;
    item.dataset.displayId = source.displayId != null ? String(source.displayId) : '';
    item.dataset.nativeMonitorIndex = source.nativeMonitorIndex != null ? String(source.nativeMonitorIndex) : '';
    item.dataset.hwnd = source.hwnd != null ? String(source.hwnd) : '';
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
    name.textContent = source.name;
    item.appendChild(name);

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
    console.error('Failed to start native share session:', error);
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
  const audioCandidates = parseSelectedSourceAudioCandidates(selectedItem);
  const audioIndex = Math.max(0, Number(selectedItem && selectedItem.dataset.audioIndex) || 0);
  const audioCandidate = audioCandidates[audioIndex] || null;

  if (!audioEnabled) {
    await startScreenShareWithSource(currentCaptureSource);
    return;
  }

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

async function startScreenShare() {
  await openQualityModal();
}

// Viewer: 加入房间
function joinRoom() {
  const roomId = elements.roomIdInput.value.toUpperCase().trim();
  if (!roomId) {
    showError('请输入房间号');
    return;
  }

  currentRoomId = roomId;
  sessionRole = 'viewer';
  sendMessage({
    type: 'join-room',
    roomId: roomId,
    clientId: clientId
  });
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

function copyRoomId() {
  navigator.clipboard.writeText(currentRoomId).then(() => {
    showError('Room ID copied');
  });
}

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
let currentVersion = '1.5.6'; // 默认版本（Electron环境会动态获取）

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
  return requireNativeAuthorityOverride('stopScreenShare', stopScreenShare)();
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
