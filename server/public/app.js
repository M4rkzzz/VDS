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
const VIEWER_PLAYBACK_PREFS_STORAGE_KEY = 'vds-viewer-playback-prefs';
const OBS_INGEST_PREFS_STORAGE_KEY = 'vds-obs-ingest-prefs';
let debugConfig = null;

// WebSocket连接
let wsConnected = false;
let resumeOnNextConnect = false;
const pendingRemoteCandidates = new Map();
const MAX_PENDING_REMOTE_CANDIDATES_PER_PEER = 32;

// Session state
let isHost = false;
let sessionRole = null;
let currentRoomId = null;
let currentSessionToken = null;
let localStream = null;
let myChainPosition = -1; // 观众在链中的位置
let hostId = null; // Host的clientId
let viewerJoinMode = 'lobby';
let viewerJoinPending = false;
let viewerPendingJoinSource = null;
let viewerJoinPendingTimer = null;
const VIEWER_JOIN_PENDING_TIMEOUT_MS = 10000;
let publicRooms = [];
let publicRoomsRefreshInFlight = false;
let publicRoomsManualRefreshInFlight = false;
let publicRoomsPollTimer = null;
let publicRoomsLastError = '';
let publicRoomsRefreshSeq = 0;
let publicRoomsAbortController = null;
let shareStartInFlight = false;
let fallbackStopShareInFlight = false;
let closeWindowActionInFlight = false;
let maximizeWindowActionInFlight = false;
let errorToastHideTimer = null;
const buttonActionInFlight = new WeakSet();
let navigationTransitionPromise = null;
let viewerAudioDelayApplyTimer = null;
let viewerAudioDelayApplySeq = 0;

let viewerPlaybackPrefs = readViewerPlaybackPrefs();
const debugPanelModule = window.VDS && window.VDS.debugPanel
  ? window.VDS.debugPanel
  : null;
if (!debugPanelModule) {
  throw new Error('debug-panel-module-unavailable');
}
const qualitySettingsModule = window.VDS && window.VDS.qualitySettings
  ? window.VDS.qualitySettings
  : null;
if (!qualitySettingsModule) {
  throw new Error('quality-settings-module-unavailable');
}
const {
  DEFAULT_OBS_INGEST_PORT,
  OBS_INGEST_PORT_MIN,
  OBS_INGEST_PORT_MAX
} = qualitySettingsModule.constants;
const {
  parseObsIngestPort,
} = qualitySettingsModule;

// 音频捕获全局变量（用于资源清理）

// 画质设置
let qualitySettings = qualitySettingsModule.settings;
const PUBLIC_ROOMS_POLL_INTERVAL_MS = 500;


// Native peer/session state
const peerConnections = new Map();
let relayPc = null;
let relayStream = null;
let viewerReadySent = false;
let videoStarted = false;
let upstreamConnected = false;
let runtimeConnectionConfigPromise = null;
let updateUiController = null;
let qualitySettingsController = null;
let debugPanelController = null;
let upstreamPeerId = null;
let sourceSelectionController = null;
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

function syncDebugUi() {
  return getDebugPanelController().syncUi();
}

function isDebugModeEnabled() {
  return getDebugPanelController().isDebugModeEnabled();
}

function isDebugLogEnabled(category = 'misc', channel = 'renderer', config = debugConfig) {
  if (config !== debugConfig) {
    return debugPanelModule.isLogEnabled(debugPanelModule.normalizeConfig(config, false), category, channel);
  }
  return getDebugPanelController().isDebugLogEnabled(category, channel);
}

function setDebugConfig(nextConfig, options = {}) {
  debugConfig = debugPanelModule.normalizeConfig(nextConfig, false);
  return getDebugPanelController().setConfig(debugConfig, options);
}

