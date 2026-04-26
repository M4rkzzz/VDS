(function installNativeAuthorityOverrides() {
  if (window.__vdsNativeAuthorityOverridesInstalled) {
    return;
  }
  window.__vdsNativeAuthorityOverridesInstalled = true;

  const electronApi = window.electronAPI || null;
  const mediaEngine = electronApi && electronApi.mediaEngine ? electronApi.mediaEngine : null;
  const runtimeConfig =
    electronApi && typeof electronApi.getRuntimeConfig === 'function'
      ? (electronApi.getRuntimeConfig() || {})
      : {};

  const nativePeerTransportEnabled = Boolean(
    window.isElectron &&
    mediaEngine &&
    runtimeConfig.enableNativePeerTransport !== false
  );
  const nativeHostSessionEnabled = Boolean(
    window.isElectron &&
    mediaEngine &&
    runtimeConfig.enableNativeHostSessionBridge !== false
  );
  const nativeHostPreviewEnabled = Boolean(
    window.isElectron &&
    mediaEngine &&
    runtimeConfig.enableNativeHostPreviewSurface !== false
  );
  const nativeSurfaceEmbeddingEnabled = runtimeConfig.enableNativeSurfaceEmbedding !== false;
  const verboseNativeLogs = Boolean(runtimeConfig.verboseMediaLogs);

  if (!window.isElectron || !mediaEngine) {
    throw new Error('native-media-engine-unavailable');
  }

  const hostVideoContainer = document.getElementById('video-container');
  const remoteVideoContainer = document.getElementById('remote-video-container');
  const hostFullscreenButton = document.getElementById('btn-host-fullscreen');
  const viewerFullscreenButton = document.getElementById('btn-viewer-fullscreen');
  const viewerVolumeInput = document.getElementById('viewer-volume');
  const viewerVolumeValue = document.getElementById('viewer-volume-value');
  const viewerFullscreenUnderbar = document.getElementById('viewer-fullscreen-underbar');
  const viewerFullscreenVolumeControl = document.getElementById('viewer-fullscreen-volume-control');
  const viewerFullscreenMuteButton = document.getElementById('btn-viewer-mute-fullscreen');
  const viewerFullscreenExitButton = document.getElementById('btn-viewer-exit-fullscreen');
  const viewerFullscreenVolumeInput = document.getElementById('viewer-volume-fullscreen');
  const viewerFullscreenVolumeValue = document.getElementById('viewer-volume-fullscreen-value');

  const nativePeerHandles = new Map();
  const nativePeerSignalBacklog = new Map();
  const nativePeerSignalWaiters = new Map();
  const attachedEmbeddedSurfaces = new Map();
  const nativeDebugRateLimitState = new Map();
  const P2P_UI_STATE_LABELS = Object.freeze({
    idle: '等待',
    gathering: '收集候选',
    checking: '连接检查',
    connected: '已直连',
    'media-waiting': '媒体等待',
    disconnected: '连接断开',
    'restart-attempting': '重连中',
    failed: '失败',
    'waiting-viewer': '等待观众',
    'nat-mapping': '端口映射'
  });
  const VIEWER_MEDIA_WAIT_TIMEOUT_MS = 7000;
  const P2P_NAT_MAPPING_TIMEOUT_MS = 6000;
  const P2P_NAT_MAPPING_CONNECT_WAIT_MS = 7000;
  const P2P_NAT_MAPPING_MAX_CANDIDATES = 4;

  const HOST_PREVIEW_SURFACE_ID = 'embedded-host-preview';

  let nativeHostSessionRunning = false;
  let nativeViewerStatsIntervalId = null;
  let nativeHostStatsIntervalId = null;
  let mediaEngineStarted = false;
  let mediaEngineStartPromise = null;
  let nativeUiReadyPromise = null;
  let hostPreviewSurfaceAttached = false;
  let viewerVolumeSynced = false;
  let embeddedSurfaceSyncRafId = 0;
  let embeddedSurfaceSyncInFlight = false;
  let embeddedSurfaceSyncPending = false;
  let embeddedSurfaceTrackingRafId = 0;
  let wheelDrivenSyncRafId = 0;
  let wheelDrivenSyncFramesRemaining = 0;
  const embeddedSurfaceTrackingIntervalMs = 180;
  let currentWindowBounds = null;
  let hostPreviewRequested = true;
  let hostSourceFramesSample = null;
  let hostPreviewFramesSample = null;
  let hostSendFramesSample = null;
  let viewerReceivedFramesSample = null;
  let viewerRenderedFramesSample = null;
  let viewerFramesSampleAtMs = 0;
  let hostFramesSampleAtMs = 0;
  let stopScreenShareInFlight = false;
  let hostWaitingWindowRestore = false;
  let nativeHostEffectiveCodec = 'h264';
  let currentHostBackend = 'native';
  let obsRoomCreatePending = false;
  let viewerMediaWaitTimerId = null;
  let latestP2pStatsSnapshot = null;
  let latestHostCaptureDiagnosticReport = '等待采集数据...';
  let obsIngestStreamActive = false;
  let viewerFullscreenControlsHideTimerId = 0;
  let viewerFullscreenCursorPollTimerId = 0;
  let viewerFullscreenVolumePopoverHideTimerId = 0;
  let viewerFullscreenVolumeDragging = false;
  let lastViewerCursorPoint = null;
  let lastNonZeroViewerVolume = 100;
  const recoverableSurfaceSyncWarnings = new Map();
  const recoverableNativeWarnings = new Map();

  function isDebugModeEnabled() {
    if (typeof window.__vdsIsDebugModeEnabled === 'function') {
      try {
        return Boolean(window.__vdsIsDebugModeEnabled());
      } catch (_error) {
        return false;
      }
    }
    try {
      return window.localStorage.getItem('vds-debug-mode') === '1';
    } catch (_error) {
      return false;
    }
  }

  function shouldShowDebugLogs() {
    return shouldShowDebugLogsFor('misc', 'renderer');
  }

  function isBlockingModalVisible() {
    return Boolean(document.querySelector('.modal:not(.hidden)'));
  }

  function isVerboseMediaLoggingEnabled() {
    return verboseNativeLogs;
  }

  function shouldShowDebugLogsFor(category = 'misc', channel = 'renderer') {
    if (verboseNativeLogs) {
      return true;
    }

    if (typeof window.__vdsShouldDebugLog === 'function') {
      try {
        return Boolean(window.__vdsShouldDebugLog(category, channel));
      } catch (_error) {
        return false;
      }
    }

    return isDebugModeEnabled();
  }

  function shouldEmitNativeDebugLog(key, intervalMs = 1000) {
    if (verboseNativeLogs || intervalMs <= 0) {
      return { emit: true, suppressed: 0 };
    }

    const now = Date.now();
    const state = nativeDebugRateLimitState.get(key) || { lastAt: 0, suppressed: 0 };
    if (now - state.lastAt < intervalMs) {
      state.suppressed += 1;
      nativeDebugRateLimitState.set(key, state);
      return { emit: false, suppressed: state.suppressed };
    }

    const suppressed = state.suppressed;
    nativeDebugRateLimitState.set(key, { lastAt: now, suppressed: 0 });
    return { emit: true, suppressed };
  }

  function appendSuppressedDebugCount(payload, suppressed) {
    if (!suppressed) {
      return payload;
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return {
        ...payload,
        suppressed
      };
    }
    return {
      value: payload,
      suppressed
    };
  }

  function getNativeDebugCategoryFromScope(scope) {
    const value = String(scope || '').toLowerCase();
    if (
      value.startsWith('signal:') ||
      value.includes('createpeer') ||
      value.includes('setremotedescription') ||
      value.includes('addremoteicecandidate')
    ) {
      return 'connection';
    }

    if (value.includes('audio') || value.includes('volume')) {
      return 'audio';
    }

    if (
      value.includes('surface') ||
      value.includes('hostpreview') ||
      value.includes('peervideo') ||
      value.includes('hostsession')
    ) {
      return 'video';
    }

    if (value.includes('update')) {
      return 'update';
    }

    return 'misc';
  }

  function getNativeDebugCategoryFromEvent(event) {
    const eventName = String(event && event.event ? event.event : '').toLowerCase();
    const scope = String(event && event.params && event.params.scope ? event.params.scope : '').toLowerCase();

    if (eventName === 'signal' || eventName === 'peer-state') {
      return 'connection';
    }

    if (scope === 'audio' || eventName === 'audio-data') {
      return 'audio';
    }

    if (scope === 'surface' || scope === 'host-capture' || eventName === 'media-state') {
      return 'video';
    }

    if (scope === 'update') {
      return 'update';
    }

    return 'misc';
  }

  function summarizeNativeLogValue(value, depth = 0) {
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
        layout: summarizeNativeLogValue(value.layout, depth + 1),
        windowTitle: value.windowTitle,
        reason: value.reason,
        lastError: summarizeNativeLogValue(value.lastError, depth + 1),
        embeddedParentDebug: summarizeNativeLogValue(value.embeddedParentDebug, depth + 1),
        surfaceWindowDebug: summarizeNativeLogValue(value.surfaceWindowDebug, depth + 1)
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
      return value.length > 320 ? `${value.slice(0, 320)}...<${value.length}>` : value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 10).map((entry) => summarizeNativeLogValue(entry, depth + 1));
    }

    if (typeof value === 'object') {
      const output = {};
      for (const [key, entry] of Object.entries(value)) {
        output[key] = summarizeNativeLogValue(entry, depth + 1);
      }
      return output;
    }

    return value;
  }

  function logNativeDebug(category, ...args) {
    if (!shouldShowDebugLogsFor(category, 'renderer')) {
      return;
    }
    console.log(...args);
  }

  function logNativeStep(scope, payload, category = getNativeDebugCategoryFromScope(scope)) {
    if (!shouldShowDebugLogsFor(category, 'nativeSteps')) {
      return;
    }
    const rate = shouldEmitNativeDebugLog(`step:${category}:${scope}`, 1000);
    if (!rate.emit) {
      return;
    }
    const normalized = summarizeNativeLogValue(appendSuppressedDebugCount(payload, rate.suppressed));
    try {
      console.log(`[media-engine step] ${scope} ${JSON.stringify(normalized)}`);
    } catch (_error) {
      console.log(`[media-engine step] ${scope}`, normalized || null);
    }
  }

  function logNativeStatsLine(label, fields, suppressed = 0) {
    if (!shouldShowDebugLogsFor('video', 'periodicStats')) {
      return;
    }
    console.log(
      label,
      ...fields,
      suppressed ? `suppressed=${suppressed}` : ''
    );
  }

  function logNativeWarningLine(label, ...args) {
    console.warn(label, ...args);
  }

  function logRecoverableSurfaceSyncWarning(surfaceId, error) {
    const message = error && error.message ? error.message : String(error);
    const now = Date.now();
    const lastLoggedAt = recoverableSurfaceSyncWarnings.get(surfaceId) || 0;
    if (!shouldShowDebugLogsFor('video', 'nativeSteps') && now - lastLoggedAt < 5000) {
      return;
    }
    recoverableSurfaceSyncWarnings.set(surfaceId, now);
    if (shouldShowDebugLogsFor('video', 'nativeSteps')) {
      logNativeStep('updateSurface:recoverable-error', { surfaceId, message }, 'video');
      return;
    }
    logNativeWarningLine('[media-engine] surface sync failed:', surfaceId, message);
  }

  function clearRecoverableSurfaceSyncWarning(surfaceId) {
    if (!surfaceId) {
      return;
    }
    recoverableSurfaceSyncWarnings.delete(surfaceId);
  }

  function logRecoverableNativeWarning(scope, error, {
    key = scope,
    category = 'video',
    channel = 'nativeSteps',
    intervalMs = 5000,
    fallbackLabel = '[media-engine]'
  } = {}) {
    const message = error && error.message ? error.message : String(error);
    const now = Date.now();
    const lastLoggedAt = recoverableNativeWarnings.get(key) || 0;
    if (!shouldShowDebugLogsFor(category, channel) && now - lastLoggedAt < intervalMs) {
      return;
    }
    recoverableNativeWarnings.set(key, now);
    if (shouldShowDebugLogsFor(category, channel)) {
      logNativeStep(scope, { key, message }, category);
      return;
    }
    logNativeWarningLine(fallbackLabel, message);
  }

  function waitForNextPaint() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
  }

  function normalizeHostBackendName(backend) {
    return String(backend || '').trim().toLowerCase() === 'obs-ingest' ? 'obs-ingest' : 'native';
  }

  function getRequestedHostBackend() {
    if (typeof qualitySettings === 'object' && qualitySettings) {
      return normalizeHostBackendName(qualitySettings.hostBackend);
    }
    return 'native';
  }

  function isObsIngestHostBackend(backend = currentHostBackend) {
    return normalizeHostBackendName(backend) === 'obs-ingest';
  }

  function shouldShowNativeHostPreviewForBackend(backend = currentHostBackend) {
    return !isObsIngestHostBackend(backend) &&
      nativeHostPreviewEnabled &&
      !(typeof qualitySettings === 'object' && qualitySettings && qualitySettings.previewEnabled === false);
  }

  function isViewerFullscreenMode() {
    return document.body.classList.contains('native-embedded-fullscreen') &&
      document.body.getAttribute('data-app-view') === 'viewer';
  }

  function shouldReserveViewerFullscreenUnderbarSpace() {
    return isViewerFullscreenMode() && (
      document.body.classList.contains('viewer-fullscreen-controls-visible') ||
      (viewerFullscreenUnderbar && viewerFullscreenUnderbar.matches(':hover'))
    );
  }

  function isViewerFullscreenVolumePopoverPinned() {
    return Boolean(
      viewerFullscreenVolumeDragging ||
      (viewerFullscreenVolumeControl && viewerFullscreenVolumeControl.matches(':hover'))
    );
  }

  function isViewerFullscreenUnderbarPinned() {
    return Boolean(
      (viewerFullscreenUnderbar && viewerFullscreenUnderbar.matches(':hover')) ||
      isViewerFullscreenVolumePopoverPinned()
    );
  }

  function clearViewerFullscreenVolumePopoverHideTimer() {
    if (viewerFullscreenVolumePopoverHideTimerId) {
      window.clearTimeout(viewerFullscreenVolumePopoverHideTimerId);
      viewerFullscreenVolumePopoverHideTimerId = 0;
    }
  }

  function setViewerFullscreenVolumePopoverOpen(open) {
    if (!viewerFullscreenVolumeControl) {
      return;
    }
    if (open) {
      viewerFullscreenVolumeControl.classList.add('is-open');
      clearViewerFullscreenVolumePopoverHideTimer();
      return;
    }
    viewerFullscreenVolumeControl.classList.remove('is-open');
    clearViewerFullscreenVolumePopoverHideTimer();
  }

  function scheduleViewerFullscreenVolumePopoverHide(delayMs = 900) {
    if (!viewerFullscreenVolumeControl) {
      return;
    }
    clearViewerFullscreenVolumePopoverHideTimer();
    viewerFullscreenVolumePopoverHideTimerId = window.setTimeout(() => {
      viewerFullscreenVolumePopoverHideTimerId = 0;
      if (isViewerFullscreenVolumePopoverPinned()) {
        scheduleViewerFullscreenVolumePopoverHide(600);
        return;
      }
      setViewerFullscreenVolumePopoverOpen(false);
    }, delayMs);
  }

  function syncViewerFullscreenUnderbarState() {
    const active = isViewerFullscreenMode();
    if (viewerFullscreenUnderbar) {
      viewerFullscreenUnderbar.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    if (!active) {
      document.body.classList.remove('viewer-fullscreen-controls-visible');
      setViewerFullscreenVolumePopoverOpen(false);
      if (viewerFullscreenControlsHideTimerId) {
        window.clearTimeout(viewerFullscreenControlsHideTimerId);
        viewerFullscreenControlsHideTimerId = 0;
      }
      stopViewerFullscreenCursorPolling();
    }
  }

  function isCursorInsideCurrentWindow(point) {
    if (!point || !currentWindowBounds) {
      return false;
    }
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return false;
    }
    return x >= currentWindowBounds.x &&
      y >= currentWindowBounds.y &&
      x < currentWindowBounds.x + currentWindowBounds.width &&
      y < currentWindowBounds.y + currentWindowBounds.height;
  }

  function stopViewerFullscreenCursorPolling() {
    if (viewerFullscreenCursorPollTimerId) {
      window.clearInterval(viewerFullscreenCursorPollTimerId);
      viewerFullscreenCursorPollTimerId = 0;
    }
    lastViewerCursorPoint = null;
  }

  function startViewerFullscreenCursorPolling() {
    if (
      viewerFullscreenCursorPollTimerId ||
      !electronApi ||
      typeof electronApi.getCursorScreenPoint !== 'function'
    ) {
      return;
    }

    viewerFullscreenCursorPollTimerId = window.setInterval(async () => {
      if (!isViewerFullscreenMode()) {
        stopViewerFullscreenCursorPolling();
        return;
      }

      try {
        const point = await electronApi.getCursorScreenPoint();
        const normalizedPoint = {
          x: Number(point && point.x) || 0,
          y: Number(point && point.y) || 0
        };

        if (!isCursorInsideCurrentWindow(normalizedPoint)) {
          lastViewerCursorPoint = normalizedPoint;
          return;
        }

        const moved =
          !lastViewerCursorPoint ||
          Math.abs(normalizedPoint.x - lastViewerCursorPoint.x) >= 2 ||
          Math.abs(normalizedPoint.y - lastViewerCursorPoint.y) >= 2;

        lastViewerCursorPoint = normalizedPoint;
        if (moved) {
          showViewerFullscreenControls();
        }
      } catch (_error) {
        // Ignore cursor polling failures; controls can still be shown by direct hover when visible.
      }
    }, 120);
  }

  function scheduleViewerFullscreenControlsHide(delayMs = 2200) {
    if (!isViewerFullscreenMode()) {
      return;
    }
    if (viewerFullscreenControlsHideTimerId) {
      window.clearTimeout(viewerFullscreenControlsHideTimerId);
    }
    viewerFullscreenControlsHideTimerId = window.setTimeout(() => {
      viewerFullscreenControlsHideTimerId = 0;
      if (!isViewerFullscreenMode()) {
        return;
      }
      if (isViewerFullscreenVolumePopoverPinned()) {
        scheduleViewerFullscreenVolumePopoverHide(800);
        scheduleViewerFullscreenControlsHide(900);
        return;
      }
      if (isViewerFullscreenUnderbarPinned()) {
        scheduleViewerFullscreenControlsHide(1200);
        return;
      }
      setViewerFullscreenVolumePopoverOpen(false);
      document.body.classList.remove('viewer-fullscreen-controls-visible');
      forceEmbeddedSurfaceResync();
    }, delayMs);
  }

  function showViewerFullscreenControls() {
    if (!isViewerFullscreenMode()) {
      return;
    }
    document.body.classList.add('viewer-fullscreen-controls-visible');
    startViewerFullscreenCursorPolling();
    forceEmbeddedSurfaceResync();
    scheduleViewerFullscreenControlsHide();
  }

  function applyViewerVolumeUi(volume) {
    const normalizedVolume = Math.max(0, Math.min(100, Number(volume) || 0));
    if (normalizedVolume > 0) {
      lastNonZeroViewerVolume = normalizedVolume;
    }

    if (viewerVolumeInput) {
      viewerVolumeInput.value = String(normalizedVolume);
    }
    if (viewerVolumeValue) {
      viewerVolumeValue.textContent = `${normalizedVolume}%`;
    }
    if (viewerFullscreenVolumeInput) {
      viewerFullscreenVolumeInput.value = String(normalizedVolume);
    }
    if (viewerFullscreenVolumeValue) {
      viewerFullscreenVolumeValue.textContent = `${normalizedVolume}%`;
    }
    if (viewerFullscreenMuteButton) {
      const volumeState = normalizedVolume <= 0 ? 'muted' : (normalizedVolume < 45 ? 'low' : 'high');
      viewerFullscreenMuteButton.dataset.volumeState = volumeState;
      viewerFullscreenMuteButton.setAttribute('aria-pressed', normalizedVolume <= 0 ? 'true' : 'false');
      viewerFullscreenMuteButton.setAttribute('aria-label', normalizedVolume <= 0 ? '取消静音' : '静音');
    }
  }

  async function setViewerVolumeValue(nextValue) {
    const normalizedVolume = Math.max(0, Math.min(100, Number(nextValue) || 0));
    applyViewerVolumeUi(normalizedVolume);
    await mediaEngine.setViewerVolume(normalizedVolume / 100);
  }

  async function toggleViewerMute() {
    const currentVolume = Math.max(0, Math.min(100, Number(viewerVolumeInput && viewerVolumeInput.value) || 0));
    const nextVolume = currentVolume <= 0 ? Math.max(1, lastNonZeroViewerVolume || 100) : 0;
    await setViewerVolumeValue(nextVolume);
    showViewerFullscreenControls();
  }

  async function exitViewerFullscreen() {
    if (!electronApi || typeof electronApi.isFullscreen !== 'function') {
      return;
    }
    const isFullscreen = await electronApi.isFullscreen();
    if (!isFullscreen) {
      return;
    }
    const nextState = await electronApi.setFullscreen(false);
    updateFullscreenUi(nextState);
  }

  async function waitForHostUiReady() {
    if (!hostVideoContainer) {
      return;
    }
    await waitForNextPaint();
    hostVideoContainer.getBoundingClientRect();
    await waitForNextPaint();
  }

  function setHostStopUiState(stopping) {
    if (elements.btnStopShare) {
      elements.btnStopShare.disabled = Boolean(stopping);
    }
    if (elements.btnStartShare) {
      elements.btnStartShare.disabled = Boolean(stopping);
    }
    if (stopping && elements.hostStatus) {
      elements.hostStatus.textContent = '正在结束直播...';
    }
  }

  function syncHostWaitingWindowRestoreUi(waiting, restoredText = '原生分享已恢复') {
    hostWaitingWindowRestore = Boolean(waiting);
    if (!elements.hostStatus) {
      return;
    }

    if (isObsIngestHostBackend()) {
      elements.hostStatus.textContent = waiting ? '等待 OBS 推流...' : restoredText;
      elements.hostStatus.classList.toggle('waiting', Boolean(waiting));
      return;
    }

    if (hostWaitingWindowRestore) {
      elements.hostStatus.textContent = '等待窗口恢复...';
      elements.hostStatus.classList.add('waiting');
      return;
    }

    elements.hostStatus.textContent = restoredText;
    elements.hostStatus.classList.remove('waiting');
  }

  function resetHostUiAfterFailedStart() {
    nativeHostSessionRunning = false;
    hostWaitingWindowRestore = false;
    obsRoomCreatePending = false;
    obsIngestStreamActive = false;
    currentHostBackend = getRequestedHostBackend();
    hostPreviewSurfaceAttached = false;
    stopNativeHostStatsPolling();
    resetHostFpsIndicators();
    updateHostEncoderDetail(null);
    hideLegacyVideoElements();
    hostPreviewRequested = shouldShowNativeHostPreviewForBackend(currentHostBackend);
    if (hostVideoContainer) {
      hostVideoContainer.classList.toggle('hidden', !hostPreviewRequested);
    }
    if (elements.btnStartShare) {
      elements.btnStartShare.classList.remove('hidden');
      elements.btnStartShare.disabled = false;
    }
    if (elements.btnStopShare) {
      elements.btnStopShare.classList.add('hidden');
      elements.btnStopShare.disabled = false;
    }
    if (elements.hostStatus) {
      elements.hostStatus.textContent = '准备就绪';
      elements.hostStatus.classList.remove('waiting');
    }
  }

  function isRecoverableHostPreviewAttachError(error) {
    const message = error && error.message ? error.message : String(error);
    return message.includes('media-engine-attach-surface') ||
      message.includes('attachSurface') ||
      message.includes('media-agent-exited');
  }

  async function cleanupAfterFailedHostStart() {
    hostPreviewSurfaceAttached = false;
    attachedEmbeddedSurfaces.delete(HOST_PREVIEW_SURFACE_ID);
    clearRecoverableSurfaceSyncWarning(HOST_PREVIEW_SURFACE_ID);
    stopEmbeddedSurfaceTrackingLoop();
    await Promise.all([
      typeof mediaEngine.stopAudioSession === 'function'
        ? mediaEngine.stopAudioSession({}).catch(() => {})
        : Promise.resolve(null),
      typeof mediaEngine.stopHostSession === 'function'
        ? mediaEngine.stopHostSession({}).catch(() => {})
        : Promise.resolve(null)
    ]);
    resetHostUiAfterFailedStart();
  }

  async function ensureNativeUiReady() {
    if (nativeUiReadyPromise) {
      await nativeUiReadyPromise;
    }
  }

  function describeSurfaceElement(element) {
    if (!element) {
      return { missing: true };
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      id: element.id || '',
      className: element.className || '',
      clientWidth: element.clientWidth || 0,
      clientHeight: element.clientHeight || 0,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      },
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      zIndex: style.zIndex,
      overflow: style.overflow,
      hiddenClass: element.classList ? element.classList.contains('hidden') : false
    };
  }

  function isNativePeerDriverActive() {
    return nativePeerTransportEnabled;
  }

  function isNativePeerHandle(handle) {
    return Boolean(handle && handle.__nativePeerHandle === true);
  }

  function normalizeNativeSessionDescription(description) {
    if (!description) {
      return { type: '', sdp: '' };
    }

    return {
      type: String(description.type || ''),
      sdp: String(description.sdp || '')
    };
  }

  function buildRemoteCandidateKey(candidate) {
    if (!candidate) {
      return '';
    }

    if (typeof candidate === 'string') {
      return candidate.trim();
    }

    return JSON.stringify({
      candidate: String(candidate.candidate || '').trim(),
      sdpMid: String(candidate.sdpMid || ''),
      sdpMLineIndex: Number.isFinite(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null
    });
  }

  function getIceCandidateText(candidate) {
    if (!candidate) {
      return '';
    }
    if (typeof candidate === 'string') {
      return candidate;
    }
    return String(candidate.candidate || '');
  }

  function isAllowedPureP2pCandidate(candidate) {
    const candidateText = getIceCandidateText(candidate);
    if (!candidateText) {
      return false;
    }
    return !/\btyp\s+relay\b/i.test(candidateText);
  }

  function isSameRemoteDescription(currentDescription, incomingDescription) {
    if (!currentDescription || !incomingDescription) {
      return false;
    }

    const normalizedIncoming = normalizeNativeSessionDescription(incomingDescription);
    return (
      currentDescription.type === normalizedIncoming.type &&
      currentDescription.sdp === normalizedIncoming.sdp
    );
  }

  function logNativeMediaEngineEventSummary(event) {
    if (!event || !event.event) {
      return;
    }

    const eventName = String(event.event || '').toLowerCase();
    const stateName = String(event && event.params && event.params.state ? event.params.state : '').toLowerCase();
    const debugCategory = getNativeDebugCategoryFromEvent(event);
    const isHighFrequencySurfaceEvent =
      eventName === 'media-state' &&
      (
        stateName === 'surface-updated' ||
        stateName === 'surface-attached' ||
        stateName === 'surface-detached'
      );

    if (isHighFrequencySurfaceEvent && !isVerboseMediaLoggingEnabled()) {
      return;
    }

    if (shouldShowDebugLogsFor(debugCategory, 'nativeEvents')) {
      const rate = shouldEmitNativeDebugLog(`event:${debugCategory}:${eventName}:${stateName}`, 1000);
      if (!rate.emit) {
        return;
      }
      console.log(
        'Native media engine event:',
        event.event,
        appendSuppressedDebugCount(event.params || null, rate.suppressed)
      );
    }
  }

  function getNativeSignalPeerId(params) {
    if (!params) {
      return '';
    }

    return params.peerId || params.targetId || params.remotePeerId || '';
  }

  function updateNativePeerSignalState(peerId, params) {
    const handle = nativePeerHandles.get(peerId);
    if (!handle || !params) {
      return;
    }

    if (params.sdp && params.type) {
      handle.localDescription = normalizeNativeSessionDescription(params.sdp);
      if (params.type === 'offer') {
        handle.signalingState = 'have-local-offer';
      } else if (params.type === 'answer') {
        handle.signalingState = 'stable';
      }
    }
  }

  function enqueueNativePeerSignal(params) {
    const peerId = getNativeSignalPeerId(params);
    if (!peerId) {
      return;
    }

    const waiterKey = `${peerId}:${params.type || '*'}`;
    const waiters = nativePeerSignalWaiters.get(waiterKey);
    if (waiters && waiters.length > 0) {
      const resolve = waiters.shift();
      if (waiters.length === 0) {
        nativePeerSignalWaiters.delete(waiterKey);
      }
      resolve(params);
      return;
    }

    if (!nativePeerSignalBacklog.has(peerId)) {
      nativePeerSignalBacklog.set(peerId, []);
    }
    nativePeerSignalBacklog.get(peerId).push(params);
  }

  function waitForNativePeerSignal(peerId, type, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const key = `${peerId}:${type || '*'}`;
      const backlog = nativePeerSignalBacklog.get(peerId) || [];
      const backlogIndex = backlog.findIndex((entry) => !type || type === '*' || entry.type === type);
      if (backlogIndex >= 0) {
        const [payload] = backlog.splice(backlogIndex, 1);
        if (backlog.length > 0) {
          nativePeerSignalBacklog.set(peerId, backlog);
        } else {
          nativePeerSignalBacklog.delete(peerId);
        }
        resolve(payload);
        return;
      }

      const timerId = setTimeout(() => {
        const waiters = nativePeerSignalWaiters.get(key) || [];
        const filtered = waiters.filter((entry) => entry !== resolver);
        if (filtered.length > 0) {
          nativePeerSignalWaiters.set(key, filtered);
        } else {
          nativePeerSignalWaiters.delete(key);
        }
        reject(new Error(`native-peer-signal-timeout:${peerId}:${type || '*'}`));
      }, timeoutMs);

      const resolver = (payload) => {
        clearTimeout(timerId);
        resolve(payload);
      };

      if (!nativePeerSignalWaiters.has(key)) {
        nativePeerSignalWaiters.set(key, []);
      }
      nativePeerSignalWaiters.get(key).push(resolver);
    });
  }

  function dropQueuedNativePeerSignals(peerId, predicate) {
    if (!peerId || typeof predicate !== 'function') {
      return;
    }

    const backlog = nativePeerSignalBacklog.get(peerId);
    if (!Array.isArray(backlog) || backlog.length === 0) {
      return;
    }

    const filtered = backlog.filter((entry) => !predicate(entry));
    if (filtered.length > 0) {
      nativePeerSignalBacklog.set(peerId, filtered);
    } else {
      nativePeerSignalBacklog.delete(peerId);
    }
  }

  function extractNativeSignalSdpText(signal) {
    if (!signal) {
      return '';
    }

    if (signal.sdp && typeof signal.sdp === 'object') {
      return String(signal.sdp.sdp || '');
    }

    if (typeof signal.sdp === 'string') {
      return signal.sdp;
    }

    return '';
  }

  function isMediaOfferSignal(signal) {
    const sdpText = extractNativeSignalSdpText(signal);
    return sdpText.includes('m=video');
  }

  async function waitForNativeMediaOffer(peerId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const signal = await waitForNativePeerSignal(peerId, 'offer', remainingMs);
      if (isMediaOfferSignal(signal)) {
        return signal;
      }
    }

    throw new Error(`native-peer-media-offer-timeout:${peerId}`);
  }

  function logNativeMediaCapabilities(capabilities) {
    if (capabilities) {
      logNativeDebug('misc', 'Native media engine capabilities:', capabilities);
    }
  }

  function buildSurfaceLayout(element, options = {}) {
    const shouldLog = options.log !== false;
    const rect = element.getBoundingClientRect();
    const scale = Math.max(1, Number(window.devicePixelRatio) || 1);
    const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
    const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
    const clippedLeft = Math.max(0, Math.min(viewportWidth, rect.left));
    const clippedTop = Math.max(0, Math.min(viewportHeight, rect.top));
    const clippedRight = Math.max(0, Math.min(viewportWidth, rect.right));
    const clippedBottom = Math.max(0, Math.min(viewportHeight, rect.bottom));
    let reservedBottom = 0;
    if (
      element === remoteVideoContainer &&
      shouldReserveViewerFullscreenUnderbarSpace() &&
      viewerFullscreenUnderbar
    ) {
      const underbarRect = viewerFullscreenUnderbar.getBoundingClientRect();
      if (underbarRect && Number.isFinite(underbarRect.height) && underbarRect.height > 0) {
        reservedBottom = Math.max(58, Math.round(underbarRect.height + 10));
      }
    }
    const adjustedClippedBottom = Math.max(clippedTop, clippedBottom - reservedBottom);
    const cssWidth = Math.max(0, Math.round(clippedRight - clippedLeft));
    const cssHeight = Math.max(0, Math.round(adjustedClippedBottom - clippedTop));
    const visible =
      cssWidth > 1 &&
      cssHeight > 1 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight &&
      !isBlockingModalVisible();
    const windowX = currentWindowBounds && Number.isFinite(currentWindowBounds.x)
      ? currentWindowBounds.x
      : window.screenX;
    const windowY = currentWindowBounds && Number.isFinite(currentWindowBounds.y)
      ? currentWindowBounds.y
      : window.screenY;

    if (!nativeSurfaceEmbeddingEnabled) {
      const layout = {
        embedded: false,
        visible,
        width: Math.max(1, cssWidth),
        height: Math.max(1, cssHeight)
      };
      if (shouldLog) {
        logNativeStep('buildSurfaceLayout:detached', {
          elementId: element.id || '',
          width: cssWidth,
          height: cssHeight,
          reservedBottom
        });
      }
      return layout;
    }

    // Overlay popup positioning tracks Chromium in CSS pixels. Scaling here causes
    // oversized windows and coordinate drift on scroll.
    const layout = {
      embedded: true,
      visible,
      x: Math.round(windowX + clippedLeft),
      y: Math.round(windowY + clippedTop),
      width: Math.max(1, cssWidth),
      height: Math.max(1, cssHeight)
    };
    Object.defineProperty(layout, '__syncKey', {
      value: JSON.stringify({
        embedded: true,
        visible,
        relativeLeft: Math.round(clippedLeft),
        relativeTop: Math.round(clippedTop),
        width: Math.max(1, cssWidth),
        height: Math.max(1, cssHeight)
      }),
      enumerable: false
    });
    if (shouldLog) {
      logNativeStep('buildSurfaceLayout:embedded', {
        elementId: element.id || '',
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        clippedRect: {
          left: clippedLeft,
          top: clippedTop,
          width: cssWidth,
          height: cssHeight,
          reservedBottom
        },
        viewport: {
          width: viewportWidth,
          height: viewportHeight
        },
        scale,
        coordinateMode: 'css-px-overlay',
        layout
      });
    }
    return layout;
  }

  function getSurfaceLayoutKey(layout) {
    if (!layout) {
      return '';
    }

    if (layout.__syncKey) {
      return layout.__syncKey;
    }

    return JSON.stringify({
      embedded: Boolean(layout.embedded),
      visible: layout.visible !== false,
      x: Number(layout.x || 0),
      y: Number(layout.y || 0),
      width: Number(layout.width || 0),
      height: Number(layout.height || 0)
    });
  }

  async function syncEmbeddedSurface(surfaceId) {
    const entry = attachedEmbeddedSurfaces.get(surfaceId);
    if (!entry) {
      return null;
    }

    const layout = buildSurfaceLayout(entry.element, { log: false });
    const layoutKey = getSurfaceLayoutKey(layout);
    if (layoutKey === entry.lastLayoutKey) {
      return null;
    }

    const payload = {
      surface: surfaceId,
      ...layout
    };
    if (shouldShowDebugLogsFor('video')) {
      logNativeStep('updateSurface:request', {
        surfaceId,
        target: entry.target,
        payload,
        element: describeSurfaceElement(entry.element)
      });
    }
    let result = null;
    try {
      result = await mediaEngine.updateSurface(payload);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message.includes('Surface is not attached')) {
        attachedEmbeddedSurfaces.delete(surfaceId);
        clearRecoverableSurfaceSyncWarning(surfaceId);
        if (attachedEmbeddedSurfaces.size === 0) {
          stopEmbeddedSurfaceTrackingLoop();
        }
        if (shouldShowDebugLogsFor('video', 'nativeSteps')) {
          logNativeStep('updateSurface:detached-skip', { surfaceId, message }, 'video');
        }
        return null;
      }
      throw error;
    }
    entry.lastLayoutKey = layoutKey;
    if (shouldShowDebugLogsFor('video')) {
      logNativeStep('updateSurface:result', {
        surfaceId,
        result
      });
    }
    return result;
  }

  async function syncAllEmbeddedSurfaces() {
    const jobs = [];
    attachedEmbeddedSurfaces.forEach((_entry, surfaceId) => {
      jobs.push(syncEmbeddedSurface(surfaceId).catch((error) => {
        logRecoverableSurfaceSyncWarning(surfaceId, error);
      }));
    });
    await Promise.all(jobs);
  }

  function scheduleEmbeddedSurfaceSync() {
    if (!nativeSurfaceEmbeddingEnabled) {
      return;
    }
    if (embeddedSurfaceSyncRafId) {
      return;
    }
    embeddedSurfaceSyncRafId = window.requestAnimationFrame(async () => {
      embeddedSurfaceSyncRafId = 0;
      if (embeddedSurfaceSyncInFlight) {
        embeddedSurfaceSyncPending = true;
        return;
      }

      embeddedSurfaceSyncInFlight = true;
      try {
        await syncAllEmbeddedSurfaces();
      } catch (error) {
        logRecoverableNativeWarning('syncAllEmbeddedSurfaces:failed', error, {
          key: 'sync-all-embedded-surfaces',
          category: 'video',
          channel: 'nativeSteps',
          fallbackLabel: '[media-engine] syncAllEmbeddedSurfaces failed:'
        });
      } finally {
        embeddedSurfaceSyncInFlight = false;
        if (embeddedSurfaceSyncPending) {
          embeddedSurfaceSyncPending = false;
          scheduleEmbeddedSurfaceSync();
        }
      }
    });
  }

  function invalidateEmbeddedSurfaceLayouts() {
    attachedEmbeddedSurfaces.forEach((entry) => {
      if (entry) {
        entry.lastLayoutKey = '';
      }
    });
  }

  async function refreshCurrentWindowBounds() {
    if (!electronApi || typeof electronApi.getWindowBounds !== 'function') {
      return currentWindowBounds;
    }

    try {
      const bounds = await electronApi.getWindowBounds();
      if (bounds) {
        currentWindowBounds = bounds;
      }
    } catch (_error) {
      // Keep the last known bounds when the window is mid-transition.
    }

    return currentWindowBounds;
  }

  function runWheelDrivenSurfaceSyncBurst() {
    wheelDrivenSyncRafId = 0;
    if (!nativeSurfaceEmbeddingEnabled || attachedEmbeddedSurfaces.size === 0) {
      wheelDrivenSyncFramesRemaining = 0;
      return;
    }

    scheduleEmbeddedSurfaceSync();
    wheelDrivenSyncFramesRemaining -= 1;
    if (wheelDrivenSyncFramesRemaining > 0) {
      wheelDrivenSyncRafId = window.requestAnimationFrame(runWheelDrivenSurfaceSyncBurst);
    }
  }

  function scheduleWheelDrivenSurfaceSync() {
    if (!nativeSurfaceEmbeddingEnabled || attachedEmbeddedSurfaces.size === 0) {
      return;
    }

    wheelDrivenSyncFramesRemaining = 8;
    if (!wheelDrivenSyncRafId) {
      wheelDrivenSyncRafId = window.requestAnimationFrame(runWheelDrivenSurfaceSyncBurst);
    }
  }

  function forceEmbeddedSurfaceResync() {
    if (!nativeSurfaceEmbeddingEnabled || attachedEmbeddedSurfaces.size === 0) {
      return;
    }

    const runPass = () => {
      refreshCurrentWindowBounds().finally(() => {
        invalidateEmbeddedSurfaceLayouts();
        scheduleEmbeddedSurfaceSync();
      });
    };

    runPass();
    window.requestAnimationFrame(runPass);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(runPass);
    });
    window.setTimeout(runPass, 80);
    window.setTimeout(runPass, 180);
  }

  function forceEmbeddedSurfaceResyncBurst() {
    forceEmbeddedSurfaceResync();
    window.setTimeout(forceEmbeddedSurfaceResync, 40);
    window.setTimeout(forceEmbeddedSurfaceResync, 120);
    window.setTimeout(forceEmbeddedSurfaceResync, 260);
  }

  function stopEmbeddedSurfaceTrackingLoop() {
    if (embeddedSurfaceTrackingRafId) {
      window.clearTimeout(embeddedSurfaceTrackingRafId);
      embeddedSurfaceTrackingRafId = 0;
    }
  }

  function startEmbeddedSurfaceTrackingLoop() {
    if (!nativeSurfaceEmbeddingEnabled || embeddedSurfaceTrackingRafId || attachedEmbeddedSurfaces.size === 0) {
      return;
    }

    const tick = () => {
      embeddedSurfaceTrackingRafId = 0;
      if (attachedEmbeddedSurfaces.size === 0) {
        return;
      }
      scheduleEmbeddedSurfaceSync();
      embeddedSurfaceTrackingRafId = window.setTimeout(tick, embeddedSurfaceTrackingIntervalMs);
    };

    embeddedSurfaceTrackingRafId = window.setTimeout(tick, embeddedSurfaceTrackingIntervalMs);
  }

  function hideLegacyVideoElements() {
    if (elements.localVideo) {
      elements.localVideo.srcObject = null;
      elements.localVideo.classList.add('hidden');
      elements.localVideo.controls = false;
    }

    if (elements.remoteVideo) {
      elements.remoteVideo.srcObject = null;
      elements.remoteVideo.classList.add('hidden');
      elements.remoteVideo.controls = false;
    }
  }

  function lockCodecUiToNativeH264() {
    if (typeof window.__vdsRefreshQualitySettingsUi === 'function') {
      window.__vdsRefreshQualitySettingsUi();
    }
  }

  function normalizeNativeVideoCodec(codec, fallback = 'h264') {
    const normalized = String(codec || '').trim().toLowerCase();
    if (normalized === 'h265' || normalized === 'hevc') {
      return 'h265';
    }
    if (normalized === 'h264') {
      return 'h264';
    }
    return fallback;
  }

  function parseCaptureSource(source) {
    const sourceObject = source && typeof source === 'object' ? source : null;
    const normalized = String(
      sourceObject && (sourceObject.sourceId || sourceObject.id || sourceObject.captureTargetId)
        ? (sourceObject.sourceId || sourceObject.id || sourceObject.captureTargetId)
        : (source || '')
    ).trim();
    if (!normalized) {
      throw new Error('必须提供采集源');
    }

    const requestedCodec =
      typeof getRequestedCodecPreference === 'function'
        ? getRequestedCodecPreference()
        : (qualitySettings.codecPreference || 'h264');
    const effectiveCodec =
      typeof getEffectiveCodecPreference === 'function'
        ? getEffectiveCodecPreference()
        : requestedCodec;
    const sharedConfig = {
      codec: effectiveCodec,
      requestedCodec,
      width: qualitySettings.width,
      height: qualitySettings.height,
      frameRate: qualitySettings.frameRate,
      bitrateKbps: qualitySettings.bitrate,
      hardwareAcceleration: qualitySettings.hardwareAcceleration !== false,
      videoEncoderPreference:
        qualitySettings.hardwareAcceleration !== false &&
        qualitySettings.hardwareEncoderPreference &&
        qualitySettings.hardwareEncoderPreference !== 'auto'
          ? String(qualitySettings.hardwareEncoderPreference).trim().toLowerCase()
          : '',
      encoderPreset: qualitySettings.encoderPreset || 'balanced',
      encoderTune: qualitySettings.encoderTune === 'none' ? '' : (qualitySettings.encoderTune || ''),
      keyframePolicy: qualitySettings.keyframePolicy || '1s'
    };

    if (normalized.startsWith('screen:')) {
      const [, fallbackDisplayId = ''] = normalized.split(':');
      const sourceDisplayId =
        sourceObject && sourceObject.nativeMonitorIndex != null && String(sourceObject.nativeMonitorIndex).trim()
          ? String(sourceObject.nativeMonitorIndex).trim()
          : (
            sourceObject && sourceObject.displayId != null && String(sourceObject.displayId).trim()
              ? String(sourceObject.displayId).trim()
              : fallbackDisplayId
          );
      return {
        captureTargetId: normalized,
        sourceId: normalized,
        captureKind: 'display',
        captureState: 'display',
        displayId: sourceDisplayId,
        captureTitle: sourceObject && sourceObject.title ? String(sourceObject.title) : '',
        ...sharedConfig
      };
    }

    if (normalized.startsWith('window:')) {
      const parts = normalized.split(':');
      const isExclusiveFullscreenSource =
        sourceObject && sourceObject.state === 'exclusive-fullscreen';
      if (isExclusiveFullscreenSource) {
        const sourceDisplayId =
          sourceObject && sourceObject.nativeMonitorIndex != null && String(sourceObject.nativeMonitorIndex).trim()
            ? String(sourceObject.nativeMonitorIndex).trim()
            : (
              sourceObject && sourceObject.displayId != null && String(sourceObject.displayId).trim()
                ? String(sourceObject.displayId).trim()
                : '0'
            );
        return {
          captureTargetId: normalized,
          sourceId: normalized,
          captureKind: 'display',
          captureState: 'display',
          displayId: sourceDisplayId,
          captureHwnd: sourceObject && sourceObject.hwnd != null
            ? String(sourceObject.hwnd).trim()
            : (parts[1] || ''),
          captureTitle: sourceObject && sourceObject.title ? String(sourceObject.title) : '',
          ...sharedConfig
        };
      }
      return {
        captureTargetId: normalized,
        sourceId: normalized,
        captureKind: 'window',
        captureState:
          sourceObject && sourceObject.state === 'minimized'
            ? 'minimized'
            : 'normal',
        captureHwnd: sourceObject && sourceObject.hwnd != null
          ? String(sourceObject.hwnd).trim()
          : (parts[1] || ''),
        captureTitle: sourceObject && sourceObject.title ? String(sourceObject.title) : '',
        ...sharedConfig
      };
    }

    throw new Error(`不支持的采集源:${normalized}`);
  }

  async function ensureMediaEngineStarted() {
    if (mediaEngineStarted) {
      return;
    }

    if (mediaEngineStartPromise) {
      return mediaEngineStartPromise;
    }

    mediaEngineStartPromise = (async () => {
      await mediaEngine.start();
      mediaEngineStarted = true;
      if (typeof mediaEngine.getCapabilities === 'function') {
        logNativeMediaCapabilities(await mediaEngine.getCapabilities());
      }
    })();

    try {
      await mediaEngineStartPromise;
    } finally {
      mediaEngineStartPromise = null;
    }
  }

  async function attachEmbeddedSurface(surfaceId, target, element) {
    if (!element) {
      throw new Error(`缺少承载容器:${surfaceId}`);
    }

    const layout = buildSurfaceLayout(element);
    const layoutKey = getSurfaceLayoutKey(layout);
    const payload = {
      surface: surfaceId,
      target,
      ...layout
    };
    logNativeStep('attachSurface:request', {
      surfaceId,
      target,
      payload,
      element: describeSurfaceElement(element)
    });
    const result = await mediaEngine.attachSurface(payload);
    clearRecoverableSurfaceSyncWarning(surfaceId);
    attachedEmbeddedSurfaces.set(surfaceId, { target, element, lastLayoutKey: layoutKey });
    startEmbeddedSurfaceTrackingLoop();
    logNativeStep('attachSurface:result', {
      surfaceId,
      target,
      result
    });
    return result;
  }

  async function detachEmbeddedSurface(surfaceId) {
    attachedEmbeddedSurfaces.delete(surfaceId);
    clearRecoverableSurfaceSyncWarning(surfaceId);
    if (attachedEmbeddedSurfaces.size === 0) {
      stopEmbeddedSurfaceTrackingLoop();
    }
    logNativeStep('detachSurface:request', { surfaceId });
    const result = await mediaEngine.detachSurface({ surface: surfaceId });
    logNativeStep('detachSurface:result', { surfaceId, result });
    return result;
  }

  async function attachNativeHostPreviewSurface() {
    if (!nativeHostPreviewEnabled || !nativeHostSessionRunning || !hostPreviewRequested) {
      logNativeStep('attachNativeHostPreviewSurface:skipped', {
        nativeHostPreviewEnabled,
        nativeHostSessionRunning,
        hostPreviewRequested
      });
      return null;
    }

    logNativeStep('attachNativeHostPreviewSurface:start', {
      surfaceId: HOST_PREVIEW_SURFACE_ID,
      target: 'host-capture-artifact'
    });
    const result = await attachEmbeddedSurface(
      HOST_PREVIEW_SURFACE_ID,
      'host-capture-artifact',
      hostVideoContainer
    );
    hostPreviewSurfaceAttached = true;
    hideLegacyVideoElements();
    return result;
  }

  async function detachNativeHostPreviewSurface() {
    if (!hostPreviewSurfaceAttached) {
      return null;
    }

    hostPreviewSurfaceAttached = false;
    return detachEmbeddedSurface(HOST_PREVIEW_SURFACE_ID);
  }

  async function attachNativePeerVideoSurface(peerId) {
    const surfaceId = `peer-surface:${peerId}`;
    logNativeStep('attachNativePeerVideoSurface:start', {
      peerId,
      surfaceId,
      target: `peer-video:${peerId}`
    });
    const result = await attachEmbeddedSurface(
      surfaceId,
      `peer-video:${peerId}`,
      remoteVideoContainer
    );
    hideLegacyVideoElements();
    return result;
  }

  async function detachNativePeerVideoSurface(peerId) {
    const surfaceId = `peer-surface:${peerId}`;
    return detachEmbeddedSurface(surfaceId);
  }

  function ensurePeerMeta(peerId, isInitiator, kind) {
    let meta = peerConnectionMeta.get(peerId);
    if (!meta) {
      meta = {
        isInitiator: Boolean(isInitiator),
        kind,
        hasConnected: false,
        connectTimeoutId: null,
        disconnectTimerId: null,
        localCandidateCount: 0,
        localCandidateTypes: new Set(),
        localHostUdpCandidates: [],
        remoteCandidateKeys: new Set(),
        restartAttempts: 0,
        restartInProgress: false,
        natMappingAttempted: false,
        natMappingInProgress: false,
        natMappingSuccess: false,
        natMappingStartedAt: null,
        natMappingCompletedAt: null,
        natMappingDurationMs: null,
        natMappingTriggerReason: '',
        natMappingResultReason: '',
        natMappingProtocol: '',
        natMappingMappedCandidateCount: 0,
        natMappingError: '',
        selectedCandidatePairLogged: false
      };
      peerConnectionMeta.set(peerId, meta);
    }
    return meta;
  }

  function getP2pStatusElementForPeer(peerId) {
    const handle = nativePeerHandles.get(peerId);
    if (handle && handle.role === 'host-downstream') {
      return elements.hostP2pStatus || null;
    }
    if (handle && handle.role === 'viewer-upstream') {
      return elements.viewerP2pStatus || null;
    }
    if (handle && handle.role === 'relay-downstream') {
      return null;
    }
    if (isHost) {
      return elements.hostP2pStatus || null;
    }
    return elements.viewerP2pStatus || null;
  }

  function setP2pStatusElementState(target, state) {
    const label = P2P_UI_STATE_LABELS[state] || '';
    if (!target || !label) {
      return;
    }
    target.dataset.p2pState = state;
    target.textContent = `P2P：${label}`;
  }

  function setP2pStateForPeer(peerId, state) {
    const target = getP2pStatusElementForPeer(peerId);
    if (!target) {
      return;
    }
    const meta = peerConnectionMeta.get(peerId);
    if (meta) {
      meta.p2pUiState = state;
    }
    setP2pStatusElementState(target, state);
    renderP2pDiagnosticReport();
  }

  function classifyP2pFailure(meta) {
    if (!meta) {
      return '纯 P2P 建连超时';
    }
    if (meta.localCandidateCount <= 0) {
      return '无本地候选，无法开始 P2P 连接';
    }
    if (!meta.localCandidateTypes || !meta.localCandidateTypes.has('srflx')) {
      return '未获得公网反射候选，当前网络可能无法纯 P2P 穿透';
    }
    return '纯 P2P 无法穿透当前网络';
  }

  function clearViewerMediaWaitTimer() {
    if (viewerMediaWaitTimerId) {
      clearTimeout(viewerMediaWaitTimerId);
      viewerMediaWaitTimerId = null;
    }
  }

  function armViewerMediaWaitTimer(peerId) {
    clearViewerMediaWaitTimer();
    if (!peerId) {
      return;
    }
    viewerMediaWaitTimerId = window.setTimeout(() => {
      viewerMediaWaitTimerId = null;
      if (sessionRole !== 'viewer' || upstreamPeerId !== peerId || videoStarted || upstreamConnected) {
        return;
      }
      setP2pStateForPeer(peerId, 'media-waiting');
      setViewerConnectionState('已连接，等待画面...');
    }, VIEWER_MEDIA_WAIT_TIMEOUT_MS);
  }

  function getCandidateTypeCountsFromMeta(meta) {
    const counts = { host: 0, srflx: 0, relay: 0, other: 0 };
    if (!meta || !(meta.localCandidateTypes instanceof Set)) {
      return counts;
    }
    meta.localCandidateTypes.forEach((type) => {
      if (Object.prototype.hasOwnProperty.call(counts, type)) {
        counts[type] += 1;
      } else {
        counts.other += 1;
      }
    });
    return counts;
  }

  function pickPeerStats(peerId) {
    const peers = Array.isArray(latestP2pStatsSnapshot && latestP2pStatsSnapshot.peers)
      ? latestP2pStatsSnapshot.peers
      : [];
    return peers.find((entry) => entry && entry.peerId === peerId) || null;
  }

  function formatDiagnosticValue(value, fallback = '-') {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return fallback;
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return '[object]';
      }
    }
    return String(value);
  }

  function normalizeDiagnosticNumber(value, fallback = '-') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return fallback;
    }
    return String(numeric);
  }

  function getCandidateType(candidateText) {
    const match = String(candidateText || '').match(/\btyp\s+([a-z0-9-]+)/i);
    return match ? match[1].toLowerCase() : '-';
  }

  function getCandidateProtocol(candidateText) {
    const match = String(candidateText || '').match(/^candidate:\S+\s+\d+\s+([a-z0-9-]+)\s+/i);
    return match ? match[1].toLowerCase() : '-';
  }

  function getCandidateAddressFamily(candidateText) {
    const text = String(candidateText || '');
    const parts = text.trim().split(/\s+/);
    const address = parts.length >= 5 ? parts[4] : '';
    if (address.includes(':')) {
      return 'ipv6';
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
      return 'ipv4';
    }
    return '-';
  }

  function summarizeSelectedCandidate(candidateText) {
    if (!candidateText) {
      return '-';
    }
    const type = getCandidateType(candidateText);
    const protocol = getCandidateProtocol(candidateText);
    const family = getCandidateAddressFamily(candidateText);
    return `${type}/${protocol}/${family}`;
  }

  function buildP2pDiagnosticReport() {
    const lines = [];
    const activeStatus = isHost
      ? (elements.hostP2pStatus && elements.hostP2pStatus.textContent)
      : (elements.viewerP2pStatus && elements.viewerP2pStatus.textContent);
    lines.push(`role: ${formatDiagnosticValue(sessionRole || (isHost ? 'host' : 'viewer'))}`);
    lines.push(`roomId: ${formatDiagnosticValue(currentRoomId)}`);
    lines.push(`clientId: ${formatDiagnosticValue(clientId)}`);
    lines.push(`p2pStatus: ${formatDiagnosticValue(activeStatus)}`);
    lines.push(`upstreamPeerId: ${formatDiagnosticValue(upstreamPeerId)}`);
    lines.push(`hostId: ${formatDiagnosticValue(hostId)}`);
    lines.push(`chainPosition: ${Number.isInteger(myChainPosition) ? myChainPosition : '-'}`);
    lines.push(`connected: ${formatDiagnosticValue(upstreamConnected)}`);
    lines.push(`videoStarted: ${formatDiagnosticValue(videoStarted)}`);
    lines.push(`natMappingAvailable: ${formatDiagnosticValue(Boolean(mediaEngine && typeof mediaEngine.openNatMapping === 'function'))}`);
    lines.push('');
    lines.push('peers:');

    if (nativePeerHandles.size === 0) {
      lines.push('- none');
    }

    for (const [peerId, handle] of nativePeerHandles.entries()) {
      const meta = peerConnectionMeta.get(peerId) || null;
      const candidateCounts = getCandidateTypeCountsFromMeta(meta);
      const statsPeer = pickPeerStats(peerId);
      const peerTransport = statsPeer && statsPeer.peerTransport ? statsPeer.peerTransport : {};
      const receiverRuntime = statsPeer && statsPeer.receiverRuntime ? statsPeer.receiverRuntime : {};
      const selectedLocalCandidate = peerTransport.selectedLocalCandidate || '';
      const selectedRemoteCandidate = peerTransport.selectedRemoteCandidate || '';
      lines.push(`- peerId: ${peerId}`);
      lines.push(`  role: ${formatDiagnosticValue(handle.role)}`);
      lines.push(`  kind: ${formatDiagnosticValue(handle.kind)}`);
      lines.push(`  connectionState: ${formatDiagnosticValue(handle.connectionState)}`);
      lines.push(`  iceConnectionState: ${formatDiagnosticValue(handle.iceConnectionState)}`);
      lines.push(`  signalingState: ${formatDiagnosticValue(handle.signalingState)}`);
      lines.push(`  p2pUiState: ${formatDiagnosticValue(meta && meta.p2pUiState)}`);
      lines.push(`  localCandidateCount: ${meta && Number.isFinite(meta.localCandidateCount) ? meta.localCandidateCount : 0}`);
      lines.push(`  localCandidateTypes: host=${candidateCounts.host}, srflx=${candidateCounts.srflx}, relay=${candidateCounts.relay}, other=${candidateCounts.other}`);
      lines.push(`  remoteCandidateCount: ${meta && meta.remoteCandidateKeys ? meta.remoteCandidateKeys.size : 0}`);
      lines.push(`  restartAttempts: ${meta && Number.isFinite(meta.restartAttempts) ? meta.restartAttempts : 0}`);
      lines.push(`  restartInProgress: ${formatDiagnosticValue(Boolean(meta && meta.restartInProgress))}`);
      lines.push(`  natMappingAttempted: ${formatDiagnosticValue(Boolean(meta && meta.natMappingAttempted))}`);
      lines.push(`  natMappingInProgress: ${formatDiagnosticValue(Boolean(meta && meta.natMappingInProgress))}`);
      lines.push(`  natMappingSuccess: ${formatDiagnosticValue(Boolean(meta && meta.natMappingSuccess))}`);
      lines.push(`  natMappingDurationMs: ${formatDiagnosticValue(meta && meta.natMappingDurationMs)}`);
      lines.push(`  natMappingTriggerReason: ${formatDiagnosticValue(meta && meta.natMappingTriggerReason)}`);
      lines.push(`  natMappingResultReason: ${formatDiagnosticValue(meta && meta.natMappingResultReason)}`);
      lines.push(`  natMappingProtocol: ${formatDiagnosticValue(meta && meta.natMappingProtocol)}`);
      lines.push(`  natMappingMappedCandidates: ${formatDiagnosticValue(meta && meta.natMappingMappedCandidateCount)}`);
      lines.push(`  natMappingError: ${formatDiagnosticValue(meta && meta.natMappingError)}`);
      lines.push(`  selectedCandidatePair: local=${summarizeSelectedCandidate(selectedLocalCandidate)}, remote=${summarizeSelectedCandidate(selectedRemoteCandidate)}`);
      lines.push(`  selectedLocalCandidate: ${formatDiagnosticValue(selectedLocalCandidate)}`);
      lines.push(`  selectedRemoteCandidate: ${formatDiagnosticValue(selectedRemoteCandidate)}`);
      lines.push(`  rttMs: ${normalizeDiagnosticNumber(peerTransport.roundTripTimeMs)}`);
      lines.push(`  videoSent: ${formatDiagnosticValue(peerTransport.videoFramesSent || (statsPeer && statsPeer.mediaBinding && statsPeer.mediaBinding.framesSent) || 0)}`);
      lines.push(`  videoReceived: ${formatDiagnosticValue(peerTransport.remoteVideoFramesReceived || 0)}`);
      lines.push(`  videoDecoded: ${formatDiagnosticValue(peerTransport.decodedFramesRendered || 0)}`);
      lines.push(`  audioSent: ${formatDiagnosticValue(peerTransport.audioFramesSent || 0)}`);
      lines.push(`  audioReceived: ${formatDiagnosticValue(peerTransport.remoteAudioFramesReceived || 0)}`);
      lines.push(`  nackRetransmissions: ${formatDiagnosticValue(peerTransport.nackRetransmissions || 0)}`);
      lines.push(`  pliRequestsReceived: ${formatDiagnosticValue(peerTransport.pliRequestsReceived || 0)}`);
      lines.push(`  keyframeRequestsSent: ${formatDiagnosticValue(peerTransport.keyframeRequestsSent || 0)}`);
      lines.push(`  decoderRecoveryCount: ${formatDiagnosticValue(peerTransport.decoderRecoveryCount || 0)}`);
      lines.push(`  droppedVideoUnits: ${formatDiagnosticValue(receiverRuntime.droppedVideoUnits || 0)}`);
      lines.push(`  droppedAudioBlocks: ${formatDiagnosticValue(receiverRuntime.droppedAudioBlocks || 0)}`);
      lines.push(`  receiverReason: ${formatDiagnosticValue(receiverRuntime.reason)}`);
      lines.push(`  receiverError: ${formatDiagnosticValue(receiverRuntime.lastError)}`);
    }

    return lines.join('\n');
  }

  function renderP2pDiagnosticReport() {
    const report = buildP2pDiagnosticReport();
    if (elements.hostP2pDiagnosticOutput) {
      elements.hostP2pDiagnosticOutput.textContent = report;
    }
    if (elements.viewerP2pDiagnosticOutput) {
      elements.viewerP2pDiagnosticOutput.textContent = report;
    }
  }

  function buildHostCaptureDiagnosticReportFromStats(stats, fpsSnapshot = {}) {
    const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
    const peer = peers.find((entry) => entry && entry.role === 'host-downstream') || {};
    const mediaBinding = peer.mediaBinding || {};
    const peerTransport = peer.peerTransport || {};
    const surfaces = Array.isArray(stats && stats.surfaces) ? stats.surfaces : [];
    const surface = surfaces.find((entry) =>
      entry &&
      (entry.target === 'host-session-video' || entry.target === 'host-capture-artifact')
    ) || {};
    const hostPlan = stats && stats.hostCapturePlan ? stats.hostCapturePlan : {};
    const hostPipeline = stats && stats.hostPipeline ? stats.hostPipeline : {};
    const audioBackend = stats && stats.audioBackend ? stats.audioBackend : {};

    return [
      `backend: ${formatDiagnosticValue(currentHostBackend)}`,
      `captureKind: ${formatDiagnosticValue(hostPlan.captureKind)}`,
      `captureState: ${formatDiagnosticValue(hostPlan.captureState)}`,
      `target: ${formatDiagnosticValue(hostPlan.captureBackend)}`,
      `resolution: ${formatDiagnosticValue(mediaBinding.width || hostPlan.width)}x${formatDiagnosticValue(mediaBinding.height || hostPlan.height)}`,
      `configuredFps: ${formatDiagnosticValue(mediaBinding.frameRate || hostPlan.frameRate)}`,
      `bitrateKbps: ${formatDiagnosticValue(mediaBinding.bitrateKbps || hostPlan.bitrateKbps)}`,
      `captureFps: ${formatDiagnosticValue(fpsSnapshot.sourceFps)}`,
      `previewFps: ${formatDiagnosticValue(fpsSnapshot.previewFps)}`,
      `encodeFps: ${formatDiagnosticValue(fpsSnapshot.sendFps)}`,
      `sourceFramesCaptured: ${formatDiagnosticValue(mediaBinding.sourceFramesCaptured || 0)}`,
      `framesSent: ${formatDiagnosticValue(mediaBinding.framesSent || peerTransport.videoFramesSent || 0)}`,
      `droppedVideoUnits: ${formatDiagnosticValue(peerTransport.droppedVideoUnits || 0)}`,
      `encodeQueueDepth: ${formatDiagnosticValue(mediaBinding.encodeQueueDepth)}`,
      `avgCopyResourceUs: ${formatDiagnosticValue(mediaBinding.avgSourceCopyResourceUs || 0)}`,
      `avgMapUs: ${formatDiagnosticValue(mediaBinding.avgSourceMapUs || 0)}`,
      `avgMemcpyUs: ${formatDiagnosticValue(mediaBinding.avgSourceMemcpyUs || 0)}`,
      `avgReadbackUs: ${formatDiagnosticValue(mediaBinding.avgSourceTotalReadbackUs || 0)}`,
      `surfaceRunning: ${formatDiagnosticValue(surface.running)}`,
      `surfaceRenderedFrames: ${formatDiagnosticValue(surface.decodedFramesRendered || 0)}`,
      `surfaceFrameStddevMs: ${formatDiagnosticValue(surface.frameIntervalStddevMs)}`,
      `encoder: ${formatDiagnosticValue(hostPipeline.selectedVideoEncoder || mediaBinding.videoEncoderBackend)}`,
      `encoderBackend: ${formatDiagnosticValue(hostPipeline.videoEncoderBackend || mediaBinding.videoEncoderBackend)}`,
      `hardware: ${formatDiagnosticValue(hostPipeline.hardware)}`,
      `audioCaptureActive: ${formatDiagnosticValue(audioBackend.captureActive)}`,
      `audioPacketsCaptured: ${formatDiagnosticValue(audioBackend.packetsCaptured || 0)}`,
      `audioFramesCaptured: ${formatDiagnosticValue(audioBackend.framesCaptured || 0)}`,
      `reason: ${formatDiagnosticValue(mediaBinding.reason || hostPlan.reason || hostPipeline.reason)}`,
      `lastError: ${formatDiagnosticValue(mediaBinding.lastError || hostPlan.lastError || hostPipeline.lastError)}`
    ].join('\n');
  }

  function buildHostCaptureDiagnosticReport() {
    return latestHostCaptureDiagnosticReport;
  }

  function renderHostCaptureDiagnosticReport() {
    if (elements.hostCaptureDiagnosticOutput) {
      elements.hostCaptureDiagnosticOutput.textContent = latestHostCaptureDiagnosticReport;
    }
  }

  function withP2pTimeout(promise, timeoutMs, timeoutMessage) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  }

  function rememberLocalIceCandidate(meta, candidate) {
    if (!meta || !candidate) {
      return;
    }
    for (const [peerId, peerMeta] of peerConnectionMeta.entries()) {
      if (peerMeta === meta) {
        setP2pStateForPeer(peerId, 'gathering');
        break;
      }
    }
    meta.localCandidateCount += 1;
    const candidateObject = typeof candidate === 'object'
      ? candidate
      : { candidate: String(candidate || '') };
    const candidateText = String(candidateObject.candidate || '');
    const typeMatch = candidateText.match(/\btyp\s+([a-z0-9-]+)/i);
    const protocolMatch = candidateText.match(/^candidate:\S+\s+\d+\s+([a-z0-9-]+)\s+/i);
    if (typeMatch) {
      meta.localCandidateTypes.add(typeMatch[1].toLowerCase());
    }
    if (
      typeMatch &&
      protocolMatch &&
      typeMatch[1].toLowerCase() === 'host' &&
      protocolMatch[1].toLowerCase() === 'udp'
    ) {
      const key = JSON.stringify({
        candidate: candidateText,
        sdpMid: candidateObject.sdpMid || '',
        sdpMLineIndex: Number.isFinite(candidateObject.sdpMLineIndex) ? candidateObject.sdpMLineIndex : 0
      });
      const exists = meta.localHostUdpCandidates.some((entry) => entry.key === key);
      if (!exists) {
        meta.localHostUdpCandidates.push({
          key,
          candidate: {
            candidate: candidateText,
            sdpMid: candidateObject.sdpMid || '',
            sdpMLineIndex: Number.isFinite(candidateObject.sdpMLineIndex) ? candidateObject.sdpMLineIndex : 0
          }
        });
        while (meta.localHostUdpCandidates.length > 16) {
          meta.localHostUdpCandidates.shift();
        }
      }
    }
  }

  async function attemptLastChanceNatMapping(peerId, reason) {
    const meta = peerConnectionMeta.get(peerId);
    const handle = nativePeerHandles.get(peerId);
    if (!meta || !handle || handle.closed || meta.hasConnected || meta.natMappingAttempted || meta.natMappingInProgress) {
      return false;
    }
    if (!window.isElectron || !mediaEngine || typeof mediaEngine.openNatMapping !== 'function') {
      return false;
    }

    meta.natMappingAttempted = true;
    meta.natMappingInProgress = true;
    meta.natMappingSuccess = false;
    meta.natMappingStartedAt = Date.now();
    meta.natMappingCompletedAt = null;
    meta.natMappingDurationMs = null;
    meta.natMappingTriggerReason = reason || '';
    meta.natMappingResultReason = 'in-progress';
    meta.natMappingProtocol = '';
    meta.natMappingMappedCandidateCount = 0;
    meta.natMappingError = '';
    const candidates = (meta.localHostUdpCandidates || [])
      .map((entry) => entry.candidate)
      .filter(Boolean)
      .slice(0, P2P_NAT_MAPPING_MAX_CANDIDATES);
    logNativeStep('peer-nat-mapping:start', {
      peerId,
      reason,
      candidateCount: candidates.length
    }, 'p2p');
    setP2pStateForPeer(peerId, 'nat-mapping');
    if (!isHost) {
      setViewerConnectionState('纯 P2P 直连失败，正在尝试路由器端口映射...');
    }

    try {
      const result = await withP2pTimeout(
        mediaEngine.openNatMapping({
          peerId,
          candidates,
          lifetimeSeconds: 180
        }),
        P2P_NAT_MAPPING_TIMEOUT_MS,
        'nat-mapping-timeout'
      );
      logNativeStep('peer-nat-mapping:result', {
        peerId,
        ok: Boolean(result && result.ok),
        reason: result && result.reason,
        protocol: result && result.protocol,
        mappedCandidates: result && Array.isArray(result.candidates) ? result.candidates.length : 0
      }, 'p2p');
      meta.natMappingCompletedAt = Date.now();
      meta.natMappingDurationMs = meta.natMappingCompletedAt - meta.natMappingStartedAt;
      meta.natMappingSuccess = Boolean(result && result.ok);
      meta.natMappingResultReason = result && result.reason ? String(result.reason) : 'nat-mapping-failed';
      meta.natMappingProtocol = result && result.protocol ? String(result.protocol) : '';
      meta.natMappingMappedCandidateCount = result && Array.isArray(result.candidates) ? result.candidates.length : 0;
      meta.natMappingError = result && Array.isArray(result.errors) && result.errors.length > 0
        ? result.errors.slice(0, 3).join('; ')
        : '';
      if (!result || !result.ok || !Array.isArray(result.candidates) || result.candidates.length === 0) {
        return false;
      }

      for (const mappedCandidate of result.candidates) {
        sendMessage({
          type: 'ice-candidate',
          targetId: peerId,
          roomId: currentRoomId,
          candidate: mappedCandidate,
          trickle: true,
          natMapping: true
        });
      }

      meta.connectTimeoutId = window.setTimeout(async () => {
        meta.connectTimeoutId = null;
        const currentHandle = nativePeerHandles.get(peerId);
        if (!meta.hasConnected && currentHandle && !currentHandle.closed && currentHandle.connectionState !== 'connected') {
          setP2pStateForPeer(peerId, 'failed');
          if (!isHost) {
            setViewerConnectionState('端口映射已尝试，但当前网络仍无法纯 P2P 穿透');
          }
          await closeNativePeerConnectionImpl(peerId, { clearRetryState: false }).catch(() => {});
        }
      }, P2P_NAT_MAPPING_CONNECT_WAIT_MS);
      return true;
    } catch (error) {
      meta.natMappingCompletedAt = Date.now();
      meta.natMappingDurationMs = meta.natMappingStartedAt ? meta.natMappingCompletedAt - meta.natMappingStartedAt : null;
      meta.natMappingSuccess = false;
      meta.natMappingResultReason = 'nat-mapping-error';
      meta.natMappingError = error && error.message ? error.message : String(error);
      logNativeStep('peer-nat-mapping:failed', {
        peerId,
        message: error && error.message ? error.message : String(error)
      }, 'p2p');
      return false;
    } finally {
      meta.natMappingInProgress = false;
      renderP2pDiagnosticReport();
    }
  }

  async function finalizeP2pFailureWithNatMapping(peerId, reason, source) {
    const meta = peerConnectionMeta.get(peerId);
    const handle = nativePeerHandles.get(peerId);
    if (!meta || !handle || handle.closed || meta.hasConnected || handle.connectionState === 'connected') {
      return;
    }

    clearPeerConnectionTimeout(peerId);
    const fallbackStarted = await attemptLastChanceNatMapping(peerId, reason);
    if (fallbackStarted) {
      return;
    }

    handle.connectionState = 'failed';
    handle.iceConnectionState = 'failed';
    setP2pStateForPeer(peerId, 'failed');
    logNativeStep('peer-connect-failed', {
      peerId,
      source,
      reason,
      localCandidateCount: meta.localCandidateCount,
      localCandidateTypes: Array.from(meta.localCandidateTypes || []),
      natMappingAttempted: Boolean(meta.natMappingAttempted),
      natMappingResultReason: meta.natMappingResultReason || ''
    }, 'p2p');
    if (!isHost) {
      setViewerConnectionState(meta.natMappingAttempted
        ? `纯 P2P 无法穿透当前网络（端口映射：${meta.natMappingResultReason || '失败'}）`
        : reason);
    }
    await closeNativePeerConnectionImpl(peerId, { clearRetryState: false }).catch(() => {});
  }

  function armPeerConnectFailfast(peerId) {
    const meta = peerConnectionMeta.get(peerId);
    if (!meta || meta.connectTimeoutId) {
      return;
    }
    meta.connectTimeoutId = window.setTimeout(async () => {
      meta.connectTimeoutId = null;
      if (meta.hasConnected) {
        return;
      }
      const handle = nativePeerHandles.get(peerId);
      if (!handle || handle.closed || handle.connectionState === 'connected') {
        return;
      }
      const reason = classifyP2pFailure(meta);
      await finalizeP2pFailureWithNatMapping(peerId, reason, 'connect-failfast');
    }, typeof P2P_CONNECT_FAILFAST_MS === 'number' ? P2P_CONNECT_FAILFAST_MS : 15000);
  }

  function createNativePeerConnectionImpl(peerId, isInitiator, kind = 'direct') {
    const role = isHost
      ? 'host-downstream'
      : (kind === 'relay-viewer' ? 'relay-downstream' : 'viewer-upstream');
    const handle = {
      __nativePeerHandle: true,
      peerId,
      role,
      kind,
      initiator: Boolean(isInitiator),
      relaySourcePeerId: null,
      connectionState: 'new',
      iceConnectionState: 'new',
      signalingState: 'stable',
      localDescription: null,
      remoteDescription: null,
      closed: false,
      __readyPromise: mediaEngine.createPeer({
        peerId,
        role,
        initiator: Boolean(isInitiator)
      })
    };

    peerConnections.set(peerId, handle);
    nativePeerHandles.set(peerId, handle);
    ensurePeerMeta(peerId, isInitiator, kind);
    setP2pStateForPeer(peerId, 'gathering');
    armPeerConnectFailfast(peerId);
    return handle;
  }

  async function ensureNativePeerConnectionReady(peerId, handle) {
    if (isNativePeerHandle(handle)) {
      logNativeStep('createPeer:awaitReady', { peerId, role: handle.role, kind: handle.kind });
      await handle.__readyPromise;
      logNativeStep('createPeer:ready', { peerId, role: handle.role, kind: handle.kind });
    }
  }

  async function attachNativePeerMediaSources(peerId, handle) {
    if (!isNativePeerHandle(handle)) {
      throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
    }

    if (handle.kind === 'relay-viewer') {
      const relaySourcePeerId = handle.relaySourcePeerId || upstreamPeerId;
      if (!relaySourcePeerId) {
        throw new Error('native-relay-upstream-peer-missing');
      }

      await ensureNativePeerConnectionReady(peerId, handle);
      return mediaEngine.attachPeerMediaSource({
        peerId,
        source: `peer-video:${relaySourcePeerId}`
      });
    }

    if (!isHost) {
      return null;
    }

    if (!nativeHostSessionRunning) {
      throw new Error('native-host-session-not-running');
    }

    await ensureNativePeerConnectionReady(peerId, handle);
    return mediaEngine.attachPeerMediaSource({
      peerId,
      source: 'host-session-video'
    });
  }

  async function setPeerRemoteDescription(peerId, pc, description) {
    if (!isNativePeerHandle(pc)) {
      throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
    }

    logNativeStep('setRemoteDescription:request', {
      peerId,
      type: description.type,
      sdpLength: description && description.sdp ? String(description.sdp).length : 0
    });
    await ensureNativePeerConnectionReady(peerId, pc);
    await mediaEngine.setRemoteDescription({
      peerId,
      type: description.type,
      sdp: description.sdp
    });
    logNativeStep('setRemoteDescription:applied', {
      peerId,
      type: description.type
    });

    pc.remoteDescription = normalizeNativeSessionDescription(description);
    pc.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async function addPeerRemoteIceCandidate(peerId, pc, candidate) {
    if (!isNativePeerHandle(pc)) {
      throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
    }

    if (!isAllowedPureP2pCandidate(candidate)) {
      logNativeStep('addRemoteIceCandidate:blocked-relay', { peerId }, 'p2p');
      return;
    }

    const candidateKey = buildRemoteCandidateKey(candidate);
    const meta = peerConnectionMeta.get(peerId);
    if (candidateKey && meta && meta.remoteCandidateKeys.has(candidateKey)) {
      return;
    }

    logNativeStep('addRemoteIceCandidate:request', {
      peerId,
      candidateLength: candidate ? String(candidate).length : 0
    });
    await ensureNativePeerConnectionReady(peerId, pc);
    await mediaEngine.addRemoteIceCandidate({
      peerId,
      candidate
    });
    setP2pStateForPeer(peerId, 'checking');
    if (candidateKey && meta) {
      meta.remoteCandidateKeys.add(candidateKey);
      if (meta.remoteCandidateKeys.size > 64) {
        meta.remoteCandidateKeys = new Set(Array.from(meta.remoteCandidateKeys).slice(-48));
      }
    }
    logNativeStep('addRemoteIceCandidate:applied', { peerId });
  }

  async function flushQueuedRemoteCandidates(peerId, pc) {
    const queued = pendingRemoteCandidates.get(peerId);
    if (!queued || !queued.length) {
      return;
    }

    pendingRemoteCandidates.delete(peerId);
    for (const candidate of queued) {
      await addPeerRemoteIceCandidate(peerId, pc, candidate);
    }
  }

  function handleNativePeerStateEvent(params) {
    if (!params || !params.peerId) {
      return;
    }

    const handle = nativePeerHandles.get(params.peerId);
    if (!handle) {
      return;
    }

    if (params.state === 'connected') {
      handle.connectionState = 'connected';
      handle.iceConnectionState = 'connected';
      setP2pStateForPeer(params.peerId, handle.role === 'viewer-upstream' ? 'media-waiting' : 'connected');
      if (handle.role === 'viewer-upstream') {
        armViewerMediaWaitTimer(params.peerId);
      }
      const meta = peerConnectionMeta.get(params.peerId);
      if (meta) {
        meta.hasConnected = true;
        meta.restartInProgress = false;
        clearPeerConnectionTimeout(params.peerId);
        clearPeerDisconnectTimer(params.peerId);
        clearPeerReconnect(params.peerId);
      }
      return;
    }

    if (params.state === 'connecting') {
      handle.connectionState = 'connecting';
      handle.iceConnectionState = 'checking';
      setP2pStateForPeer(params.peerId, 'checking');
      return;
    }

    if (params.state === 'disconnected') {
      handle.connectionState = 'disconnected';
      handle.iceConnectionState = 'disconnected';
      setP2pStateForPeer(params.peerId, 'restart-attempting');
      return;
    }

    if (params.state === 'failed') {
      handle.connectionState = 'failed';
      handle.iceConnectionState = 'failed';
      if (handle.role === 'viewer-upstream') {
        clearViewerMediaWaitTimer();
      }
      void finalizeP2pFailureWithNatMapping(params.peerId, 'ICE failed', 'ice-failed');
      return;
    }

    if (params.state === 'closed') {
      handle.connectionState = 'closed';
      handle.iceConnectionState = 'closed';
      handle.closed = true;
    }
  }

  function forwardNativeMediaSignal(params) {
    if (!params || !params.type) {
      return;
    }

    if (params.type !== 'candidate') {
      return;
    }

    const payload = {
      type: params.type === 'candidate' ? 'ice-candidate' : params.type,
      targetId: params.targetId || params.peerId || params.remotePeerId,
      roomId: currentRoomId,
      trickle: true
    };

    if (params.sdp) {
      payload.sdp = params.sdp;
    }
    if (params.candidate) {
      if (!isAllowedPureP2pCandidate(params.candidate)) {
        logNativeStep('signal:candidate:blocked-relay', {
          peerId: params.peerId || params.remotePeerId || params.targetId
        }, 'p2p');
        return;
      }
      payload.candidate = params.candidate;
      const peerId = params.peerId || params.remotePeerId || params.targetId;
      const meta = peerConnectionMeta.get(peerId);
      if (meta) {
        rememberLocalIceCandidate(meta, params.candidate);
      }
    }
    if (params.isRelay) {
      payload.isRelay = true;
    }
    if (params.reconnect) {
      payload.reconnect = true;
    }
    if (params.iceRestart) {
      payload.iceRestart = true;
    }

    sendMessage(payload);
  }

  function applyNativeMediaStateUpdate(params) {
    if (!params || !params.state) {
      return;
    }

    if (params.backend) {
      currentHostBackend = normalizeHostBackendName(params.backend);
    }

    if (params.state === 'surface-detached' && params.surface) {
      attachedEmbeddedSurfaces.delete(params.surface);
      clearRecoverableSurfaceSyncWarning(params.surface);
      if (attachedEmbeddedSurfaces.size === 0) {
        stopEmbeddedSurfaceTrackingLoop();
      }
    }

    if (params.state === 'host-session-started') {
      nativeHostSessionRunning = true;
      obsRoomCreatePending = false;
      obsIngestStreamActive = false;
      if (typeof qualitySettings === 'object' && qualitySettings) {
        const effectiveCodec = normalizeNativeVideoCodec(
          params.effectiveCodec || params.codec,
          normalizeNativeVideoCodec(params.requestedCodec, qualitySettings.codecPreference || 'h264')
        );
        qualitySettings.codecPreference = effectiveCodec;
        nativeHostEffectiveCodec = effectiveCodec;
      }
      lockCodecUiToNativeH264();
      if (params.capturePlan && params.capturePlan.captureState === 'minimized') {
        syncHostWaitingWindowRestoreUi(true);
      }
      return;
    }

    if (params.state === 'obs-ingest-waiting') {
      currentHostBackend = 'obs-ingest';
      nativeHostSessionRunning = true;
      hostWaitingWindowRestore = false;
      obsIngestStreamActive = false;
      updateHostEncoderDetail(null, params.obsIngest || null);
      if (elements.hostStatus) {
        elements.hostStatus.textContent = '等待 OBS 推流...';
        elements.hostStatus.classList.add('waiting');
      }
      return;
    }

    if (params.state === 'obs-ingest-connected') {
      currentHostBackend = 'obs-ingest';
      nativeHostSessionRunning = true;
      obsIngestStreamActive = false;
      updateHostEncoderDetail(null, params.obsIngest || null);
      if (elements.hostStatus) {
        elements.hostStatus.textContent = 'OBS 已连接，等待有效节目流...';
        elements.hostStatus.classList.add('waiting');
      }
      return;
    }

    if (params.state === 'obs-stream-running') {
      currentHostBackend = 'obs-ingest';
      nativeHostSessionRunning = true;
      obsIngestStreamActive = true;
      updateHostEncoderDetail(null, params.obsIngest || null);
      ensureObsHostRoomCreated();
      return;
    }

    if (params.state === 'obs-ingest-ended') {
      currentHostBackend = 'obs-ingest';
      nativeHostSessionRunning = true;
      obsRoomCreatePending = false;
      obsIngestStreamActive = false;
      updateHostEncoderDetail(null, params.obsIngest || null);
      if (currentRoomId || sessionRole === 'host') {
        teardownHostRoomPreservingSession('obs-ingest-ended').catch((error) => {
          logRecoverableNativeWarning('obs-ingest:end-room-failed', error, {
            key: 'obs-ingest-end-room-failed',
            category: 'video',
            channel: 'nativeSteps',
            fallbackLabel: '[media-engine] failed to end OBS room after ingest stop:'
          });
        });
      } else if (elements.hostStatus) {
        elements.hostStatus.textContent = '等待 OBS 推流...';
        elements.hostStatus.classList.add('waiting');
      }
      return;
    }

    if (params.state === 'host-session-stopped') {
      nativeHostSessionRunning = false;
      hostWaitingWindowRestore = false;
      obsRoomCreatePending = false;
      obsIngestStreamActive = false;
    }
  }

  function deliverNativeProcessAudioPacket(_params) {
    // Native audio packets should not revive renderer playback authority.
  }

  async function closeNativePeerConnectionImpl(peerId, options = {}) {
    const handle = nativePeerHandles.get(peerId);
    if (!handle) {
      const existing = peerConnections.get(peerId);
      if (existing) {
        throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
      }
      return null;
    }

    try {
      await detachNativePeerVideoSurface(peerId).catch(() => {});
      await mediaEngine.detachPeerMediaSource({ peerId }).catch(() => {});
      await mediaEngine.closePeer({ peerId }).catch(() => {});
    } finally {
      nativePeerHandles.delete(peerId);
      peerConnections.delete(peerId);
      peerConnectionMeta.delete(peerId);
      pendingRemoteCandidates.delete(peerId);
      nativePeerSignalBacklog.delete(peerId);
      clearPeerConnectionTimeout(peerId);
      clearPeerDisconnectTimer(peerId);
      if (options.clearRetryState) {
        clearPeerReconnect(peerId);
      }
      renderP2pDiagnosticReport();
    }
  }

  async function clearNativePeerConnectionsImpl(options = {}) {
    const peerIds = Array.from(nativePeerHandles.keys());
    for (const peerId of peerIds) {
      await closeNativePeerConnectionImpl(peerId, options);
    }
  }

  async function createAndSendPeerOffer(peerId, pc, options = {}) {
    if (!isNativePeerHandle(pc)) {
      throw new Error('renderer-peer-path-disabled-for-native-authority');
    }

    // Clear only stale queued offers from earlier attempts before the current
    // native peer has a chance to emit its fresh local description.
    dropQueuedNativePeerSignals(peerId, (entry) => entry && entry.type === 'offer');
    await ensureNativePeerConnectionReady(peerId, pc);
    const attachResult = await attachNativePeerMediaSources(peerId, pc);
    if (attachResult && attachResult.peerTransport && attachResult.peerTransport.videoTrackConfigured !== true) {
      throw new Error(`native-peer-video-track-not-configured:${peerId}`);
    }

    let signal = null;
    if (
      pc.localDescription &&
      pc.localDescription.type === 'offer' &&
      isMediaOfferSignal({ type: 'offer', sdp: pc.localDescription })
    ) {
      signal = {
        peerId,
        targetId: peerId,
        type: 'offer',
        sdp: pc.localDescription
      };
    } else {
      signal = await waitForNativeMediaOffer(peerId);
    }

    updateNativePeerSignalState(peerId, signal);
    if (options.reconnect || options.iceRestart) {
      setP2pStateForPeer(peerId, 'restart-attempting');
    } else {
      setP2pStateForPeer(peerId, 'gathering');
    }

    sendMessage({
      type: 'offer',
      targetId: peerId,
      sdp: signal.sdp,
      roomId: currentRoomId,
      ...(options.isRelay ? { isRelay: true } : {}),
      ...(options.reconnect ? { reconnect: true } : {}),
      ...(options.iceRestart ? { iceRestart: true } : {})
    });

    return signal.sdp;
  }

  async function createAndSendPeerAnswer(peerId, pc) {
    if (!isNativePeerHandle(pc)) {
      throw new Error('renderer-peer-path-disabled-for-native-authority');
    }

    await ensureNativePeerConnectionReady(peerId, pc);
    const signal = await waitForNativePeerSignal(peerId, 'answer');
    updateNativePeerSignalState(peerId, signal);

    sendMessage({
      type: 'answer',
      targetId: peerId,
      sdp: signal.sdp,
      roomId: currentRoomId
    });

    return signal.sdp;
  }

  function handleNativeMediaEngineEvent(event) {
    logNativeMediaEngineEventSummary(event);

    if (!event || !event.event) {
      return;
    }

    if (event.event === 'signal') {
      const params = event.params || {};
      const peerId = getNativeSignalPeerId(params);
      if (peerId) {
        updateNativePeerSignalState(peerId, params);
        enqueueNativePeerSignal(params);
      }
      forwardNativeMediaSignal(params);
      return;
    }

    if (event.event === 'peer-state') {
      handleNativePeerStateEvent(event.params || {});
      return;
    }

    if (event.event === 'media-state') {
      applyNativeMediaStateUpdate(event.params || {});
      return;
    }

    if (event.event === 'audio-data') {
      deliverNativeProcessAudioPacket(event.params || {});
      return;
    }

    if (event.event === 'warning' && event.params && event.params.message) {
      const warningKey = `agent-warning:${event.params.scope || 'misc'}:${event.params.message}`;
      const rate = shouldEmitNativeDebugLog(warningKey, 5000);
      if (rate.emit) {
        logNativeWarningLine(
          '[media-engine warning]',
          event.params.message,
          rate.suppressed ? `suppressed=${rate.suppressed}` : ''
        );
      }
    }
  }

  function stopNativeViewerStatsPolling() {
    if (nativeViewerStatsIntervalId) {
      clearInterval(nativeViewerStatsIntervalId);
      nativeViewerStatsIntervalId = null;
    }
    renderP2pDiagnosticReport();
  }

  function resetHostFpsIndicators() {
    hostSourceFramesSample = null;
    hostPreviewFramesSample = null;
    hostSendFramesSample = null;
    hostFramesSampleAtMs = 0;
    if (elements.hostSourceFps) {
      elements.hostSourceFps.textContent = '-';
    }
    if (elements.hostCaptureFps) {
      elements.hostCaptureFps.textContent = '-';
    }
    if (elements.hostSendFps) {
      elements.hostSendFps.textContent = '-';
    }
  }

  function updateHostFpsIndicators(sourceFrames, previewFrames, sentFrames) {
    const nowMs = Date.now();
    if (
      hostFramesSampleAtMs <= 0 ||
      hostSourceFramesSample === null ||
      hostPreviewFramesSample === null ||
      hostSendFramesSample === null
    ) {
      hostSourceFramesSample = Number.isFinite(sourceFrames) ? sourceFrames : 0;
      hostPreviewFramesSample = Number.isFinite(previewFrames) ? previewFrames : 0;
      hostSendFramesSample = Number.isFinite(sentFrames) ? sentFrames : 0;
      hostFramesSampleAtMs = nowMs;
      if (elements.hostSourceFps) {
        elements.hostSourceFps.textContent = Number.isFinite(sourceFrames) && sourceFrames > 0 ? '0 fps' : '-';
      }
      if (elements.hostCaptureFps) {
        elements.hostCaptureFps.textContent = Number.isFinite(previewFrames) && previewFrames > 0 ? '0 fps' : '-';
      }
      if (elements.hostSendFps) {
        elements.hostSendFps.textContent = Number.isFinite(sentFrames) && sentFrames > 0 ? '0 fps' : '-';
      }
      return {
        sourceFps: Number.isFinite(sourceFrames) && sourceFrames > 0 ? 0 : '-',
        previewFps: Number.isFinite(previewFrames) && previewFrames > 0 ? 0 : '-',
        sendFps: Number.isFinite(sentFrames) && sentFrames > 0 ? 0 : '-'
      };
    }

    const deltaMs = Math.max(1, nowMs - hostFramesSampleAtMs);
    const sourceFps = Number.isFinite(sourceFrames)
      ? Math.max(0, sourceFrames - hostSourceFramesSample) * 1000 / deltaMs
      : NaN;
    const previewFps = Number.isFinite(previewFrames)
      ? Math.max(0, previewFrames - hostPreviewFramesSample) * 1000 / deltaMs
      : NaN;
    const sendFps = Number.isFinite(sentFrames)
      ? Math.max(0, sentFrames - hostSendFramesSample) * 1000 / deltaMs
      : NaN;

    if (elements.hostSourceFps) {
      elements.hostSourceFps.textContent = Number.isFinite(sourceFps) ? `${Math.round(sourceFps)} fps` : '-';
    }
    if (elements.hostCaptureFps) {
      elements.hostCaptureFps.textContent = Number.isFinite(previewFps) ? `${Math.round(previewFps)} fps` : '-';
    }
    if (elements.hostSendFps) {
      elements.hostSendFps.textContent = Number.isFinite(sendFps) ? `${Math.round(sendFps)} fps` : '-';
    }

    hostSourceFramesSample = Number.isFinite(sourceFrames) ? sourceFrames : hostSourceFramesSample;
    hostPreviewFramesSample = Number.isFinite(previewFrames) ? previewFrames : hostPreviewFramesSample;
    hostSendFramesSample = Number.isFinite(sentFrames) ? sentFrames : hostSendFramesSample;
    hostFramesSampleAtMs = nowMs;
    return {
      sourceFps: Number.isFinite(sourceFps) ? Math.round(sourceFps) : '-',
      previewFps: Number.isFinite(previewFps) ? Math.round(previewFps) : '-',
      sendFps: Number.isFinite(sendFps) ? Math.round(sendFps) : '-'
    };
  }

  function resetViewerFpsIndicator() {
    viewerReceivedFramesSample = null;
    viewerRenderedFramesSample = null;
    viewerFramesSampleAtMs = 0;
    if (elements.viewerReceiveFps) {
      elements.viewerReceiveFps.textContent = '-';
    }
    if (elements.viewerRenderFps) {
      elements.viewerRenderFps.textContent = '-';
    }
  }

  function updateViewerFpsIndicator(receivedFrames, renderedFrames) {
    if ((!elements.viewerReceiveFps && !elements.viewerRenderFps) ||
        !Number.isFinite(receivedFrames) ||
        !Number.isFinite(renderedFrames) ||
        receivedFrames < 0 ||
        renderedFrames < 0) {
      return;
    }

    const nowMs = Date.now();
    if (viewerReceivedFramesSample === null || viewerRenderedFramesSample === null || viewerFramesSampleAtMs <= 0) {
      viewerReceivedFramesSample = receivedFrames;
      viewerRenderedFramesSample = renderedFrames;
      viewerFramesSampleAtMs = nowMs;
      if (elements.viewerReceiveFps) {
        elements.viewerReceiveFps.textContent = receivedFrames > 0 ? '0 fps' : '-';
      }
      if (elements.viewerRenderFps) {
        elements.viewerRenderFps.textContent = renderedFrames > 0 ? '0 fps' : '-';
      }
      return;
    }

    const deltaMs = Math.max(1, nowMs - viewerFramesSampleAtMs);
    const receiveFps = Math.max(0, receivedFrames - viewerReceivedFramesSample) * 1000 / deltaMs;
    const renderFps = Math.max(0, renderedFrames - viewerRenderedFramesSample) * 1000 / deltaMs;
    if (elements.viewerReceiveFps) {
      elements.viewerReceiveFps.textContent = `${Math.round(receiveFps)} fps`;
    }
    if (elements.viewerRenderFps) {
      elements.viewerRenderFps.textContent = `${Math.round(renderFps)} fps`;
    }
    viewerReceivedFramesSample = receivedFrames;
    viewerRenderedFramesSample = renderedFrames;
    viewerFramesSampleAtMs = nowMs;
  }

  function stopNativeHostStatsPolling() {
    if (nativeHostStatsIntervalId) {
      clearInterval(nativeHostStatsIntervalId);
      nativeHostStatsIntervalId = null;
    }
    renderP2pDiagnosticReport();
  }

  function updateHostEncoderDetail(pipeline, obsIngest = null) {
    if (!elements.hostStatusDetail) {
      return;
    }

    if (isObsIngestHostBackend()) {
      const parts = [];
      if (obsIngest && Number.isFinite(obsIngest.port) && obsIngest.port > 0) {
        parts.push(`SRT：127.0.0.1:${obsIngest.port}`);
      }
      if (obsIngest && obsIngest.videoCodec) {
        const videoBits = [String(obsIngest.videoCodec).toUpperCase()];
        if (Number.isFinite(obsIngest.width) && obsIngest.width > 0 && Number.isFinite(obsIngest.height) && obsIngest.height > 0) {
          videoBits.push(`${obsIngest.width}x${obsIngest.height}`);
        }
        if (Number.isFinite(obsIngest.frameRate) && obsIngest.frameRate > 0) {
          videoBits.push(`${obsIngest.frameRate}fps`);
        }
        parts.push(videoBits.join(' '));
      }
      if (obsIngest && obsIngest.audioCodec) {
        parts.push(`音频：${String(obsIngest.audioCodec).toUpperCase()}`);
      }

      if (parts.length === 0) {
        elements.hostStatusDetail.textContent = '';
        elements.hostStatusDetail.classList.add('hidden');
        return;
      }

      elements.hostStatusDetail.textContent = parts.join(' · ');
      elements.hostStatusDetail.classList.remove('hidden');
      return;
    }

    const encoder = pipeline && pipeline.selectedVideoEncoder
      ? String(pipeline.selectedVideoEncoder).trim()
      : '';
    if (!encoder) {
      elements.hostStatusDetail.textContent = '';
      elements.hostStatusDetail.classList.add('hidden');
      return;
    }

    elements.hostStatusDetail.textContent = `编码器：${encoder}`;
    elements.hostStatusDetail.classList.remove('hidden');
  }

  async function teardownHostRoomPreservingSession(reason = 'host-room-ended') {
    const peerIds = Array.from(nativePeerHandles.keys());
    await Promise.all(peerIds.map((peerId) => closeNativePeerConnectionImpl(peerId, { clearRetryState: true }).catch(() => {})));

    if (currentRoomId && sessionRole === 'host') {
      sendMessage({
        type: 'leave-room',
        roomId: currentRoomId,
        clientId
      }, { queueIfDisconnected: false });
    }

    sessionRole = null;
    currentRoomId = null;
    currentSessionToken = null;
    hostId = null;
    upstreamPeerId = null;
    relayStream = null;
    upstreamConnected = false;
    viewerReadySent = false;
    videoStarted = false;
    clearViewerMediaWaitTimer();
    obsRoomCreatePending = false;
    obsIngestStreamActive = false;

    elements.roomInfo.classList.add('hidden');
    elements.viewerCount.textContent = '0';
    elements.btnStartShare.classList.add('hidden');
    elements.btnStopShare.classList.remove('hidden');
    if (elements.hostStatus) {
      elements.hostStatus.textContent = '等待 OBS 推流...';
      elements.hostStatus.classList.add('waiting');
    }

    logNativeStep('obs-ingest:room-ended', {
      reason,
      peerCount: peerIds.length
    }, 'video');
  }

  function ensureObsHostRoomCreated() {
    if (!isHost || !nativeHostSessionRunning || !isObsIngestHostBackend()) {
      return;
    }
    if (currentRoomId || obsRoomCreatePending) {
      return;
    }

    obsRoomCreatePending = true;
    if (elements.hostStatus) {
      elements.hostStatus.textContent = 'OBS 节目流已接入，正在创建房间...';
      elements.hostStatus.classList.add('waiting');
    }
    sendMessage({
      type: 'create-room',
      clientId,
      publicListing: Boolean(qualitySettings && qualitySettings.publicRoomEnabled)
    });
  }

  async function pollNativeHostStats(reason = 'periodic') {
    if (!nativeHostSessionRunning || !isHost) {
      return null;
    }

    try {
      const stats = await mediaEngine.getStats({});
      latestP2pStatsSnapshot = stats || null;
      currentHostBackend = normalizeHostBackendName(stats && stats.hostBackend ? stats.hostBackend : currentHostBackend);
      const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
      const peer = peers.find((entry) => entry && entry.role === 'host-downstream');
      const surfaces = Array.isArray(stats && stats.surfaces) ? stats.surfaces : [];
      const surface = surfaces.find(
        (entry) =>
          entry &&
          (entry.target === 'host-session-video' || entry.target === 'host-capture-artifact')
      );
      const hostPlan = stats && stats.hostCapturePlan ? stats.hostCapturePlan : null;
      const hostPipeline = stats && stats.hostPipeline ? stats.hostPipeline : null;
      const obsIngest = stats && stats.obsIngest ? stats.obsIngest : null;
      const sourceFrames = isObsIngestHostBackend()
        ? (
          obsIngest && Number.isFinite(obsIngest.videoPacketsReceived)
            ? obsIngest.videoPacketsReceived
            : NaN
        )
        : (
          peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.sourceFramesCaptured)
            ? peer.mediaBinding.sourceFramesCaptured
            : NaN
        );
      const captureFrames = surface && Number.isFinite(surface.decodedFramesRendered)
        ? surface.decodedFramesRendered
        : NaN;
      const sentFrames = peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.framesSent)
        ? peer.mediaBinding.framesSent
        : NaN;

      updateHostEncoderDetail(hostPipeline, obsIngest);
      const hostFpsSnapshot = updateHostFpsIndicators(sourceFrames, captureFrames, sentFrames) || {};
      latestHostCaptureDiagnosticReport = buildHostCaptureDiagnosticReportFromStats(stats, hostFpsSnapshot);
      renderHostCaptureDiagnosticReport();
      if (isObsIngestHostBackend()) {
        if (obsIngest && obsIngest.waiting) {
          elements.hostStatus.textContent = '等待 OBS 推流...';
          elements.hostStatus.classList.add('waiting');
        } else if (obsIngest && obsIngest.ingestConnected && !obsIngest.streamRunning) {
          elements.hostStatus.textContent = 'OBS 已连接，等待有效节目流...';
          elements.hostStatus.classList.add('waiting');
        } else if (currentRoomId) {
          elements.hostStatus.textContent = '正在共享（OBS）';
          elements.hostStatus.classList.remove('waiting');
        }
      } else if (hostPlan && hostPlan.captureState === 'minimized') {
        syncHostWaitingWindowRestoreUi(true);
      } else if (hostWaitingWindowRestore) {
        syncHostWaitingWindowRestoreUi(
          false,
          currentRoomId ? '原生分享已恢复' : `正在共享（原生，${String(nativeHostEffectiveCodec || 'h264').toUpperCase()}）`
        );
      }

      if (shouldShowDebugLogsFor('video', 'periodicStats')) {
        const rate = shouldEmitNativeDebugLog(`stats:host:${reason}`, reason === 'initial' ? 0 : 5000);
        if (rate.emit) {
          logNativeStatsLine('[media-engine native-host-stats]', [
            `reason=${reason}`,
            `backend=${currentHostBackend}`,
            `hostRunning=${Boolean(stats && stats.hostSessionRunning)}`,
            `captureReady=${Boolean(hostPlan && hostPlan.ready)}`,
            `captureValidated=${Boolean(hostPlan && hostPlan.validated)}`,
            `captureReason=${hostPlan && hostPlan.reason ? hostPlan.reason : 'n/a'}`,
            `obsWaiting=${Boolean(obsIngest && obsIngest.waiting)}`,
            `obsConnected=${Boolean(obsIngest && obsIngest.ingestConnected)}`,
            `obsRunning=${Boolean(obsIngest && obsIngest.streamRunning)}`,
            `obsVideoCodec=${obsIngest && obsIngest.videoCodec ? obsIngest.videoCodec : 'n/a'}`,
            `obsAudioCodec=${obsIngest && obsIngest.audioCodec ? obsIngest.audioCodec : 'n/a'}`,
            `sourceFramesCaptured=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.sourceFramesCaptured) ? peer.mediaBinding.sourceFramesCaptured : 0}`,
            `avgCopyUs=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.avgSourceCopyResourceUs) ? peer.mediaBinding.avgSourceCopyResourceUs : 0}`,
            `avgMapUs=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.avgSourceMapUs) ? peer.mediaBinding.avgSourceMapUs : 0}`,
            `avgMemcpyUs=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.avgSourceMemcpyUs) ? peer.mediaBinding.avgSourceMemcpyUs : 0}`,
            `avgReadbackUs=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.avgSourceTotalReadbackUs) ? peer.mediaBinding.avgSourceTotalReadbackUs : 0}`,
            `surfaceRunning=${Boolean(surface && surface.running)}`,
            `surfaceFramesRendered=${surface && Number.isFinite(surface.decodedFramesRendered) ? surface.decodedFramesRendered : 0}`,
            `surfaceFrameStddevMs=${surface && typeof surface.frameIntervalStddevMs === 'number' ? surface.frameIntervalStddevMs.toFixed(3) : '0.000'}`,
            `surfaceReason=${surface && surface.reason ? surface.reason : 'n/a'}`,
            `peer=${peer && peer.peerId ? peer.peerId : 'n/a'}`,
            `videoConfigured=${Boolean(peer && peer.peerTransport && peer.peerTransport.videoTrackConfigured)}`,
            `videoOpen=${Boolean(peer && peer.peerTransport && peer.peerTransport.videoTrackOpen)}`,
            `framesSent=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.framesSent) ? peer.mediaBinding.framesSent : 0}`,
            `bindingReason=${peer && peer.mediaBinding && peer.mediaBinding.reason ? peer.mediaBinding.reason : 'n/a'}`
          ], rate.suppressed);
        }
      }

      renderP2pDiagnosticReport();
      return stats;
    } catch (error) {
      logRecoverableNativeWarning('native-host-stats:failed', error, {
        key: 'native-host-stats',
        category: 'video',
        channel: 'periodicStats',
        fallbackLabel: '[media-engine native-host-stats] failed:'
      });
      return null;
    }
  }

  function startNativeHostStatsPolling() {
    stopNativeHostStatsPolling();
    resetHostFpsIndicators();
    nativeHostStatsIntervalId = setInterval(() => {
      if (!nativeHostSessionRunning || !isHost) {
        stopNativeHostStatsPolling();
        return;
      }
      pollNativeHostStats('periodic');
    }, 2000);
    pollNativeHostStats('initial');
  }

  async function pollNativeViewerStats(reason = 'periodic') {
    if (!upstreamPeerId || sessionRole !== 'viewer') {
      return null;
    }

    try {
      const stats = await mediaEngine.getStats({});
      latestP2pStatsSnapshot = stats || null;
      const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
      const peer = peers.find((entry) => entry && entry.peerId === upstreamPeerId);
      if (!peer || !peer.peerTransport) {
        renderP2pDiagnosticReport();
        return stats;
      }

      const surfaces = Array.isArray(stats.surfaces) ? stats.surfaces : [];
      const surface = surfaces.find((entry) => entry && entry.target === `peer-video:${upstreamPeerId}`);

      const renderedFrames = Math.max(
        peer.peerTransport.decodedFramesRendered || 0,
        surface && surface.decodedFramesRendered ? surface.decodedFramesRendered : 0
      );
      updateViewerFpsIndicator(peer.peerTransport.remoteVideoFramesReceived || 0, renderedFrames);
      if (shouldShowDebugLogsFor('video', 'periodicStats')) {
        const rate = shouldEmitNativeDebugLog(`stats:viewer:${reason}:${upstreamPeerId}`, reason === 'initial' ? 0 : 5000);
        if (rate.emit) {
          logNativeStatsLine('[media-engine native-peer-stats]', [
            `reason=${reason}`,
            `peer=${peer.peerId || 'n/a'}`,
            `receiverConfigured=${Boolean(peer.peerTransport.videoReceiverConfigured)}`,
            `decoderReady=${Boolean(peer.peerTransport.decoderReady)}`,
            `framesReceived=${peer.peerTransport.remoteVideoFramesReceived || 0}`,
            `framesRendered=${peer.peerTransport.decodedFramesRendered || 0}`,
            `surfaceFrameStddevMs=${surface && typeof surface.frameIntervalStddevMs === 'number' ? surface.frameIntervalStddevMs.toFixed(3) : '0.000'}`,
            `queuedVideo=${peer.receiverRuntime && peer.receiverRuntime.queuedVideoUnits ? peer.receiverRuntime.queuedVideoUnits : 0}`,
            `queuedAudio=${peer.receiverRuntime && peer.receiverRuntime.queuedAudioBlocks ? peer.receiverRuntime.queuedAudioBlocks : 0}`,
            `submittedVideo=${peer.receiverRuntime && peer.receiverRuntime.submittedVideoUnits ? peer.receiverRuntime.submittedVideoUnits : 0}`,
            `dispatchedAudio=${peer.receiverRuntime && peer.receiverRuntime.dispatchedAudioBlocks ? peer.receiverRuntime.dispatchedAudioBlocks : 0}`,
            `droppedVideo=${peer.receiverRuntime && peer.receiverRuntime.droppedVideoUnits ? peer.receiverRuntime.droppedVideoUnits : 0}`,
            `droppedAudio=${peer.receiverRuntime && peer.receiverRuntime.droppedAudioBlocks ? peer.receiverRuntime.droppedAudioBlocks : 0}`,
            `lastVideoLatenessMs=${peer.receiverRuntime && typeof peer.receiverRuntime.lastVideoLatenessMs === 'number' ? peer.receiverRuntime.lastVideoLatenessMs : 0}`,
            `receiverReason=${peer.receiverRuntime && peer.receiverRuntime.reason ? peer.receiverRuntime.reason : 'n/a'}`,
            `receiverError=${peer.receiverRuntime && peer.receiverRuntime.lastError ? peer.receiverRuntime.lastError : ''}`,
            `mediaReady=${Boolean(peer.peerTransport.mediaPlaneReady)}`,
            `surfaceReason=${surface && surface.reason ? surface.reason : 'n/a'}`,
            `surfaceError=${surface && surface.lastError ? surface.lastError : ''}`
          ], rate.suppressed);
        }
        const relayPeers = peers.filter((entry) => entry && entry.role === 'relay-downstream');
        relayPeers.forEach((relayPeer) => {
          const relayRate = shouldEmitNativeDebugLog(
            `stats:relay:${reason}:${relayPeer.peerId || 'unknown'}`,
            reason === 'initial' ? 0 : 5000
          );
          if (!relayRate.emit) {
            return;
          }
          const relayRuntime = relayPeer.relaySubscriberRuntime || null;
          logNativeStatsLine('[media-engine native-relay-stats]', [
            `reason=${reason}`,
            `peer=${relayPeer.peerId || 'n/a'}`,
            `transportState=${relayPeer.peerTransport && relayPeer.peerTransport.connectionState ? relayPeer.peerTransport.connectionState : 'n/a'}`,
            `videoTrackOpen=${Boolean(relayPeer.peerTransport && relayPeer.peerTransport.videoTrackOpen)}`,
            `audioTrackOpen=${Boolean(relayPeer.peerTransport && relayPeer.peerTransport.audioTrackOpen)}`,
            `videoFramesSent=${relayPeer.peerTransport && Number.isFinite(relayPeer.peerTransport.videoFramesSent) ? relayPeer.peerTransport.videoFramesSent : 0}`,
            `audioFramesSent=${relayPeer.peerTransport && Number.isFinite(relayPeer.peerTransport.audioFramesSent) ? relayPeer.peerTransport.audioFramesSent : 0}`,
            `pendingBootstrap=${Boolean(relayRuntime && relayRuntime.pendingVideoBootstrap)}`,
            `bootstrapSnapshotSent=${Boolean(relayRuntime && relayRuntime.bootstrapSnapshotSent)}`,
            `relayFramesSent=${relayRuntime && Number.isFinite(relayRuntime.framesSent) ? relayRuntime.framesSent : 0}`,
            `relayReason=${relayRuntime && relayRuntime.reason ? relayRuntime.reason : 'n/a'}`,
            `relayError=${relayRuntime && relayRuntime.lastError ? relayRuntime.lastError : ''}`
          ], relayRate.suppressed);
        });
      }

      if (renderedFrames > 0 || peer.peerTransport.mediaPlaneReady) {
        upstreamConnected = true;
        videoStarted = true;
        clearViewerMediaWaitTimer();
        elements.waitingMessage.classList.add('hidden');
        elements.connectionStatus.textContent = '已连接';
        elements.connectionStatus.classList.add('connected');
        if (elements.viewerP2pStatus) {
          setP2pStatusElementState(elements.viewerP2pStatus, 'connected');
        }
        if (!viewerVolumeSynced) {
          viewerVolumeSynced = true;
          refreshViewerVolumeUi().catch((error) => {
            logRecoverableNativeWarning('viewer-volume:refresh-failed', error, {
              key: 'viewer-volume-refresh',
              category: 'audio',
              channel: 'nativeSteps',
              fallbackLabel: '[media-engine] delayed getViewerVolume failed:'
            });
          });
        }
        if (!viewerReadySent && currentRoomId && Number.isInteger(myChainPosition) && myChainPosition >= 0) {
          sendMessage({
            type: 'viewer-ready',
            roomId: currentRoomId,
            clientId,
            chainPosition: myChainPosition
          });
          viewerReadySent = true;
        }
      }

      renderP2pDiagnosticReport();
      return stats;
    } catch (error) {
      logRecoverableNativeWarning('native-peer-stats:failed', error, {
        key: 'native-peer-stats',
        category: 'video',
        channel: 'periodicStats',
        fallbackLabel: '[media-engine native-peer-stats] failed:'
      });
      return null;
    }
  }

  function startNativeViewerStatsPolling() {
    stopNativeViewerStatsPolling();
    resetViewerFpsIndicator();
    nativeViewerStatsIntervalId = setInterval(() => {
      if (!upstreamPeerId || sessionRole !== 'viewer') {
        stopNativeViewerStatsPolling();
        return;
      }
      pollNativeViewerStats('periodic');
    }, 2000);
    pollNativeViewerStats('initial');
  }

  function setViewerConnectionState(message) {
    if (elements.waitingMessage) {
      elements.waitingMessage.classList.remove('hidden');
    }
    if (elements.connectionStatus) {
      elements.connectionStatus.textContent = message;
      elements.connectionStatus.classList.remove('connected');
    }
  }

  async function startScreenShareWithSource(sourceId) {
    if (!nativeHostSessionEnabled) {
      throw new Error('native-host-session-disabled');
    }

    currentHostBackend = 'native';
    obsRoomCreatePending = false;
    obsIngestStreamActive = false;
    await ensureNativeUiReady();
    const parsedSource = parseCaptureSource(sourceId);
    parsedSource.backend = 'native';
    logNativeStep('startHostSession:source', {
      sourceId,
      parsedSource
    });
    await ensureMediaEngineStarted();
    await waitForHostUiReady();
    lockCodecUiToNativeH264();
    const preferredPreview = !(typeof qualitySettings === 'object' && qualitySettings && qualitySettings.previewEnabled === false);
    let allowPreviewForAttempt = nativeHostPreviewEnabled && preferredPreview;
    let previewFallbackNoticeShown = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await mediaEngine.startHostSession(parsedSource);
        logNativeDebug('video', '[media-engine] host session result:', JSON.stringify(session));
        if (!session || session.running !== true) {
          throw new Error(session && session.reason ? session.reason : 'native-host-session-start-failed');
        }
        if (!session.capturePlan || session.capturePlan.ready !== true || session.capturePlan.validated !== true) {
          await mediaEngine.stopHostSession({}).catch(() => {});
          const captureReason =
            (session && session.capturePlan && (session.capturePlan.lastError || session.capturePlan.validationReason || session.capturePlan.reason)) ||
            'native-host-capture-plan-not-ready';
          throw new Error(captureReason);
        }
        if (!session.pipeline || session.pipeline.ready !== true || session.pipeline.validated !== true) {
          await mediaEngine.stopHostSession({}).catch(() => {});
          const pipelineReason =
            (session && session.pipeline && (session.pipeline.lastError || session.pipeline.validationReason || session.pipeline.reason)) ||
            'native-host-pipeline-not-ready';
          throw new Error(pipelineReason);
        }

        const requestedCodec = normalizeNativeVideoCodec(
          session && session.requestedCodec,
          normalizeNativeVideoCodec(parsedSource.requestedCodec, 'h264')
        );
        const effectiveCodec = normalizeNativeVideoCodec(
          session && (session.effectiveCodec || session.codec),
          requestedCodec
        );
        nativeHostEffectiveCodec = effectiveCodec;

        if (typeof qualitySettings === 'object' && qualitySettings) {
          qualitySettings.codecPreference = effectiveCodec;
        }
        lockCodecUiToNativeH264();

        nativeHostSessionRunning = true;
        localStream = null;
        hostPreviewRequested = allowPreviewForAttempt;
        hideLegacyVideoElements();
        if (hostVideoContainer) {
          hostVideoContainer.classList.toggle('hidden', !hostPreviewRequested);
        }
        startNativeHostStatsPolling();

        elements.btnStartShare.classList.add('hidden');
        elements.btnStopShare.classList.remove('hidden');
        syncHostWaitingWindowRestoreUi(
          session && session.capturePlan && session.capturePlan.captureState === 'minimized',
          `正在共享（原生，${effectiveCodec.toUpperCase()}）`
        );
        updateHostEncoderDetail(session && session.pipeline ? session.pipeline : null);

        if (allowPreviewForAttempt) {
          await waitForHostUiReady();
          await attachNativeHostPreviewSurface();
        }

        if (!allowPreviewForAttempt && preferredPreview && !previewFallbackNoticeShown) {
          previewFallbackNoticeShown = true;
          showError('原生预览暂不可用，已自动改为无预览开播');
        }

        sendMessage({
          type: 'create-room',
          clientId,
          publicListing: Boolean(qualitySettings && qualitySettings.publicRoomEnabled)
        });
        return;
      } catch (error) {
        await cleanupAfterFailedHostStart();
        if (attempt === 0 && allowPreviewForAttempt && isRecoverableHostPreviewAttachError(error)) {
          logNativeStep('startHostSession:retry-without-preview', {
            message: error && error.message ? error.message : String(error),
            sourceId
          }, 'video');
          allowPreviewForAttempt = false;
          await ensureMediaEngineStarted();
          continue;
        }
        throw error;
      }
    }
  }

  async function startScreenShareWithObsIngest(options = {}) {
    if (!nativeHostSessionEnabled) {
      throw new Error('native-host-session-disabled');
    }

    currentHostBackend = 'obs-ingest';
    obsRoomCreatePending = false;
    obsIngestStreamActive = false;
    await ensureNativeUiReady();
    await ensureMediaEngineStarted();
    await waitForHostUiReady();
    const requestedPort = Number.isFinite(Number(options && options.port))
      ? Math.round(Number(options.port))
      : 0;
    const session = await mediaEngine.startHostSession({
      backend: 'obs-ingest',
      port: requestedPort
    });
    logNativeDebug('video', '[media-engine] obs ingest session result:', JSON.stringify(session));
    if (!session || session.running !== true) {
      throw new Error(session && session.reason ? session.reason : 'obs-ingest-session-start-failed');
    }

    nativeHostSessionRunning = true;
    localStream = null;
    hostWaitingWindowRestore = false;
    hostPreviewRequested = false;
    hideLegacyVideoElements();
    if (hostVideoContainer) {
      hostVideoContainer.classList.add('hidden');
    }
    startNativeHostStatsPolling();

    elements.roomInfo.classList.add('hidden');
    elements.viewerCount.textContent = '0';
    elements.btnStartShare.classList.add('hidden');
    elements.btnStopShare.classList.remove('hidden');
    elements.hostStatus.textContent = '等待 OBS 推流...';
    elements.hostStatus.classList.add('waiting');
    updateHostEncoderDetail(null, session && session.obsIngest ? session.obsIngest : null);
  }

  async function startScreenShareWithAudio(sourceId, audioPid) {
    await startScreenShareWithSource(sourceId);

    if (audioPid && typeof mediaEngine.startAudioSession === 'function') {
      try {
        const session = await mediaEngine.startAudioSession({
          pid: Number(audioPid),
          processName: ''
        });
        if (!session || session.captureActive !== true || session.ready !== true) {
          showError('原生音频当前不可用，将仅共享画面');
        }
      } catch (error) {
        logRecoverableNativeWarning('native-audio-session:start-failed', error, {
          key: 'native-audio-session-start-failed',
          category: 'audio',
          channel: 'nativeSteps',
          fallbackLabel: '[media-engine] native audio session start failed:'
        });
        showError('原生音频启动失败，将仅共享画面');
      }
    }
  }

  async function stopScreenShare() {
    if (stopScreenShareInFlight) {
      return;
    }

    stopScreenShareInFlight = true;
    setHostStopUiState(true);
    logNativeStep('stopScreenShare:begin', {
      peerCount: nativePeerHandles.size,
      hasRoom: Boolean(currentRoomId),
      sessionRole
    }, 'video');

    try {
      stopNativeHostStatsPolling();
      stopNativeViewerStatsPolling();
      await detachNativeHostPreviewSurface().catch(() => {});
      logNativeStep('stopScreenShare:preview-detached', {}, 'video');

      const peerIds = Array.from(nativePeerHandles.keys());
      const peerCloseResults = await Promise.allSettled(
        peerIds.map((peerId) => closeNativePeerConnectionImpl(peerId, { clearRetryState: true }))
      );
      const failedPeerCloses = peerCloseResults.filter((result) => result.status === 'rejected').length;
      logNativeStep('stopScreenShare:peers-closed', { peerCount: peerIds.length }, 'video');
      if (failedPeerCloses > 0) {
        logNativeStep('stopScreenShare:peer-close-failures', { failedPeerCloses }, 'video');
      }

      await Promise.all([
        typeof mediaEngine.stopAudioSession === 'function'
          ? mediaEngine.stopAudioSession({}).catch(() => {})
          : Promise.resolve(null),
        typeof mediaEngine.stopHostSession === 'function'
          ? mediaEngine.stopHostSession({}).catch(() => {})
          : Promise.resolve(null)
      ]);
      logNativeStep('stopScreenShare:sessions-stopped', {}, 'video');

      nativeHostSessionRunning = false;
      hostWaitingWindowRestore = false;
      obsRoomCreatePending = false;
      obsIngestStreamActive = false;
      currentHostBackend = getRequestedHostBackend();

      if (currentRoomId && sessionRole === 'host') {
        sendMessage({
          type: 'leave-room',
          roomId: currentRoomId,
          clientId
        }, { queueIfDisconnected: false });
        logNativeStep('stopScreenShare:leave-room-sent', { roomId: currentRoomId }, 'connection');
      }

      sessionRole = null;
      currentRoomId = null;
      currentSessionToken = null;
      hostId = null;
      upstreamPeerId = null;
      relayStream = null;
      upstreamConnected = false;
      viewerReadySent = false;
      videoStarted = false;
      clearViewerMediaWaitTimer();

      elements.roomInfo.classList.add('hidden');
      elements.viewerCount.textContent = '0';
      elements.btnStartShare.classList.remove('hidden');
      elements.btnStopShare.classList.add('hidden');
      elements.hostStatus.textContent = '准备就绪';
      elements.hostStatus.classList.remove('waiting');
      updateHostEncoderDetail(null);
      resetHostFpsIndicators();
      hideLegacyVideoElements();
      hostPreviewRequested = shouldShowNativeHostPreviewForBackend(currentHostBackend);
      if (hostVideoContainer) {
        hostVideoContainer.classList.toggle('hidden', !hostPreviewRequested);
      }
    } finally {
      stopScreenShareInFlight = false;
      setHostStopUiState(false);
    }
  }

  function createPeerConnection(peerId, isInitiator, kind = 'direct') {
    if (!isNativePeerDriverActive()) {
      throw new Error('native-peer-transport-disabled');
    }

    return createNativePeerConnectionImpl(peerId, isInitiator, kind);
  }

  async function createOffer(viewerId, options = {}) {
    const existingPc = peerConnections.get(viewerId);
    if (existingPc && !options.force && existingPc.__offerPromise) {
      await existingPc.__offerPromise;
      return existingPc;
    }

    if (
      existingPc &&
      !options.force &&
      existingPc.localDescription &&
      existingPc.localDescription.type === 'offer' &&
      ['new', 'connecting', 'connected'].includes(existingPc.connectionState)
    ) {
      return existingPc;
    }

    if (existingPc) {
      await closeNativePeerConnectionImpl(viewerId);
    }

    const pc = createPeerConnection(viewerId, true, 'host-viewer');
    pc.__offerPromise = createAndSendPeerOffer(viewerId, pc, options)
      .finally(() => {
        pc.__offerPromise = null;
      });
    await pc.__offerPromise;
    return pc;
  }

  async function createOfferToNextViewer(nextViewerId) {
    if (!nextViewerId) {
      throw new Error('native-relay-next-viewer-missing');
    }
    if (isHost || sessionRole !== 'viewer') {
      throw new Error('native-relay-role-invalid');
    }
    if (!upstreamPeerId) {
      throw new Error('native-relay-upstream-peer-missing');
    }

    const existingPc = peerConnections.get(nextViewerId);
    if (existingPc && existingPc.__offerPromise) {
      await existingPc.__offerPromise;
      return existingPc;
    }

    if (
      existingPc &&
      existingPc.localDescription &&
      existingPc.localDescription.type === 'offer' &&
      ['new', 'connecting', 'connected'].includes(existingPc.connectionState)
    ) {
      return existingPc;
    }

    if (existingPc) {
      await closeNativePeerConnectionImpl(nextViewerId);
    }

    const pc = createPeerConnection(nextViewerId, false, 'relay-viewer');
    pc.relaySourcePeerId = upstreamPeerId;
    pc.__offerPromise = createAndSendPeerOffer(nextViewerId, pc, { isRelay: true })
      .finally(() => {
        pc.__offerPromise = null;
      });
    await pc.__offerPromise;
    clearPeerReconnect(nextViewerId);
    return pc;
  }

  function scheduleRelayOfferRetry(nextViewerId, error) {
    if (!nextViewerId || sessionRole !== 'viewer' || isHost) {
      return;
    }

    const existing = peerReconnectState.get(nextViewerId) || { attempts: 0, timerId: null };
    if (existing.timerId) {
      clearTimeout(existing.timerId);
    }

    const nextAttempt = Number(existing.attempts || 0) + 1;
    if (nextAttempt > 2) {
      peerReconnectState.delete(nextViewerId);
      logRecoverableNativeWarning('relay:connect-to-next-exhausted', error, {
        key: `relay-connect-exhausted:${nextViewerId}`,
        category: 'connection',
        channel: 'nativeSteps',
        fallbackLabel: `[media-engine relay] exhausted connect-to-next retries: ${nextViewerId}`
      });
      return;
    }

    const retryDelays = Array.isArray(P2P_RECONNECT_DELAYS_MS) && P2P_RECONNECT_DELAYS_MS.length
      ? P2P_RECONNECT_DELAYS_MS
      : [750, 1500];
    const retryDelayMs = retryDelays[Math.min(nextAttempt - 1, retryDelays.length - 1)];
    const timerId = setTimeout(async () => {
      peerReconnectState.delete(nextViewerId);
      if (sessionRole !== 'viewer' || isHost || !currentRoomId || !upstreamPeerId) {
        return;
      }

      try {
        await createOfferToNextViewer(nextViewerId);
      } catch (retryError) {
        scheduleRelayOfferRetry(nextViewerId, retryError);
      }
    }, retryDelayMs);

    peerReconnectState.set(nextViewerId, {
      attempts: nextAttempt,
      timerId
    });
  }

  function clearAllRelayOfferRetries() {
    for (const [peerId, state] of peerReconnectState.entries()) {
      if (state && state.timerId) {
        clearTimeout(state.timerId);
      }
      peerReconnectState.delete(peerId);
    }
  }

  async function handleOffer(data) {
    const fromId = data.fromClientId;
    const remoteDescription = normalizeNativeSessionDescription(data.sdp);
    logNativeStep('signal:offer', {
      fromId,
      isHost,
      sdpLength: remoteDescription.sdp ? String(remoteDescription.sdp).length : 0
    });

    if (!isHost && upstreamPeerId && upstreamPeerId !== fromId) {
      await resetViewerMediaPipeline('正在切换上游连接...');
    }

    if (!isHost) {
      upstreamPeerId = fromId;
    }

    let pc = peerConnections.get(fromId);
    const shouldRecreatePeer =
      pc &&
      isNativePeerHandle(pc) &&
      pc.remoteDescription &&
      pc.remoteDescription.type &&
      pc.connectionState !== 'connected';

    if (!pc || !isNativePeerHandle(pc) || shouldRecreatePeer) {
      if (pc) {
        await closeNativePeerConnectionImpl(fromId);
      }
      pc = createPeerConnection(fromId, false, 'upstream');
    } else if (isSameRemoteDescription(pc.remoteDescription, remoteDescription)) {
      await flushQueuedRemoteCandidates(fromId, pc);
      if (!isHost) {
        startNativeViewerStatsPolling();
      }
      return;
    }

    await setPeerRemoteDescription(fromId, pc, remoteDescription);
    if (!isHost) {
      await attachNativePeerVideoSurface(fromId);
    }
    await flushQueuedRemoteCandidates(fromId, pc);
    await createAndSendPeerAnswer(fromId, pc);
    if (!isHost) {
      startNativeViewerStatsPolling();
    }
  }

  async function handleAnswer(data) {
    const fromId = data.fromClientId || data.targetId;
    const remoteDescription = normalizeNativeSessionDescription(data.sdp);
    logNativeStep('signal:answer', {
      fromId,
      targetId: data.targetId,
      sdpLength: remoteDescription.sdp ? String(remoteDescription.sdp).length : 0
    });
    const peerId = peerConnections.has(fromId) ? fromId : data.targetId;
    const pc = peerConnections.get(peerId);
    if (!pc) {
      return;
    }
    if (!pc.localDescription || pc.localDescription.type !== 'offer') {
      logNativeStep('signal:answer:ignored', { peerId, reason: 'stale-answer-without-local-offer' });
      return;
    }
    if (isSameRemoteDescription(pc.remoteDescription, remoteDescription)) {
      await flushQueuedRemoteCandidates(peerId, pc);
      return;
    }

    await setPeerRemoteDescription(peerId, pc, remoteDescription);
    await flushQueuedRemoteCandidates(peerId, pc);
  }

  async function handleIceCandidate(data) {
    const peerId = data.fromClientId;
    if (!data.candidate) {
      return;
    }

    logNativeStep('signal:ice-candidate', {
      peerId,
      candidateLength: String(data.candidate || '').length
    });

    const pc = peerConnections.get(peerId);
    if (!pc) {
      queueRemoteCandidate(peerId, data.candidate);
      return;
    }

    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      queueRemoteCandidate(peerId, data.candidate);
      return;
    }

    await addPeerRemoteIceCandidate(peerId, pc, data.candidate);
  }

  async function closePeerConnection(peerId, options = {}) {
    if (!isNativePeerDriverActive()) {
      throw new Error('native-peer-transport-disabled');
    }

    return closeNativePeerConnectionImpl(peerId, options);
  }

  async function clearAllPeerConnections(options = {}) {
    if (!isNativePeerDriverActive()) {
      throw new Error('native-peer-transport-disabled');
    }

    return clearNativePeerConnectionsImpl(options);
  }

  async function handleMessage(data) {
    logNativeDebug('connection', 'Received:', data.type);

    switch (data.type) {
      case 'room-created':
        obsRoomCreatePending = false;
        if (isObsIngestHostBackend() && !obsIngestStreamActive) {
          sendMessage({
            type: 'leave-room',
            roomId: data.roomId,
            clientId
          }, { queueIfDisconnected: false });
          if (elements.hostStatus) {
            elements.hostStatus.textContent = '等待 OBS 推流...';
            elements.hostStatus.classList.add('waiting');
          }
          return;
        }
        currentRoomId = data.roomId;
        sessionRole = 'host';
        currentSessionToken = data.sessionToken || '';
        elements.roomIdDisplay.textContent = data.roomId;
        elements.roomInfo.classList.remove('hidden');
        elements.btnStartShare.classList.add('hidden');
        elements.btnStopShare.classList.remove('hidden');
        if (typeof window.__vdsCopyRoomIdToClipboard === 'function') {
          window.__vdsCopyRoomIdToClipboard({
            roomId: data.roomId,
            successMessage: '房间号已自动复制',
            showFailureToast: false
          }).catch((error) => {
            logNativeStep('room-created:auto-copy-room-id-failed', {
              roomId: data.roomId,
              message: error && error.message ? error.message : String(error)
            }, 'connection');
          });
        }
        if (typeof window.__vdsRenderHostPublicListingUi === 'function') {
          window.__vdsRenderHostPublicListingUi();
        }
        if (elements.hostP2pStatus) {
          setP2pStatusElementState(elements.hostP2pStatus, 'waiting-viewer');
        }
        startNativeHostStatsPolling();
        if (hostWaitingWindowRestore) {
          syncHostWaitingWindowRestoreUi(true);
        } else {
          elements.hostStatus.textContent = isObsIngestHostBackend() ? '正在共享（OBS）' : '原生分享已就绪';
          elements.hostStatus.classList.remove('waiting');
        }
        return;

      case 'room-joined':
        clearAllRelayOfferRetries();
        await clearAllPeerConnections({ clearRetryState: true });
        resetViewerFpsIndicator();
        currentRoomId = data.roomId;
        sessionRole = 'viewer';
        currentSessionToken = data.sessionToken || '';
        myChainPosition = data.chainPosition;
        hostId = data.hostId;
        upstreamPeerId = data.upstreamPeerId || data.hostId;
        viewerReadySent = false;
        videoStarted = false;
        upstreamConnected = false;
        clearViewerMediaWaitTimer();
        if (typeof window.__vdsHandleViewerJoinSucceeded === 'function') {
          window.__vdsHandleViewerJoinSucceeded();
        }
        elements.joinForm.classList.add('hidden');
        elements.viewerStatus.classList.remove('hidden');
        elements.viewerRoomId.textContent = data.roomId;
        elements.btnLeave.classList.remove('hidden');
        elements.chainPosition.textContent = String(data.chainPosition + 1);
        if (typeof window.__vdsRenderViewerPlaybackPrefsUi === 'function') {
          window.__vdsRenderViewerPlaybackPrefsUi();
        }
        setViewerConnectionState('等待上游连接...');
        return;

      case 'session-resumed':
        currentRoomId = data.roomId;
        sessionRole = data.role;
        currentSessionToken = data.sessionToken || currentSessionToken || '';
        if (data.role === 'host') {
          obsRoomCreatePending = false;
          obsIngestStreamActive = isObsIngestHostBackend() ? true : obsIngestStreamActive;
          isHost = true;
          elements.roomIdDisplay.textContent = data.roomId;
          elements.roomInfo.classList.remove('hidden');
          elements.viewerCount.textContent = String(data.viewerCount || 0);
          elements.btnStartShare.classList.add('hidden');
          elements.btnStopShare.classList.remove('hidden');
          if (typeof window.__vdsRenderHostPublicListingUi === 'function') {
            window.__vdsRenderHostPublicListingUi();
          }
          if (elements.hostP2pStatus) {
            setP2pStatusElementState(elements.hostP2pStatus, 'waiting-viewer');
          }
          startNativeHostStatsPolling();
          if (hostWaitingWindowRestore) {
            syncHostWaitingWindowRestoreUi(true);
          } else {
            elements.hostStatus.textContent = isObsIngestHostBackend() ? '正在共享（OBS）' : '原生分享已恢复';
            elements.hostStatus.classList.remove('waiting');
          }
          return;
        }

        isHost = false;
        clearAllRelayOfferRetries();
        await clearAllPeerConnections({ clearRetryState: true });
        resetViewerFpsIndicator();
        hostId = data.hostId || hostId;
        upstreamPeerId = data.upstreamPeerId || hostId;
        myChainPosition = data.chainPosition;
        clearViewerMediaWaitTimer();
        if (typeof window.__vdsHandleViewerJoinSucceeded === 'function') {
          window.__vdsHandleViewerJoinSucceeded();
        }
        elements.joinForm.classList.add('hidden');
        elements.viewerStatus.classList.remove('hidden');
        elements.viewerRoomId.textContent = data.roomId;
        elements.btnLeave.classList.remove('hidden');
        elements.chainPosition.textContent = String(myChainPosition + 1);
        if (typeof window.__vdsRenderViewerPlaybackPrefsUi === 'function') {
          window.__vdsRenderViewerPlaybackPrefsUi();
        }
        if (!upstreamConnected) {
          setViewerConnectionState('正在恢复上游连接...');
        } else if (elements.connectionStatus) {
          elements.connectionStatus.textContent = '已连接';
          elements.connectionStatus.classList.add('connected');
        }
        return;

      case 'error':
        obsRoomCreatePending = false;
        if (typeof window.__vdsHandleViewerJoinError === 'function') {
          const handled = await window.__vdsHandleViewerJoinError(data);
          if (handled) {
            return;
          }
        }
        showError(data.message);
        return;

      case 'viewer-joined':
        if (!nativeHostSessionRunning) {
          throw new Error('native-host-session-not-running');
        }
        if (!data.reconnect) {
          updateViewerCount(data.viewerId);
        }
        await createOffer(data.viewerId, { force: Boolean(data.reconnect) });
        return;

      case 'connect-to-next':
        try {
          await createOfferToNextViewer(data.nextViewerId);
        } catch (error) {
          logRecoverableNativeWarning('relay:connect-to-next-failed', error, {
            key: `relay-connect-failed:${data.nextViewerId}`,
            category: 'connection',
            channel: 'nativeSteps',
            fallbackLabel: `[media-engine relay] connect-to-next failed: ${data.nextViewerId}`
          });
          await closeNativePeerConnectionImpl(data.nextViewerId, { clearRetryState: true }).catch(() => {});
          scheduleRelayOfferRetry(data.nextViewerId, error);
        }
        return;

      case 'offer':
        await handleOffer(data);
        return;

      case 'answer':
        await handleAnswer(data);
        return;

      case 'ice-candidate':
        await handleIceCandidate(data);
        return;

      case 'host-disconnected':
        showError('分享者已断开连接');
        await resetViewerState();
        return;

      case 'viewer-left':
        updateViewerCount(null, data.leftPosition);
        await closeNativePeerConnectionImpl(data.viewerId, { clearRetryState: true });
        return;

      case 'chain-reconnect':
        clearAllRelayOfferRetries();
        myChainPosition = data.newChainPosition;
        upstreamPeerId = data.upstreamPeerId || hostId;
        await resetViewerMediaPipeline('正在重建上游连接...');
        elements.chainPosition.textContent = String(myChainPosition + 1);
        return;

      default:
        return;
    }
  }

  function updateFullscreenUi(isFullscreen) {
    document.body.classList.toggle('native-embedded-fullscreen', Boolean(isFullscreen));
    syncViewerFullscreenUnderbarState();
    if (Boolean(isFullscreen) && document.body.getAttribute('data-app-view') === 'viewer') {
      showViewerFullscreenControls();
    }
    forceEmbeddedSurfaceResync();
  }

  async function handleFullscreenButtonClick() {
    const isFullscreen = await electronApi.isFullscreen();
    const nextState = await electronApi.setFullscreen(!isFullscreen);
    updateFullscreenUi(nextState);
  }

  async function handleFullscreenEscapeKey(event) {
    if (!event || event.key !== 'Escape' || !electronApi || typeof electronApi.isFullscreen !== 'function') {
      return;
    }

    const isFullscreen = await electronApi.isFullscreen();
    if (!isFullscreen) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextState = await electronApi.setFullscreen(false);
    updateFullscreenUi(nextState);
  }

  async function refreshViewerVolumeUi() {
    if (!viewerVolumeInput || !viewerVolumeValue || typeof mediaEngine.getViewerVolume !== 'function') {
      return;
    }

    try {
      const result = await mediaEngine.getViewerVolume();
      const volume = Math.round(
        Math.max(0, Math.min(1, Number(result && result.volume))) * 100
      );
      applyViewerVolumeUi(volume);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message.includes('No active render audio session was found')) {
        applyViewerVolumeUi(100);
        return;
      }
      logRecoverableNativeWarning('viewer-volume:get-failed', error, {
        key: 'viewer-volume-get',
        category: 'audio',
        channel: 'nativeSteps',
        fallbackLabel: '[media-engine] getViewerVolume failed:'
      });
    }
  }

  async function handleViewerVolumeInput(event) {
    const nextValue = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    await setViewerVolumeValue(nextValue);
    showViewerFullscreenControls();
  }

  async function initializeNativeUi() {
    logNativeStep('initializeNativeUi:config', {
      nativePeerTransportEnabled,
      nativeHostSessionEnabled,
      nativeHostPreviewEnabled,
      nativeSurfaceEmbeddingEnabled,
      verboseNativeLogs
    });
    lockCodecUiToNativeH264();
    hideLegacyVideoElements();

    if (hostFullscreenButton) {
      hostFullscreenButton.addEventListener('click', handleFullscreenButtonClick);
    }
    if (viewerFullscreenButton) {
      viewerFullscreenButton.addEventListener('click', handleFullscreenButtonClick);
    }
    if (viewerVolumeInput) {
      viewerVolumeInput.addEventListener('input', handleViewerVolumeInput);
    }
    if (viewerFullscreenVolumeInput) {
      viewerFullscreenVolumeInput.addEventListener('input', handleViewerVolumeInput);
      viewerFullscreenVolumeInput.addEventListener('pointerdown', () => {
        viewerFullscreenVolumeDragging = true;
        setViewerFullscreenVolumePopoverOpen(true);
        showViewerFullscreenControls();
      });
      viewerFullscreenVolumeInput.addEventListener('pointerup', () => {
        viewerFullscreenVolumeDragging = false;
        if (document.activeElement === viewerFullscreenVolumeInput) {
          viewerFullscreenVolumeInput.blur();
        }
        scheduleViewerFullscreenVolumePopoverHide(1000);
        scheduleViewerFullscreenControlsHide(1400);
      });
      viewerFullscreenVolumeInput.addEventListener('change', () => {
        viewerFullscreenVolumeDragging = false;
        if (document.activeElement === viewerFullscreenVolumeInput) {
          viewerFullscreenVolumeInput.blur();
        }
        scheduleViewerFullscreenVolumePopoverHide(900);
        scheduleViewerFullscreenControlsHide(1300);
      });
      viewerFullscreenVolumeInput.addEventListener('blur', () => {
        viewerFullscreenVolumeDragging = false;
      });
    }
    applyViewerVolumeUi(100);
    if (viewerFullscreenVolumeControl) {
      viewerFullscreenVolumeControl.addEventListener('mouseenter', () => {
        setViewerFullscreenVolumePopoverOpen(true);
        showViewerFullscreenControls();
      });
      viewerFullscreenVolumeControl.addEventListener('mouseleave', () => {
        scheduleViewerFullscreenVolumePopoverHide(320);
        scheduleViewerFullscreenControlsHide(900);
      });
      viewerFullscreenVolumeControl.addEventListener('focusin', () => {
        setViewerFullscreenVolumePopoverOpen(true);
        showViewerFullscreenControls();
      });
      viewerFullscreenVolumeControl.addEventListener('focusout', () => {
        window.setTimeout(() => {
          if (!isViewerFullscreenVolumePopoverPinned()) {
            scheduleViewerFullscreenVolumePopoverHide(180);
            scheduleViewerFullscreenControlsHide(900);
          }
        }, 0);
      });
    }
    if (viewerFullscreenMuteButton) {
      viewerFullscreenMuteButton.addEventListener('click', () => {
        toggleViewerMute().catch((error) => {
          logRecoverableNativeWarning('viewer-volume:mute-toggle-failed', error, {
            key: 'viewer-volume-mute-toggle',
            category: 'audio',
            channel: 'nativeSteps',
            fallbackLabel: '[media-engine] mute toggle failed:'
          });
        });
      });
    }
    if (viewerFullscreenExitButton) {
      viewerFullscreenExitButton.addEventListener('click', () => {
        exitViewerFullscreen().catch((error) => {
          logRecoverableNativeWarning('viewer-fullscreen:exit-failed', error, {
            key: 'viewer-fullscreen-exit',
            category: 'video',
            channel: 'nativeSteps',
            fallbackLabel: '[media-engine] viewer fullscreen exit failed:'
          });
        });
      });
    }
    if (remoteVideoContainer) {
      const showControls = () => {
        showViewerFullscreenControls();
      };
      remoteVideoContainer.addEventListener('mousemove', showControls);
      remoteVideoContainer.addEventListener('mouseenter', showControls);
      remoteVideoContainer.addEventListener('touchstart', showControls, { passive: true });
    }
    if (viewerFullscreenUnderbar) {
      viewerFullscreenUnderbar.addEventListener('mouseenter', () => {
        showViewerFullscreenControls();
      });
      viewerFullscreenUnderbar.addEventListener('mouseleave', () => {
        scheduleViewerFullscreenVolumePopoverHide(220);
        scheduleViewerFullscreenControlsHide(900);
      });
      viewerFullscreenUnderbar.addEventListener('focusin', () => {
        showViewerFullscreenControls();
      });
    }

    if (elements.btnStopShare) {
      elements.btnStopShare.addEventListener('click', (event) => {
        if (!nativeHostSessionRunning) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        stopScreenShare().catch((error) => {
          logNativeDebug('video', '[media-engine] stopScreenShare failed:', error && error.message ? error.message : String(error));
          showError(`停止共享失败：${error && error.message ? error.message : String(error)}`);
        });
      }, true);
    }

    if (typeof electronApi.onFullscreenChange === 'function') {
      electronApi.onFullscreenChange(updateFullscreenUi);
    }

    window.addEventListener('keydown', (event) => {
      handleFullscreenEscapeKey(event).catch((error) => {
        logRecoverableNativeWarning('fullscreen-escape:failed', error, {
          key: 'fullscreen-escape',
          category: 'video',
          channel: 'nativeSteps',
          fallbackLabel: '[media-engine] fullscreen escape failed:'
        });
      });
    }, true);

    if (typeof electronApi.getWindowBounds === 'function') {
      try {
        currentWindowBounds = await electronApi.getWindowBounds();
      } catch (_error) {
        currentWindowBounds = null;
      }
    }

    if (typeof electronApi.onWindowBoundsChange === 'function') {
      electronApi.onWindowBoundsChange((bounds) => {
        currentWindowBounds = bounds || null;
        forceEmbeddedSurfaceResyncBurst();
      });
    }
    if (typeof electronApi.onMaximizedChange === 'function') {
      electronApi.onMaximizedChange(() => {
        refreshCurrentWindowBounds().finally(() => {
          forceEmbeddedSurfaceResyncBurst();
        });
      });
    }

    const syncLayouts = () => {
      scheduleEmbeddedSurfaceSync();
    };

    if (nativeSurfaceEmbeddingEnabled && typeof ResizeObserver !== 'undefined') {
      if (hostVideoContainer) {
        const observer = new ResizeObserver(syncLayouts);
        observer.observe(hostVideoContainer);
      }

      if (remoteVideoContainer) {
        const observer = new ResizeObserver(syncLayouts);
        observer.observe(remoteVideoContainer);
      }
    }

    if (nativeSurfaceEmbeddingEnabled) {
      window.addEventListener('resize', syncLayouts);
      window.addEventListener('scroll', syncLayouts, true);
      window.addEventListener('wheel', scheduleWheelDrivenSurfaceSync, {
        capture: true,
        passive: true
      });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncLayouts);
        window.visualViewport.addEventListener('scroll', syncLayouts);
      }
    }

    if (typeof mediaEngine.onEvent === 'function') {
      mediaEngine.onEvent(handleNativeMediaEngineEvent);
    }
    if (typeof mediaEngine.onStatus === 'function') {
      mediaEngine.onStatus((status) => {
        logNativeDebug('misc', 'Native media engine status updated:', status);
      });
    }

    await ensureMediaEngineStarted();
  }

  window.isNativePeerDriverActive = isNativePeerDriverActive;
  window.isNativePeerHandle = isNativePeerHandle;
  window.startScreenShareWithSource = startScreenShareWithSource;
  window.startScreenShareWithObsIngest = startScreenShareWithObsIngest;
  window.startScreenShareWithAudio = startScreenShareWithAudio;
  window.stopScreenShare = stopScreenShare;
  window.createPeerConnection = createPeerConnection;
  window.createOffer = createOffer;
  window.createOfferToNextViewer = createOfferToNextViewer;
  window.handleOffer = handleOffer;
  window.handleAnswer = handleAnswer;
  window.handleIceCandidate = handleIceCandidate;
  window.closePeerConnection = closePeerConnection;
  window.clearAllPeerConnections = clearAllPeerConnections;
  window.handleMessage = handleMessage;
  window.setViewerConnectionState = setViewerConnectionState;
  window.__vdsBuildP2pDiagnosticReport = buildP2pDiagnosticReport;
  window.__vdsRenderP2pDiagnosticReport = renderP2pDiagnosticReport;
  window.__vdsBuildHostCaptureDiagnosticReport = buildHostCaptureDiagnosticReport;
  window.__vdsRenderHostCaptureDiagnosticReport = renderHostCaptureDiagnosticReport;

  nativeUiReadyPromise = initializeNativeUi();

  nativeUiReadyPromise.catch((error) => {
    console.error('[media-engine] native override init failed:', error);
    showError(`Native init failed: ${error && error.message ? error.message : String(error)}`);
  });
})();
