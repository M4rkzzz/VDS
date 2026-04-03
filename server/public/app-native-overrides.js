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
  const sourcePreviewEnabled = document.getElementById('source-preview-enabled');
  const hostFullscreenButton = document.getElementById('btn-host-fullscreen');
  const viewerFullscreenButton = document.getElementById('btn-viewer-fullscreen');
  const viewerVolumeInput = document.getElementById('viewer-volume');
  const viewerVolumeValue = document.getElementById('viewer-volume-value');

  const nativePeerHandles = new Map();
  const nativePeerSignalBacklog = new Map();
  const nativePeerSignalWaiters = new Map();
  const attachedEmbeddedSurfaces = new Map();

  const HOST_PREVIEW_SURFACE_ID = 'embedded-host-preview';

  let nativeHostSessionRunning = false;
  let nativeViewerStatsIntervalId = null;
  let nativeHostStatsIntervalId = null;
  let mediaEngineStarted = false;
  let mediaEngineStartPromise = null;
  let hostPreviewSurfaceAttached = false;
  let viewerVolumeSynced = false;
  let embeddedSurfaceSyncRafId = 0;
  let embeddedSurfaceSyncInFlight = false;
  let embeddedSurfaceSyncPending = false;
  let embeddedSurfaceTrackingRafId = 0;
  let wheelDrivenSyncRafId = 0;
  let wheelDrivenSyncFramesRemaining = 0;
  let currentWindowBounds = null;
  let hostPreviewRequested = true;

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
    return shouldShowDebugLogsFor('misc');
  }

  function isBlockingModalVisible() {
    return Boolean(document.querySelector('.modal:not(.hidden)'));
  }

  function isVerboseMediaLoggingEnabled() {
    return verboseNativeLogs;
  }

  function shouldShowDebugLogsFor(category = 'misc') {
    if (verboseNativeLogs) {
      return true;
    }

    if (typeof window.__vdsShouldDebugLog === 'function') {
      try {
        return Boolean(window.__vdsShouldDebugLog(category));
      } catch (_error) {
        return false;
      }
    }

    return isDebugModeEnabled();
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
    if (!shouldShowDebugLogsFor(category)) {
      return;
    }
    console.log(...args);
  }

  function logNativeStep(scope, payload, category = getNativeDebugCategoryFromScope(scope)) {
    if (!shouldShowDebugLogsFor(category)) {
      return;
    }
    const normalized = summarizeNativeLogValue(payload);
    try {
      console.log(`[media-engine step] ${scope} ${JSON.stringify(normalized)}`);
    } catch (_error) {
      console.log(`[media-engine step] ${scope}`, normalized || null);
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

    const debugCategory = getNativeDebugCategoryFromEvent(event);

    if (shouldShowDebugLogsFor(debugCategory)) {
      console.log('Native media engine event:', event.event, event.params || null);
    } else if (event.event === 'warning') {
      console.warn('Native media engine event:', event.event, event.params || null);
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
    const cssWidth = Math.max(0, Math.round(clippedRight - clippedLeft));
    const cssHeight = Math.max(0, Math.round(clippedBottom - clippedTop));
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
          height: cssHeight
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
          height: cssHeight
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
    const result = await mediaEngine.updateSurface(payload);
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
        console.warn('[media-engine] surface sync failed:', surfaceId, error);
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
        console.warn('[media-engine] syncAllEmbeddedSurfaces failed:', error);
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

  function stopEmbeddedSurfaceTrackingLoop() {
    if (embeddedSurfaceTrackingRafId) {
      window.cancelAnimationFrame(embeddedSurfaceTrackingRafId);
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
      embeddedSurfaceTrackingRafId = window.requestAnimationFrame(tick);
    };

    embeddedSurfaceTrackingRafId = window.requestAnimationFrame(tick);
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

  function parseCaptureSource(sourceId) {
    const normalized = String(sourceId || '').trim();
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
        : 'h264';
    const sharedConfig = {
      codec: effectiveCodec,
      requestedCodec,
      width: qualitySettings.width,
      height: qualitySettings.height,
      frameRate: qualitySettings.frameRate,
      bitrateKbps: qualitySettings.bitrate,
      hardwareAcceleration: qualitySettings.hardwareAcceleration !== false,
      encoderPreset: qualitySettings.encoderPreset || 'balanced',
      encoderTune: qualitySettings.encoderTune === 'none' ? '' : (qualitySettings.encoderTune || '')
    };

    if (normalized.startsWith('screen:')) {
      const [, displayId = ''] = normalized.split(':');
      return {
        captureTargetId: normalized,
        sourceId: normalized,
        captureKind: 'display',
        captureState: 'display',
        displayId,
        ...sharedConfig
      };
    }

    if (normalized.startsWith('window:')) {
      const parts = normalized.split(':');
      return {
        captureTargetId: normalized,
        sourceId: normalized,
        captureKind: 'window',
        captureState: 'normal',
        captureHwnd: parts[1] || '',
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
        remoteCandidateKeys: new Set(),
        restartAttempts: 0,
        restartInProgress: false,
        selectedCandidatePairLogged: false
      };
      peerConnectionMeta.set(peerId, meta);
    }
    return meta;
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
      return;
    }

    if (params.state === 'disconnected') {
      handle.connectionState = 'disconnected';
      handle.iceConnectionState = 'disconnected';
      return;
    }

    if (params.state === 'failed') {
      handle.connectionState = 'failed';
      handle.iceConnectionState = 'failed';
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
      roomId: currentRoomId
    };

    if (params.sdp) {
      payload.sdp = params.sdp;
    }
    if (params.candidate) {
      payload.candidate = params.candidate;
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

    if (params.state === 'host-session-started') {
      nativeHostSessionRunning = true;
      return;
    }

    if (params.state === 'host-session-stopped') {
      nativeHostSessionRunning = false;
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

    await ensureNativePeerConnectionReady(peerId, pc);
    dropQueuedNativePeerSignals(peerId, (entry) => entry && entry.type === 'offer');
    const attachResult = await attachNativePeerMediaSources(peerId, pc);
    if (attachResult && attachResult.peerTransport && attachResult.peerTransport.videoTrackConfigured !== true) {
      throw new Error(`native-peer-video-track-not-configured:${peerId}`);
    }
    const signal = await waitForNativeMediaOffer(peerId);
    updateNativePeerSignalState(peerId, signal);

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
      console.warn('[media-engine warning]', event.params.message);
    }
  }

  function stopNativeViewerStatsPolling() {
    if (nativeViewerStatsIntervalId) {
      clearInterval(nativeViewerStatsIntervalId);
      nativeViewerStatsIntervalId = null;
    }
  }

  function stopNativeHostStatsPolling() {
    if (nativeHostStatsIntervalId) {
      clearInterval(nativeHostStatsIntervalId);
      nativeHostStatsIntervalId = null;
    }
  }

  async function pollNativeHostStats(reason = 'periodic') {
    if (!nativeHostSessionRunning || sessionRole !== 'host') {
      return null;
    }

    try {
      const stats = await mediaEngine.getStats({});
      const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
      const peer = peers.find((entry) => entry && entry.role === 'host-downstream');
      const surfaces = Array.isArray(stats && stats.surfaces) ? stats.surfaces : [];
      const surface = surfaces.find(
        (entry) =>
          entry &&
          (entry.target === 'host-session-video' || entry.target === 'host-capture-artifact')
      );
      const hostPlan = stats && stats.hostCapturePlan ? stats.hostCapturePlan : null;

      if (shouldShowDebugLogsFor('video')) {
        console.log(
          '[media-engine native-host-stats]',
          `reason=${reason}`,
          `hostRunning=${Boolean(stats && stats.hostSessionRunning)}`,
          `captureReady=${Boolean(hostPlan && hostPlan.ready)}`,
          `captureValidated=${Boolean(hostPlan && hostPlan.validated)}`,
          `captureReason=${hostPlan && hostPlan.reason ? hostPlan.reason : 'n/a'}`,
          `surfaceRunning=${Boolean(surface && surface.running)}`,
          `surfaceFramesRendered=${surface && Number.isFinite(surface.decodedFramesRendered) ? surface.decodedFramesRendered : 0}`,
          `surfaceReason=${surface && surface.reason ? surface.reason : 'n/a'}`,
          `peer=${peer && peer.peerId ? peer.peerId : 'n/a'}`,
          `videoConfigured=${Boolean(peer && peer.peerTransport && peer.peerTransport.videoTrackConfigured)}`,
          `videoOpen=${Boolean(peer && peer.peerTransport && peer.peerTransport.videoTrackOpen)}`,
          `framesSent=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.framesSent) ? peer.mediaBinding.framesSent : 0}`,
          `bindingReason=${peer && peer.mediaBinding && peer.mediaBinding.reason ? peer.mediaBinding.reason : 'n/a'}`
        );
      }

      return stats;
    } catch (error) {
      console.warn('[media-engine native-host-stats] failed:', error);
      return null;
    }
  }

  function startNativeHostStatsPolling() {
    stopNativeHostStatsPolling();
    nativeHostStatsIntervalId = setInterval(() => {
      if (!nativeHostSessionRunning || sessionRole !== 'host') {
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
      const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
      const peer = peers.find((entry) => entry && entry.peerId === upstreamPeerId);
      if (!peer || !peer.peerTransport) {
        return stats;
      }

      const surfaces = Array.isArray(stats.surfaces) ? stats.surfaces : [];
      const surface = surfaces.find((entry) => entry && entry.target === `peer-video:${upstreamPeerId}`);

      const renderedFrames = Math.max(
        peer.peerTransport.decodedFramesRendered || 0,
        surface && surface.decodedFramesRendered ? surface.decodedFramesRendered : 0
      );
      if (shouldShowDebugLogsFor('video')) {
        console.log(
          '[media-engine native-peer-stats]',
          `reason=${reason}`,
          `peer=${peer.peerId || 'n/a'}`,
          `receiverConfigured=${Boolean(peer.peerTransport.videoReceiverConfigured)}`,
          `decoderReady=${Boolean(peer.peerTransport.decoderReady)}`,
          `framesReceived=${peer.peerTransport.remoteVideoFramesReceived || 0}`,
          `framesRendered=${peer.peerTransport.decodedFramesRendered || 0}`,
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
        );
      }

      if (renderedFrames > 0 || peer.peerTransport.mediaPlaneReady) {
        upstreamConnected = true;
        videoStarted = true;
        elements.waitingMessage.classList.add('hidden');
        elements.connectionStatus.textContent = '已连接（原生）';
        elements.connectionStatus.classList.add('connected');
        if (!viewerVolumeSynced) {
          viewerVolumeSynced = true;
          refreshViewerVolumeUi().catch((error) => {
            console.warn('[media-engine] delayed getViewerVolume failed:', error);
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

      return stats;
    } catch (error) {
      console.warn('[media-engine native-peer-stats] failed:', error);
      return null;
    }
  }

  function startNativeViewerStatsPolling() {
    stopNativeViewerStatsPolling();
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

    const parsedSource = parseCaptureSource(sourceId);
    logNativeStep('startHostSession:source', {
      sourceId,
      parsedSource
    });
    await ensureMediaEngineStarted();
    lockCodecUiToNativeH264();

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

    nativeHostSessionRunning = true;
    localStream = null;
    hostPreviewRequested = sourcePreviewEnabled ? Boolean(sourcePreviewEnabled.checked) : true;
    hideLegacyVideoElements();
    if (hostVideoContainer) {
      hostVideoContainer.classList.toggle('hidden', !hostPreviewRequested);
    }
    startNativeHostStatsPolling();

    elements.btnStartShare.classList.add('hidden');
    elements.btnStopShare.classList.remove('hidden');
    elements.hostStatus.textContent = '正在共享（原生）';
    elements.hostStatus.classList.remove('waiting');

    if (nativeHostPreviewEnabled && hostPreviewRequested) {
      try {
        await attachNativeHostPreviewSurface();
      } catch (error) {
        nativeHostSessionRunning = false;
        await mediaEngine.stopHostSession({}).catch(() => {});
        throw error;
      }
    }

    sendMessage({
      type: 'create-room',
      clientId
    });
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
        console.warn('[media-engine] native audio session start failed:', error);
        showError('原生音频启动失败，将仅共享画面');
      }
    }
  }

  async function stopScreenShare() {
    stopNativeHostStatsPolling();
    stopNativeViewerStatsPolling();
    await detachNativeHostPreviewSurface().catch(() => {});
    hostPreviewRequested = true;
    if (hostVideoContainer) {
      hostVideoContainer.classList.remove('hidden');
    }

    const peerIds = Array.from(nativePeerHandles.keys());
    for (const peerId of peerIds) {
      await closeNativePeerConnectionImpl(peerId, { clearRetryState: true });
    }

    if (typeof mediaEngine.stopAudioSession === 'function') {
      await mediaEngine.stopAudioSession({}).catch(() => {});
    }
    if (typeof mediaEngine.stopHostSession === 'function') {
      await mediaEngine.stopHostSession({}).catch(() => {});
    }

    nativeHostSessionRunning = false;

    if (currentRoomId && sessionRole === 'host') {
      sendMessage({
        type: 'leave-room',
        roomId: currentRoomId,
        clientId
      }, { queueIfDisconnected: false });
    }

    sessionRole = null;
    currentRoomId = null;
    hostId = null;
    upstreamPeerId = null;
    relayStream = null;
    upstreamConnected = false;
    viewerReadySent = false;
    videoStarted = false;

    elements.roomInfo.classList.add('hidden');
    elements.viewerCount.textContent = '0';
    elements.btnStartShare.classList.remove('hidden');
    elements.btnStopShare.classList.add('hidden');
    elements.hostStatus.textContent = '准备就绪';
    hideLegacyVideoElements();
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
      console.warn('[media-engine relay] exhausted connect-to-next retries:', nextViewerId, error);
      return;
    }

    const retryDelayMs = nextAttempt * 750;
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
        currentRoomId = data.roomId;
        sessionRole = 'host';
        elements.roomIdDisplay.textContent = data.roomId;
        elements.roomInfo.classList.remove('hidden');
        elements.btnStartShare.classList.add('hidden');
        elements.btnStopShare.classList.remove('hidden');
        elements.hostStatus.textContent = '原生分享已就绪';
        return;

      case 'room-joined':
        clearAllRelayOfferRetries();
        await clearAllPeerConnections({ clearRetryState: true });
        currentRoomId = data.roomId;
        sessionRole = 'viewer';
        myChainPosition = data.chainPosition;
        hostId = data.hostId;
        upstreamPeerId = data.upstreamPeerId || data.hostId;
        viewerReadySent = false;
        videoStarted = false;
        upstreamConnected = false;
        elements.joinForm.classList.add('hidden');
        elements.viewerStatus.classList.remove('hidden');
        elements.viewerRoomId.textContent = data.roomId;
        elements.btnLeave.classList.remove('hidden');
        elements.chainPosition.textContent = String(data.chainPosition + 1);
        setViewerConnectionState('等待原生上游连接...');
        return;

      case 'session-resumed':
        currentRoomId = data.roomId;
        sessionRole = data.role;
        if (data.role === 'host') {
          isHost = true;
          elements.roomIdDisplay.textContent = data.roomId;
          elements.roomInfo.classList.remove('hidden');
          elements.viewerCount.textContent = String(data.viewerCount || 0);
          elements.btnStartShare.classList.add('hidden');
          elements.btnStopShare.classList.remove('hidden');
          elements.hostStatus.textContent = '原生分享已恢复';
          return;
        }

        isHost = false;
        clearAllRelayOfferRetries();
        await clearAllPeerConnections({ clearRetryState: true });
        hostId = data.hostId || hostId;
        upstreamPeerId = data.upstreamPeerId || hostId;
        myChainPosition = data.chainPosition;
        elements.joinForm.classList.add('hidden');
        elements.viewerStatus.classList.remove('hidden');
        elements.viewerRoomId.textContent = data.roomId;
        elements.btnLeave.classList.remove('hidden');
        elements.chainPosition.textContent = String(myChainPosition + 1);
        if (!upstreamConnected) {
          setViewerConnectionState('正在恢复原生上游连接...');
        } else if (elements.connectionStatus) {
          elements.connectionStatus.textContent = '已连接（原生）';
          elements.connectionStatus.classList.add('connected');
        }
        return;

      case 'error':
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
          console.warn('[media-engine relay] connect-to-next failed:', data.nextViewerId, error);
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
        await resetViewerMediaPipeline('正在重建原生上游连接...');
        elements.chainPosition.textContent = String(myChainPosition + 1);
        return;

      default:
        return;
    }
  }

  function updateFullscreenUi(isFullscreen) {
    document.body.classList.toggle('native-embedded-fullscreen', Boolean(isFullscreen));
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
      viewerVolumeInput.value = String(volume);
      viewerVolumeValue.textContent = `${volume}%`;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message.includes('No active render audio session was found')) {
        viewerVolumeInput.value = '100';
        viewerVolumeValue.textContent = '100%';
        return;
      }
      console.warn('[media-engine] getViewerVolume failed:', error);
    }
  }

  async function handleViewerVolumeInput(event) {
    const nextValue = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    viewerVolumeValue.textContent = `${nextValue}%`;
    await mediaEngine.setViewerVolume(nextValue / 100);
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
      viewerVolumeInput.value = '100';
      viewerVolumeValue.textContent = '100%';
    }

    if (elements.btnStopShare) {
      elements.btnStopShare.addEventListener('click', (event) => {
        if (!nativeHostSessionRunning) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        stopScreenShare().catch((error) => {
          console.error('[media-engine] stopScreenShare failed:', error);
          showError(`原生停止失败：${error && error.message ? error.message : String(error)}`);
        });
      }, true);
    }

    if (typeof electronApi.onFullscreenChange === 'function') {
      electronApi.onFullscreenChange(updateFullscreenUi);
    }

    window.addEventListener('keydown', (event) => {
      handleFullscreenEscapeKey(event).catch((error) => {
        console.warn('[media-engine] fullscreen escape failed:', error);
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

  initializeNativeUi().catch((error) => {
    console.error('[media-engine] native override init failed:', error);
    showError(`Native init failed: ${error && error.message ? error.message : String(error)}`);
  });
})();