function readViewerPlaybackPrefs() {
  const fallback = {
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
  const numericDelay = Number(nextPrefs && nextPrefs.audioDelayMs);
  const normalizedDelay = Math.max(0, Math.min(300, Number.isFinite(numericDelay) ? Math.round(numericDelay) : 0));
  return {
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

function renderViewerPlaybackPrefsUi() {
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

async function applyNativeViewerPlaybackPrefs() {
  if (!window.isElectron || !window.electronAPI || !window.electronAPI.mediaEngine) {
    return;
  }
  const mediaEngine = window.electronAPI.mediaEngine;
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
    scheduleNativeViewerPlaybackPrefsApply();
  }
}

function scheduleNativeViewerPlaybackPrefsApply() {
  if (viewerAudioDelayApplyTimer) {
    clearTimeout(viewerAudioDelayApplyTimer);
    viewerAudioDelayApplyTimer = null;
  }
  const applySeq = viewerAudioDelayApplySeq + 1;
  viewerAudioDelayApplySeq = applySeq;
  viewerAudioDelayApplyTimer = setTimeout(() => {
    viewerAudioDelayApplyTimer = null;
    if (applySeq !== viewerAudioDelayApplySeq || sessionRole !== 'viewer' || !currentRoomId) {
      return;
    }
    applyNativeViewerPlaybackPrefs().catch((error) => {
      if (applySeq === viewerAudioDelayApplySeq) {
        debugLog('audio', '[media-engine] setViewerAudioDelay failed:', error && error.message ? error.message : String(error));
      }
    });
  }, 120);
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
  if (viewerJoinPendingTimer) {
    clearTimeout(viewerJoinPendingTimer);
    viewerJoinPendingTimer = null;
  }
  viewerJoinPending = Boolean(pending);
  viewerPendingJoinSource = viewerJoinPending ? source : null;
  if (viewerJoinPending) {
    viewerJoinPendingTimer = setTimeout(() => {
      viewerJoinPendingTimer = null;
      if (!viewerJoinPending) {
        return;
      }
      handleViewerJoinFailure('加入房间超时，请检查信令服务器连接后重试。').catch((error) => {
        setViewerJoinPending(false);
        showError(error && error.message ? error.message : '加入房间超时');
      });
    }, VIEWER_JOIN_PENDING_TIMEOUT_MS);
  }
  renderViewerJoinUi();
}

function cancelPendingViewerJoin() {
  setViewerJoinPending(false);
  removePendingMessages((entry) => Boolean(
    entry &&
    entry.type === 'join-room' &&
    entry.clientId === clientId &&
    (!currentRoomId || !entry.roomId || String(entry.roomId).toUpperCase() === String(currentRoomId).toUpperCase())
  ));
}

function renderPublicRooms() {
  if (!elements.viewerPublicRoomsStatus || !elements.viewerPublicRoomsList) {
    return;
  }

  let statusText = '';
  if (publicRoomsManualRefreshInFlight && publicRooms.length === 0) {
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
    elements.btnRefreshPublicRooms.classList.toggle('is-refreshing', isLobby && publicRoomsManualRefreshInFlight);
    elements.btnRefreshPublicRooms.disabled = viewerJoinPending || publicRoomsManualRefreshInFlight;
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

function cancelPublicRoomsRefresh() {
  publicRoomsRefreshSeq += 1;
  if (publicRoomsAbortController) {
    publicRoomsAbortController.abort();
    publicRoomsAbortController = null;
  }
  publicRoomsRefreshInFlight = false;
  publicRoomsManualRefreshInFlight = false;
  renderViewerJoinUi();
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
  if (!shouldPollPublicRooms() && !manual) {
    return publicRooms;
  }
  if (force && publicRoomsAbortController) {
    publicRoomsAbortController.abort();
  }

  const showRefreshUi = Boolean(manual);
  const refreshSeq = publicRoomsRefreshSeq + 1;
  publicRoomsRefreshSeq = refreshSeq;
  const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  publicRoomsAbortController = abortController;
  publicRoomsRefreshInFlight = true;
  publicRoomsManualRefreshInFlight = showRefreshUi;
  if (showRefreshUi) {
    publicRoomsLastError = '';
    renderViewerJoinUi();
  }

  try {
    const response = await fetch(`${serverBaseUrl}/api/public-rooms`, {
      cache: 'no-store',
      signal: abortController ? abortController.signal : undefined
    });
    if (refreshSeq !== publicRoomsRefreshSeq || (abortController && abortController.signal.aborted)) {
      return publicRooms;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (refreshSeq !== publicRoomsRefreshSeq || (abortController && abortController.signal.aborted)) {
      return publicRooms;
    }
    publicRooms = Array.isArray(payload && payload.rooms)
      ? payload.rooms
        .map((room) => ({
          roomId: String(room && room.roomId ? room.roomId : '').trim().toUpperCase(),
          viewerCount: Math.max(0, Number(room && room.viewerCount) || 0)
        }))
        .filter((room) => room.roomId)
      : [];
    publicRoomsLastError = '';
  } catch (_error) {
    if (refreshSeq !== publicRoomsRefreshSeq || (abortController && abortController.signal.aborted)) {
      return publicRooms;
    }
    if (showRefreshUi) {
      publicRoomsLastError = '大厅列表暂不可用';
      showError('无法刷新公开房间列表');
    }
  } finally {
    if (refreshSeq === publicRoomsRefreshSeq) {
      publicRoomsRefreshInFlight = false;
      publicRoomsAbortController = null;
      if (showRefreshUi) {
        publicRoomsManualRefreshInFlight = false;
      }
      if (shouldPollPublicRooms() || showRefreshUi) {
        renderViewerJoinUi();
      }
    }
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
window.__vdsHandleViewerJoinSucceeded = () => {
  setViewerJoinPending(false);
  updatePublicRoomsPollingState();
};

function bindDebugMenuUi() {
  return getDebugPanelController().bind();
}

function debugLog(category, ...args) {
  return getDebugPanelController().log(category, ...args);
}

window.__vdsIsDebugModeEnabled = isDebugModeEnabled;
window.__vdsShouldDebugLog = (category = 'misc', channel = 'renderer') => isDebugLogEnabled(category, channel);
window.__vdsRenderViewerPlaybackPrefsUi = renderViewerPlaybackPrefsUi;

function openDebugMenu() {
  return getDebugPanelController().open();
}

function closeDebugMenu() {
  return getDebugPanelController().close();
}

function toggleDebugMenu() {
  return getDebugPanelController().toggle();
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

async function runNavigationTransition(action) {
  if (navigationTransitionPromise) {
    return navigationTransitionPromise;
  }
  if (typeof action !== 'function') {
    return null;
  }
  navigationTransitionPromise = (async () => {
    setNavigationButtonsDisabled(true);
    try {
      return await action();
    } finally {
      navigationTransitionPromise = null;
      setNavigationButtonsDisabled(false);
    }
  })();
  return navigationTransitionPromise;
}

function setNavigationButtonsDisabled(disabled) {
  [elements.btnHost, elements.btnViewer, elements.btnBack, elements.btnBackViewer].forEach((button) => {
    if (button) {
      button.disabled = Boolean(disabled);
    }
  });
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

  const registry = window.__vdsNativeAuthorityOverrides;
  if (registry && typeof registry[name] === 'function') {
    return registry[name];
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
  viewerAudioDelayControl: document.getElementById('viewer-audio-delay-control'),
  viewerAudioDelayInput: document.getElementById('viewer-audio-delay-input'),
  viewerAudioDelayDecrease: document.getElementById('viewer-audio-delay-decrease'),
  viewerAudioDelayIncrease: document.getElementById('viewer-audio-delay-increase'),
  connectionStatus: document.getElementById('connection-status'),
  chainPosition: document.getElementById('chain-position'),
  viewerReceiveFps: document.getElementById('viewer-receive-fps'),
  viewerRenderFps: document.getElementById('viewer-render-fps'),
  hostP2pStatus: document.getElementById('host-p2p-status'),
  viewerP2pStatus: document.getElementById('viewer-p2p-status'),
  hostP2pDiagnosticOutput: document.getElementById('host-p2p-diagnostic-output'),
  viewerP2pDiagnosticOutput: document.getElementById('viewer-p2p-diagnostic-output'),
  hostCaptureDiagnosticOutput: document.getElementById('host-capture-diagnostic-output'),
  btnCopyHostP2pDiagnostic: document.getElementById('btn-copy-host-p2p-diagnostic'),
  btnCopyViewerP2pDiagnostic: document.getElementById('btn-copy-viewer-p2p-diagnostic'),
  btnCopyHostCaptureDiagnostic: document.getElementById('btn-copy-host-capture-diagnostic'),
  hostStatus: document.getElementById('host-status'),
  hostStatusDetail: document.getElementById('host-status-detail'),
  hostSourceFps: document.getElementById('host-source-fps'),
  hostCaptureFps: document.getElementById('host-capture-fps'),
  hostSendFps: document.getElementById('host-send-fps'),
  localVideo: document.getElementById('local-video'),
  remoteVideo: document.getElementById('remote-video'),
  waitingMessage: document.getElementById('waiting-message'),
  errorToast: document.getElementById('error-toast'),
  joinForm: document.getElementById('join-form'),
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

function getViewerCountFromUi() {
  const value = Number(elements.viewerCount && elements.viewerCount.textContent);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function buildLegacyAppStatePatch(overrides = {}) {
  return {
    role: sessionRole,
    roomId: currentRoomId,
    clientId,
    sessionToken: currentSessionToken,
    hostId,
    upstreamPeerId,
    chainPosition: myChainPosition,
    viewerCount: getViewerCountFromUi(),
    connectionState: wsConnected ? 'connected' : 'idle',
    ...overrides
  };
}

function patchAppState(update = {}, metadata = {}) {
  const appState = window.VDS && window.VDS.state;
  if (!appState || typeof appState.patch !== 'function') {
    return null;
  }
  return appState.patch(update, metadata);
}

function syncAppState(overrides = {}, metadata = {}) {
  return patchAppState(buildLegacyAppStatePatch(overrides), metadata);
}

window.__vdsPatchAppState = patchAppState;
window.__vdsSyncAppState = syncAppState;
syncAppState({ mediaManifest: null }, { reason: 'startup' });
if (debugPanelModule && typeof debugPanelModule.createController === 'function') {
  debugPanelController = debugPanelModule.createController({
    elements,
    electronAPI: window.electronAPI || null,
    logSink: (...resolvedArgs) => console.log(...resolvedArgs),
    runtimeDebugPreset: runtimeConfig.debugPreset,
    onConfigChanged: (nextDebugConfig) => {
      debugConfig = nextDebugConfig;
      if (typeof window.__vdsRenderP2pDiagnosticReport === 'function') {
        window.__vdsRenderP2pDiagnosticReport();
      }
      if (typeof window.__vdsRenderHostCaptureDiagnosticReport === 'function') {
        window.__vdsRenderHostCaptureDiagnosticReport();
      }
    }
  });
  debugConfig = debugPanelController.getConfig();
}


if (window.VDS && window.VDS.updateUi && typeof window.VDS.updateUi.createController === 'function') {
  updateUiController = window.VDS.updateUi.createController({
    elements,
    debugLog,
    defaultVersion: '1.6.6',
    getElectronApi: () => window.electronAPI || null,
    getServerBaseUrl: () => serverBaseUrl
  });
}

function getUpdateUiController() {
  if (!updateUiController) {
    throw new Error('update-ui-controller-unavailable');
  }
  return updateUiController;
}

function getDebugPanelController() {
  if (!debugPanelController) {
    throw new Error('debug-panel-controller-unavailable');
  }
  return debugPanelController;
}

if (qualitySettingsModule && typeof qualitySettingsModule.createController === 'function') {
  qualitySettingsController = qualitySettingsModule.createController({
    elements,
    showError,
    commitObsIngestPortInput,
    getMediaEngine: () => window.isElectron && window.electronAPI ? window.electronAPI.mediaEngine : null
  });
}

function getQualitySettingsController() {
  if (!qualitySettingsController) {
    throw new Error('quality-settings-controller-unavailable');
  }
  return qualitySettingsController;
}

if (window.VDS && window.VDS.sourceSelection && typeof window.VDS.sourceSelection.createController === 'function') {
  sourceSelectionController = window.VDS.sourceSelection.createController({
    elements,
    showError,
    debugLog,
    getMediaEngine: () => window.isElectron && window.electronAPI ? window.electronAPI.mediaEngine : null,
    startScreenShareWithSource,
    startScreenShareWithAudio,
    resetShareStartPendingUi,
    markShareStartInFlight: () => {
      if (!shareStartInFlight) {
        shareStartInFlight = true;
      }
    }
  });
}

function getSourceSelectionController() {
  if (!sourceSelectionController) {
    throw new Error('source-selection-controller-unavailable');
  }
  return sourceSelectionController;
}

function getResolutionPreset(value) {
  return qualitySettingsModule.getResolutionPreset(value);
}

function setQualityResolutionPreset(value) {
  return qualitySettingsModule.setQualityResolutionPreset(value);
}

function setQualityBitrate(value) {
  return qualitySettingsModule.setQualityBitrate(value);
}

function normalizeHostBackend(value) {
  return qualitySettingsModule.normalizeHostBackend(value);
}

function getSelectedHostBackend() {
  return qualitySettingsModule.getSelectedHostBackend();
}

function isObsIngestCustomPortEnabled() {
  return qualitySettingsModule.isObsIngestCustomPortEnabled();
}

function setObsIngestCustomPortEnabled(enabled, options = {}) {
  return qualitySettingsModule.setObsIngestCustomPortEnabled(enabled, options);
}

function getSelectedObsIngestPort() {
  return qualitySettingsModule.getSelectedObsIngestPort();
}

function getEffectiveObsIngestPort() {
  return qualitySettingsModule.getEffectiveObsIngestPort();
}

function setSelectedObsIngestPort(value, options = {}) {
  return qualitySettingsModule.setSelectedObsIngestPort(value, options);
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
  return qualitySettingsModule.getObsIngestPortForPrepare(requestedPort);
}

function buildObsIngestPublishUrl(port) {
  return qualitySettingsModule.buildObsIngestPublishUrl(port);
}

function isObsHostBackendAvailable() {
  return qualitySettingsModule.isObsHostBackendAvailable();
}

function buildHostBackendOptions() {
  return qualitySettingsModule.buildHostBackendOptions();
}

function buildSegmentGroupMarkup(options, activeValue) {
  return qualitySettingsModule.buildSegmentGroupMarkup(options, activeValue);
}

async function prepareObsIngestPreview(forceRefresh = false, requestedPort = null) {
  return getQualitySettingsController().prepareObsIngestPreview(forceRefresh, requestedPort);
}

function renderQualitySettingsUi() {
  return getQualitySettingsController().render();
}

async function refreshQualityCapabilities(force = false) {
  return qualitySettingsModule.refreshCapabilities({
    force,
    getMediaEngine: () => window.isElectron && window.electronAPI ? window.electronAPI.mediaEngine : null,
    debugLog,
    onChange: renderQualitySettingsUi
  });
}

function bindQualitySettingsUi() {
  return getQualitySettingsController().bind();
}

async function copyObsIngestUrl() {
  const port = isObsIngestCustomPortEnabled()
    ? commitObsIngestPortInput()
    : DEFAULT_OBS_INGEST_PORT;
  const currentPreview = getQualitySettingsController().getObsIngestPreview();
  const preview = (currentPreview && currentPreview.url && Number(currentPreview.port) === port)
    ? currentPreview
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

async function runButtonActionOnce(button, action) {
  if (!button || typeof action !== 'function') {
    return null;
  }
  if (buttonActionInFlight.has(button)) {
    return null;
  }
  buttonActionInFlight.add(button);
  const previousDisabled = Boolean(button.disabled);
  button.disabled = true;
  try {
    return await action();
  } finally {
    buttonActionInFlight.delete(button);
    button.disabled = previousDisabled;
  }
}

async function openQualityModal() {
  if (elements.qualityModal) {
    elements.qualityModal.classList.remove('hidden');
  }
  try {
    bindQualitySettingsUi();
    renderQualitySettingsUi();
  } catch (error) {
    debugLog('video', 'Failed to render quality settings:', error && error.message ? error.message : String(error));
    showError('画质设置渲染失败，请查看日志');
    return;
  }
  refreshQualityCapabilities().catch((error) => {
    debugLog('video', 'Failed to refresh quality capabilities:', error && error.message ? error.message : String(error));
  });
  if (getSelectedHostBackend() === 'obs-ingest') {
    prepareObsIngestPreview(false, getEffectiveObsIngestPort()).catch((error) => {
      debugLog('video', 'Failed to prepare OBS ingest preview:', error && error.message ? error.message : String(error));
    });
  }
}

function resetShareStartPendingUi() {
  shareStartInFlight = false;
  if (elements.btnConfirmQuality) {
    elements.btnConfirmQuality.disabled = false;
  }
  if (sourceSelectionController && typeof sourceSelectionController.resetPendingUi === 'function') {
    sourceSelectionController.resetPendingUi();
  }
  if (elements.btnConfirmSource) {
    elements.btnConfirmSource.disabled = false;
  }
  if (elements.btnRefreshSources) {
    elements.btnRefreshSources.disabled = false;
  }
  if (elements.btnStartShare) {
    elements.btnStartShare.disabled = false;
  }
}

async function confirmQualitySelection() {
  if (shareStartInFlight) {
    return;
  }
  shareStartInFlight = true;
  if (elements.btnConfirmQuality) {
    elements.btnConfirmQuality.disabled = true;
  }
  if (elements.btnStartShare) {
    elements.btnStartShare.disabled = true;
  }
  try {
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
  } catch (error) {
    resetShareStartPendingUi();
    throw error;
  }
}

function cancelQualitySelection() {
  resetShareStartPendingUi();
  elements.qualityModal.classList.add('hidden');
}

window.__vdsRefreshQualitySettingsUi = renderQualitySettingsUi;
window.__vdsResetShareStartPendingUi = resetShareStartPendingUi;

function renderDebugMenu() {
  return getDebugPanelController().render();
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
elements.btnHost.addEventListener('click', () => {
  runNavigationTransition(showHostPanel).catch((error) => {
    debugLog('misc', 'Failed to open host panel:', error && error.message ? error.message : String(error));
    showError(error && error.message ? error.message : '无法打开主播界面');
  });
});
elements.btnViewer.addEventListener('click', () => {
  runNavigationTransition(showViewerPanel).catch((error) => {
    debugLog('misc', 'Failed to open viewer panel:', error && error.message ? error.message : String(error));
    showError(error && error.message ? error.message : '无法打开观众界面');
  });
});
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
elements.btnBack.addEventListener('click', () => {
  runNavigationTransition(goBack).catch((error) => {
    debugLog('misc', 'Failed to return from host panel:', error && error.message ? error.message : String(error));
    showError(error && error.message ? error.message : '无法返回主页');
  });
});
elements.btnBackViewer.addEventListener('click', () => {
  runNavigationTransition(goBackViewer).catch((error) => {
    debugLog('misc', 'Failed to return from viewer panel:', error && error.message ? error.message : String(error));
    showError(error && error.message ? error.message : '无法返回主页');
  });
});
elements.btnCopyRoom.addEventListener('click', () => {
  runButtonActionOnce(elements.btnCopyRoom, () => copyRoomId()).catch(() => {});
});
if (elements.btnCopyHostP2pDiagnostic) {
  elements.btnCopyHostP2pDiagnostic.addEventListener('click', () => {
    runButtonActionOnce(elements.btnCopyHostP2pDiagnostic, () => copyP2pDiagnosticReport()).catch(() => {});
  });
}
if (elements.btnCopyViewerP2pDiagnostic) {
  elements.btnCopyViewerP2pDiagnostic.addEventListener('click', () => {
    runButtonActionOnce(elements.btnCopyViewerP2pDiagnostic, () => copyP2pDiagnosticReport()).catch(() => {});
  });
}
if (elements.btnCopyHostCaptureDiagnostic) {
  elements.btnCopyHostCaptureDiagnostic.addEventListener('click', () => {
    runButtonActionOnce(elements.btnCopyHostCaptureDiagnostic, () => copyHostCaptureDiagnosticReport()).catch(() => {});
  });
}
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
  hideUpdateModal();
  requestQuitAndInstall();
});

elements.btnMinimize.addEventListener('click', () => {
  window.electronAPI.minimize();
});

elements.btnMaximize.addEventListener('click', async () => {
  if (maximizeWindowActionInFlight) {
    return;
  }
  maximizeWindowActionInFlight = true;
  elements.btnMaximize.disabled = true;
  try {
    window.electronAPI.maximize();
    const isMax = await window.electronAPI.isMaximized();
    updateMaximizeButton(isMax);
  } catch (error) {
    debugLog('misc', 'Failed to toggle maximize state:', error && error.message ? error.message : String(error));
  } finally {
    maximizeWindowActionInFlight = false;
    elements.btnMaximize.disabled = false;
  }
});

elements.btnClose.addEventListener('click', () => {
  setCloseModalState('open');
  elements.closeModal.classList.remove('hidden');
});

if (window.electronAPI && typeof window.electronAPI.onCloseConfirmation === 'function') {
  window.electronAPI.onCloseConfirmation(() => {
    setCloseModalState('open');
    elements.closeModal.classList.remove('hidden');
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
  if (closeWindowActionInFlight) {
    return;
  }
  closeWindowActionInFlight = true;
  setCloseModalState('closed');
  elements.closeModal.classList.add('hidden');
  try {
    window.electronAPI.minimizeToTray();
    closeWindowActionInFlight = false;
  } catch (error) {
    closeWindowActionInFlight = false;
    debugLog('misc', 'Failed to minimize to tray:', error && error.message ? error.message : String(error));
  }
});

elements.btnCloseModalDismiss.addEventListener('click', () => {
  closeWindowActionInFlight = false;
  setCloseModalState('closed');
  elements.closeModal.classList.add('hidden');
});

elements.btnExitApp.addEventListener('click', () => {
  if (closeWindowActionInFlight) {
    return;
  }
  closeWindowActionInFlight = true;
  setCloseModalState('closed');
  elements.closeModal.classList.add('hidden');
  try {
    window.electronAPI.close();
  } catch (error) {
    closeWindowActionInFlight = false;
    debugLog('misc', 'Failed to close app:', error && error.message ? error.message : String(error));
  }
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
  if (elements.hostP2pStatus) {
    elements.hostP2pStatus.dataset.p2pState = 'idle';
    elements.hostP2pStatus.textContent = 'P2P：等待';
  }
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
  if (elements.viewerP2pStatus) {
    elements.viewerP2pStatus.dataset.p2pState = 'idle';
    elements.viewerP2pStatus.textContent = 'P2P：等待';
  }
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
  return window.VDS.roomClient.connectWebSocket();
}

function disconnectWebSocket() {
  resumeOnNextConnect = false;
  return window.VDS.roomClient.disconnectWebSocket();
}

async function waitForWsConnected(timeoutMs = 10000) {
  return window.VDS.roomClient.waitForWsConnected(timeoutMs);
}

function sendRawMessage(data) {
  return window.VDS.roomClient.sendRawMessage(data);
}

function removePendingMessages(predicate) {
  return window.VDS.roomClient.removePendingMessages(predicate);
}

function clearPendingSignalingQueues(reason = '') {
  const result = window.VDS.roomClient.clearPendingSignalingQueues(reason);
  let queuedCandidates = pendingRemoteCandidates.size;
  pendingRemoteCandidates.clear();
  if (typeof window.__vdsClearNativePendingRemoteCandidates === 'function') {
    queuedCandidates += Number(window.__vdsClearNativePendingRemoteCandidates() || 0);
  }
  if (queuedCandidates > 0) {
    debugLog('connection', 'Cleared pending remote candidates:', {
      reason,
      queuedCandidates
    });
  }
  return {
    queuedMessages: result && Number.isFinite(result.queuedMessages) ? result.queuedMessages : 0,
    queuedCandidates
  };
}

function flushPendingMessages() {
  return window.VDS.roomClient.flushPendingMessages();
}

function enqueuePendingMessage(data) {
  return window.VDS.roomClient.enqueuePendingMessage(data);
}

function sendMessage(data, options = {}) {
  return window.VDS.roomClient.sendMessage(data, options);
}

function registerUpdateStatusListener() {
  return getUpdateUiController().registerUpdateStatusListener();
}

function registerUpdateLogListener() {
  return getUpdateUiController().registerUpdateLogListener();
}

function initializeStartupTasks() {
  return getUpdateUiController().initializeStartupTasks();
}

setDebugConfig(debugConfig);

function getUpdateManifestUrl() {
  return getUpdateUiController().getUpdateManifestUrl();
}

function hideUpdateModal() {
  return getUpdateUiController().hideUpdateModal();
}

function renderUpdateModal(options = {}) {
  return getUpdateUiController().renderUpdateModal(options);
}

function applyUpdateStatus(status) {
  return getUpdateUiController().applyUpdateStatus(status);
}

function requestQuitAndInstall() {
  return getUpdateUiController().requestQuitAndInstall();
}

async function initVersion() {
  return getUpdateUiController().initVersion();
}

async function checkForUpdates() {
  return getUpdateUiController().checkForUpdates();
}
// Host: 显示屏幕源选择弹窗
async function showSourceSelection() {
  return getSourceSelectionController().showSourceSelection();
}

// 刷新屏幕源列表
async function refreshSources() {
  return getSourceSelectionController().refreshSources();
}

function updateSourceAudioUi() {
  return getSourceSelectionController().updateSourceAudioUi();
}

function showSourceModal(sources) {
  return getSourceSelectionController().showSourceModal(sources);
}

// 确认选择并开始共享
async function confirmSourceAndShare() {
  return getSourceSelectionController().confirmSourceAndShare();
}

// 取消选择
function cancelSourceSelection() {
  return getSourceSelectionController().cancelSourceSelection();
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
    await applyNativeViewerPlaybackPrefs();
  } catch (error) {
    debugLog('audio', '[media-engine] apply viewer playback prefs before join failed:', error && error.message ? error.message : String(error));
  }

  currentRoomId = normalizedRoomId;
  sessionRole = 'viewer';
  currentSessionToken = null;
  syncAppState({ connectionState: wsConnected ? 'connected' : 'connecting' }, { reason: 'join-room-request' });
  updatePublicRoomsPollingState();
  window.VDS.roomClient.joinRoomById({
    roomId: normalizedRoomId,
    clientId,
    sessionToken: currentSessionToken || '',
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
  cancelPendingViewerJoin();
  if (currentRoomId) {
    window.VDS.roomClient.leaveRoom({
      roomId: currentRoomId,
      clientId,
      sessionToken: currentSessionToken || '',
      sendOptions: { queueIfDisconnected: false }
    });
  }

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
  syncAppState({ viewerCount: count }, { reason: 'viewer-count' });
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

async function copyP2pDiagnosticReport() {
  if (typeof window.__vdsBuildP2pDiagnosticReport !== 'function') {
    showError('P2P 诊断尚不可用');
    return false;
  }

  const report = String(window.__vdsBuildP2pDiagnosticReport() || '').trim();
  if (!report) {
    showError('P2P 诊断尚无数据');
    return false;
  }

  await copyTextToClipboard(report, {
    successMessage: 'P2P 诊断已复制',
    failureMessage: '复制 P2P 诊断失败'
  });
  return true;
}

async function copyHostCaptureDiagnosticReport() {
  if (typeof window.__vdsBuildHostCaptureDiagnosticReport !== 'function') {
    showError('采集资源诊断尚不可用');
    return false;
  }

  const report = String(window.__vdsBuildHostCaptureDiagnosticReport() || '').trim();
  if (!report) {
    showError('采集资源诊断尚无数据');
    return false;
  }

  await copyTextToClipboard(report, {
    successMessage: '采集资源诊断已复制',
    failureMessage: '复制采集资源诊断失败'
  });
  return true;
}

// 显示错误
function showError(message) {
  if (errorToastHideTimer) {
    clearTimeout(errorToastHideTimer);
    errorToastHideTimer = null;
  }
  elements.errorToast.textContent = message;
  elements.errorToast.classList.remove('hidden');
  errorToastHideTimer = setTimeout(() => {
    elements.errorToast.classList.add('hidden');
    errorToastHideTimer = null;
  }, 3000);
}

// Native mainline only

async function stopScreenShare() {
  resetShareStartPendingUi();
  const override = getNativeAuthorityOverride('stopScreenShare', stopScreenShare);
  if (override) {
    return override();
  }
  if (fallbackStopShareInFlight) {
    return;
  }
  fallbackStopShareInFlight = true;
  if (elements.btnStopShare) {
    elements.btnStopShare.disabled = true;
  }

  try {
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
    window.VDS.roomClient.leaveRoom({
      roomId: currentRoomId,
      clientId,
      sessionToken: currentSessionToken || '',
      sendOptions: { queueIfDisconnected: false }
    });
  }

  currentRoomId = null;
  sessionRole = null;
  currentSessionToken = null;
  hostId = null;
  upstreamPeerId = null;
  relayPc = null;
  syncAppState({
    role: null,
    roomId: null,
    sessionToken: null,
    hostId: null,
    upstreamPeerId: null,
    chainPosition: -1,
    mediaManifest: null,
    viewerCount: 0
  }, { reason: 'reset-host' });
  relayStream = null;
  localStream = null;
  upstreamConnected = false;
  viewerReadySent = false;
  videoStarted = false;
  if (elements.roomInfo) {
    elements.roomInfo.classList.add('hidden');
  }
  if (elements.viewerCount) {
    elements.viewerCount.textContent = '0';
  }
  if (elements.btnStartShare) {
    elements.btnStartShare.classList.remove('hidden');
  }
  if (elements.btnStopShare) {
    elements.btnStopShare.classList.add('hidden');
  }
  if (elements.hostStatus) {
    elements.hostStatus.textContent = '准备就绪';
    elements.hostStatus.classList.remove('waiting');
  }
  if (elements.hostP2pStatus) {
    elements.hostP2pStatus.dataset.p2pState = 'idle';
    elements.hostP2pStatus.textContent = 'P2P：等待';
  }
  renderHostPublicListingUi();
  } finally {
    fallbackStopShareInFlight = false;
    if (elements.btnStopShare) {
      elements.btnStopShare.disabled = false;
    }
  }
}

async function resetViewerState() {
  if (viewerAudioDelayApplyTimer) {
    clearTimeout(viewerAudioDelayApplyTimer);
    viewerAudioDelayApplyTimer = null;
  }
  viewerAudioDelayApplySeq += 1;
  currentRoomId = null;
  sessionRole = null;
  currentSessionToken = null;
  hostId = null;
  upstreamPeerId = null;
  myChainPosition = -1;
  syncAppState({
    role: null,
    roomId: null,
    sessionToken: null,
    hostId: null,
    upstreamPeerId: null,
    chainPosition: -1,
    mediaManifest: null
  }, { reason: 'reset-viewer' });
  viewerReadySent = false;
  videoStarted = false;
  upstreamConnected = false;
  relayPc = null;
  relayStream = null;
  cancelPublicRoomsRefresh();
  cancelPendingViewerJoin();
  clearPendingSignalingQueues('reset-viewer');

  await clearAllPeerConnections({ clearRetryState: true });
  elements.joinForm.classList.remove('hidden');
  elements.viewerStatus.classList.add('hidden');
  elements.btnLeave.classList.add('hidden');
  elements.remoteVideo.srcObject = null;
  elements.waitingMessage.classList.remove('hidden');
  elements.connectionStatus.textContent = '等待连接...';
  elements.connectionStatus.classList.remove('connected');
  if (elements.viewerP2pStatus) {
    elements.viewerP2pStatus.dataset.p2pState = 'idle';
    elements.viewerP2pStatus.textContent = 'P2P：等待';
  }
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

function createPeerConnection(peerId, isInitiator, kind = 'direct', options = {}) {
  return requireNativeAuthorityOverride('createPeerConnection', createPeerConnection)(peerId, isInitiator, kind, options);
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

if (window.VDS && window.VDS.roomClient && typeof window.VDS.roomClient.installLegacyAdapter === 'function') {
  window.VDS.roomClient.installLegacyAdapter({
    getWebSocketUrl: () => wsBaseUrl,
    debugLog,
    onWebSocketOpen: () => {
      wsConnected = true;
      syncAppState({ connectionState: 'connected' }, { reason: 'ws-open' });
    },
    onWebSocketClose: ({ manualClose } = {}) => {
      wsConnected = false;
      syncAppState({ connectionState: 'disconnected' }, { reason: 'ws-close' });
    },
    onWebSocketUnexpectedClose: () => {
      resumeOnNextConnect = Boolean(currentRoomId && sessionRole);
      return true;
    },
    onWebSocketDisconnected: () => {
      wsConnected = false;
    },
    onReconnectScheduled: ({ delay } = {}) => {
      if (isHost && elements.hostStatus) {
        elements.hostStatus.textContent = '正在重连...';
        elements.hostStatus.classList.add('waiting');
      } else if (!isHost && elements.connectionStatus) {
        elements.connectionStatus.textContent = '正在重连...';
      }
    },
    consumeResumeSessionMessage: () => {
      if (!resumeOnNextConnect || !currentRoomId || !sessionRole) {
        return null;
      }
      resumeOnNextConnect = false;
      return {
        type: 'resume-session',
        roomId: currentRoomId,
        clientId,
        role: sessionRole,
        sessionToken: currentSessionToken || '',
        needsMediaReconnect: sessionRole === 'viewer' && !upstreamConnected
      };
    },
    joinRoomById,
    leaveRoom,
    handleMessage
  });
}
