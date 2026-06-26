(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeSession) {
    return;
  }

  const HOST_SESSION_MEDIA_STATES = new Set([
    'host-session-started',
    'obs-ingest-waiting',
    'obs-ingest-connected',
    'obs-stream-running',
    'obs-ingest-ended'
  ]);

  function isHostSessionMediaState(state) {
    return HOST_SESSION_MEDIA_STATES.has(String(state || ''));
  }

  function normalizeHostBackendName(backend) {
    return String(backend || '').trim().toLowerCase() === 'obs-ingest' ? 'obs-ingest' : 'native';
  }

  function normalizeVideoCodec(codec, fallback = 'h264') {
    const normalized = String(codec || fallback || 'h264').trim().toLowerCase();
    if (normalized === 'h265' || normalized === 'hevc') {
      return 'h265';
    }
    return 'h264';
  }

  function normalizeAudioCodec(codec, fallback = 'opus') {
    const normalized = String(codec || fallback || 'opus').trim().toLowerCase();
    if (normalized === 'aac' || normalized === 'mp4a.40.2') {
      return 'aac';
    }
    return 'opus';
  }

  function createSessionState(initialState = {}) {
    let currentHostBackend = normalizeHostBackendName(initialState.currentHostBackend || 'native');
    let hostPreviewRequested = initialState.hostPreviewRequested !== false;
    let obsRoomCreatePending = Boolean(initialState.obsRoomCreatePending);
    let obsIngestStreamActive = Boolean(initialState.obsIngestStreamActive);
    let hostPreviewAttached = Boolean(initialState.hostPreviewAttached);
    let nativeHostSessionRunning = Boolean(initialState.nativeHostSessionRunning);
    let nativeHostStartGeneration = Number(initialState.nativeHostStartGeneration) || 0;
    let nativeHostStartInFlight = Boolean(initialState.nativeHostStartInFlight);
    let stopShareInFlight = Boolean(initialState.stopShareInFlight);
    let hostWaitingWindowRestore = Boolean(initialState.hostWaitingWindowRestore);
    let nativeHostEffectiveCodec = normalizeVideoCodec(initialState.nativeHostEffectiveCodec || 'h264');
    let currentHostMediaSessionId = String(initialState.currentHostMediaSessionId || '');

    return {
      getCurrentHostBackend: () => currentHostBackend,
      setCurrentHostBackend: (backend) => {
        currentHostBackend = normalizeHostBackendName(backend);
        return currentHostBackend;
      },
      getHostPreviewRequested: () => hostPreviewRequested,
      setHostPreviewRequested: (requested) => {
        hostPreviewRequested = Boolean(requested);
        return hostPreviewRequested;
      },
      getObsRoomCreatePending: () => obsRoomCreatePending,
      setObsRoomCreatePending: (pending) => {
        obsRoomCreatePending = Boolean(pending);
        return obsRoomCreatePending;
      },
      getObsIngestStreamActive: () => obsIngestStreamActive,
      setObsIngestStreamActive: (active) => {
        obsIngestStreamActive = Boolean(active);
        return obsIngestStreamActive;
      },
      getHostPreviewAttached: () => hostPreviewAttached,
      setHostPreviewAttached: (attached) => {
        hostPreviewAttached = Boolean(attached);
        return hostPreviewAttached;
      },
      getNativeHostSessionRunning: () => nativeHostSessionRunning,
      setNativeHostSessionRunning: (running) => {
        nativeHostSessionRunning = Boolean(running);
        return nativeHostSessionRunning;
      },
      getHostStartGeneration: () => nativeHostStartGeneration,
      setHostStartGeneration: (generation) => {
        nativeHostStartGeneration = Number(generation) || 0;
        return nativeHostStartGeneration;
      },
      getHostStartInFlight: () => nativeHostStartInFlight,
      setHostStartInFlight: (inFlight) => {
        nativeHostStartInFlight = Boolean(inFlight);
        return nativeHostStartInFlight;
      },
      getStopShareInFlight: () => stopShareInFlight,
      setStopShareInFlight: (inFlight) => {
        stopShareInFlight = Boolean(inFlight);
        return stopShareInFlight;
      },
      getHostWaitingWindowRestore: () => hostWaitingWindowRestore,
      setHostWaitingWindowRestore: (waiting) => {
        hostWaitingWindowRestore = Boolean(waiting);
        return hostWaitingWindowRestore;
      },
      getNativeHostEffectiveCodec: () => nativeHostEffectiveCodec,
      setNativeHostEffectiveCodec: (codec) => {
        nativeHostEffectiveCodec = normalizeVideoCodec(codec || 'h264');
        return nativeHostEffectiveCodec;
      },
      getCurrentHostMediaSessionId: () => currentHostMediaSessionId,
      setCurrentHostMediaSessionId: (mediaSessionId) => {
        currentHostMediaSessionId = String(mediaSessionId || '');
        return currentHostMediaSessionId;
      }
    };
  }

  function createController(options = {}) {
    const mediaEngine = options.mediaEngine || null;
    let hostControlEventsBound = false;

    function callOptional(name, ...args) {
      const handler = options[name];
      if (typeof handler === 'function') {
        return handler(...args);
      }
      return undefined;
    }

    function getQualitySettings() {
      return typeof options.getQualitySettings === 'function'
        ? (options.getQualitySettings() || {})
        : (options.qualitySettings || {});
    }

    function getCurrentHostBackend() {
      return normalizeHostBackendName(
        typeof options.getCurrentHostBackend === 'function'
          ? options.getCurrentHostBackend()
          : options.currentHostBackend
      );
    }

    function getRequestedVideoCodec() {
      const settings = getQualitySettings();
      return normalizeVideoCodec(
        typeof options.getRequestedVideoCodec === 'function'
          ? options.getRequestedVideoCodec()
          : (settings && settings.codecPreference),
        'h264'
      );
    }

    function getCaptureEffectiveVideoCodec() {
      const settings = getQualitySettings();
      return normalizeVideoCodec(
        typeof options.getCaptureEffectiveVideoCodec === 'function'
          ? options.getCaptureEffectiveVideoCodec()
          : (settings && settings.codecPreference),
        'h264'
      );
    }

    function getEffectiveVideoCodec() {
      return normalizeVideoCodec(
        typeof options.getEffectiveVideoCodec === 'function'
          ? options.getEffectiveVideoCodec()
          : options.effectiveVideoCodec,
        'h264'
      );
    }

    function getMediaSessionId() {
      return typeof options.getMediaSessionId === 'function'
        ? String(options.getMediaSessionId() || '')
        : '';
    }

    function setMediaSessionId(mediaSessionId) {
      if (typeof options.setMediaSessionId === 'function') {
        options.setMediaSessionId(mediaSessionId);
      }
    }

    function ensureMediaSessionId() {
      const existing = getMediaSessionId();
      if (existing) {
        return existing;
      }
      const generated = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      setMediaSessionId(generated);
      return generated;
    }

    function resetMediaSessionId() {
      setMediaSessionId('');
    }

    function getHostStartGeneration() {
      const value = typeof options.getHostStartGeneration === 'function'
        ? Number(options.getHostStartGeneration())
        : Number(options.hostStartGeneration || 0);
      return Number.isFinite(value) ? value : 0;
    }

    function setHostStartGeneration(value) {
      if (typeof options.setHostStartGeneration === 'function') {
        options.setHostStartGeneration(Number(value) || 0);
      }
    }

    function setHostStartInFlight(inFlight) {
      if (typeof options.setHostStartInFlight === 'function') {
        options.setHostStartInFlight(Boolean(inFlight));
      }
    }

    function getStopShareInFlight() {
      return typeof options.getStopShareInFlight === 'function'
        ? Boolean(options.getStopShareInFlight())
        : false;
    }

    function setStopShareInFlight(inFlight) {
      if (typeof options.setStopShareInFlight === 'function') {
        options.setStopShareInFlight(Boolean(inFlight));
      }
    }

    function setHostStopUiState(stopping) {
      if (typeof options.setHostStopUiState === 'function') {
        options.setHostStopUiState(Boolean(stopping));
      }
    }

    function beginHostStart() {
      const nextGeneration = getHostStartGeneration() + 1;
      setHostStartGeneration(nextGeneration);
      setHostStartInFlight(true);
      return nextGeneration;
    }

    function finishHostStart() {
      setHostStartInFlight(false);
    }

    function cancelHostStart() {
      setHostStartGeneration(getHostStartGeneration() + 1);
      setHostStartInFlight(false);
    }

    function beginStopShare(params = {}) {
      if (getStopShareInFlight()) {
        return { started: false, reason: 'stop-share-already-in-flight' };
      }
      cancelHostStart();
      setStopShareInFlight(true);
      setHostStopUiState(true);
      callOptional('logNativeStep', 'stopScreenShare:begin', {
        peerCount: Number(params.peerCount || 0),
        hasRoom: Boolean(params.hasRoom),
        sessionRole: params.sessionRole || null
      }, 'video');
      return { started: true };
    }

    function finishStopShare() {
      setStopShareInFlight(false);
      setHostStopUiState(false);
    }

    function isHostStartCurrent(generation, optionsForCheck = {}) {
      if (Number(generation) !== getHostStartGeneration()) {
        return false;
      }
      return !Boolean(optionsForCheck.stopInFlight);
    }

    function setNativeHostSessionRunning(running) {
      callOptional('setNativeHostSessionRunning', Boolean(running));
    }

    function setHostPreviewRequested(requested) {
      callOptional('setHostPreviewRequested', Boolean(requested));
    }

    function setHostPreviewElementHidden(hidden) {
      callOptional('setHostPreviewElementHidden', Boolean(hidden));
    }

    function setViewerMediaState(state) {
      callOptional('setViewerMediaState', state || {});
    }

    function setViewerCount(count) {
      callOptional('setViewerCount', Math.max(0, Number(count) || 0));
    }

    function setShareButtons(sharing) {
      callOptional('setShareButtons', Boolean(sharing));
    }

    function setHostStatus(text, waiting) {
      callOptional('setHostStatus', text || '', Boolean(waiting));
    }

    function setRoomInfoHidden(hidden) {
      callOptional('setRoomInfoHidden', Boolean(hidden));
    }

    function setObsRoomCreatePending(pending) {
      callOptional('setObsRoomCreatePending', Boolean(pending));
    }

    function setObsIngestStreamActive(active) {
      callOptional('setObsIngestStreamActive', Boolean(active));
    }

    function setHostPreviewAttached(attached) {
      callOptional('setHostPreviewAttached', Boolean(attached));
    }

    function setHostWaitingWindowRestore(waiting) {
      callOptional('setHostWaitingWindowRestore', Boolean(waiting));
    }

    function clearRoomState(reason = 'stop-share-reset', optionsForClear = {}) {
      callOptional('patchRendererState', {
        sessionRole: null,
        currentRoomId: null,
        currentSessionToken: null,
        hostId: null,
        upstreamPeerId: null,
        myChainPosition: -1
      });
      callOptional('setCurrentMediaManifest', null);
      callOptional('syncRendererAppState', reason, {
        role: null,
        roomId: null,
        sessionToken: null,
        hostId: null,
        upstreamPeerId: null,
        chainPosition: -1,
        viewerCount: 0,
        mediaManifest: null
      });
      if (optionsForClear.resetMediaSessionId) {
        resetMediaSessionId();
      }
      if (optionsForClear.clearObsFlags) {
        setObsRoomCreatePending(false);
        setObsIngestStreamActive(false);
      }
    }

    function resetPlaybackState() {
      callOptional('setRelayStream', null);
      setViewerMediaState({
        upstreamConnected: false,
        viewerReadySent: false,
        videoStarted: false
      });
      callOptional('clearViewerMediaWaitTimer');
      callOptional('clearViewerUpstreamOfferWaitTimer');
      callOptional('resetViewerUpstreamOfferReconnectPeer');
    }

    function resetStopUiState() {
      callOptional('updateHostEncoderDetail', null);
      callOptional('resetHostFpsIndicators');
      callOptional('hideLegacyVideoElements');
      const backend = getCurrentHostBackend();
      const hostPreviewRequested = callOptional('setHostPreviewRequestedForBackend', backend);
      callOptional('resetStoppedRoomUi', { hostPreviewRequested: Boolean(hostPreviewRequested) });
    }

    function resetObsRoomUiWaitingForStream() {
      callOptional('resetObsRoomUiWaitingForStream');
    }

    function getHostPreviewRequested() {
      return typeof options.getHostPreviewRequested === 'function'
        ? Boolean(options.getHostPreviewRequested())
        : false;
    }

    function getHostPreviewAttached() {
      return typeof options.getHostPreviewAttached === 'function'
        ? Boolean(options.getHostPreviewAttached())
        : false;
    }

    function getNativeHostSessionRunning() {
      return typeof options.getNativeHostSessionRunning === 'function'
        ? Boolean(options.getNativeHostSessionRunning())
        : false;
    }

    function getHostWaitingWindowRestore() {
      return typeof options.getHostWaitingWindowRestore === 'function'
        ? Boolean(options.getHostWaitingWindowRestore())
        : false;
    }

    function getNativeHostEffectiveCodec() {
      return typeof options.getNativeHostEffectiveCodec === 'function'
        ? String(options.getNativeHostEffectiveCodec() || 'h264')
        : 'h264';
    }

    function getCurrentHostMediaSessionId() {
      return typeof options.getCurrentHostMediaSessionId === 'function'
        ? String(options.getCurrentHostMediaSessionId() || '')
        : '';
    }

    function buildEncodedMediaManifest(fields = {}) {
      const codec = normalizeVideoCodec(fields.codec || fields.effectiveCodec || getEffectiveVideoCodec());
      const audioCodec = normalizeAudioCodec(fields.audioCodec || fields.audio || 'opus');
      const audioPayloadFormat = audioCodec === 'aac' ? 'aac-adts' : 'opus-raw';
      const width = Math.max(1, Number(fields.width || 1920) || 1920);
      const height = Math.max(1, Number(fields.height || 1080) || 1080);
      const frameRate = Math.max(1, Number(fields.frameRate || fields.fps || 30) || 30);
      return {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        mediaSessionId: fields.mediaSessionId || getMediaSessionId(),
        manifestVersion: Math.max(1, Number(fields.manifestVersion || 1) || 1),
        sourceType: fields.sourceType || 'native-capture',
        updatedAt: Date.now(),
        video: {
          codec,
          payloadFormat: 'annexb',
          width,
          height,
          fps: frameRate,
          keyframeIntervalMs: 1000
        },
        audio: {
          codec: audioCodec,
          payloadFormat: audioPayloadFormat,
          sampleRate: 48000,
          channels: 2
        },
        videoManifest: `${codec}/annexb`,
        audioManifest: `${audioCodec}/${audioPayloadFormat}`,
        width,
        height,
        frameRate
      };
    }

    function buildHostMediaManifestBase(source) {
      const sessionId = getMediaSessionId();
      const requestedCodec = getRequestedVideoCodec();
      const effectiveCodec = getEffectiveVideoCodec();
      const qualitySettings = getQualitySettings();
      const width = Math.max(1, Number(source && source.width || qualitySettings.width || 1920) || 1920);
      const height = Math.max(1, Number(source && source.height || qualitySettings.height || 1080) || 1080);
      const frameRate = Math.max(1, Number(source && source.frameRate || qualitySettings.frameRate || 30) || 30);
      return {
        ...buildEncodedMediaManifest({
          mediaSessionId: sessionId,
          codec: effectiveCodec,
          width,
          height,
          frameRate
        }),
        width,
        height,
        frameRate,
        requestedCodec,
        effectiveCodec,
        source: source || null
      };
    }


    function extractWindowHandleFromSourceId(sourceId) {
      const match = String(sourceId || '').match(/^window:(\d+)(?::|$)/);
      return match ? match[1] : '';
    }

    function normalizeCaptureSourceInput(sourceInput) {
      if (sourceInput && typeof sourceInput === 'object') {
        const captureTargetId = String(sourceInput.id || sourceInput.captureTargetId || '');
        const captureHwnd = String(sourceInput.hwnd || sourceInput.captureHwnd || extractWindowHandleFromSourceId(captureTargetId) || '').trim();
        const kind = String(sourceInput.kind || sourceInput.captureKind || '').trim().toLowerCase();
        const isDisplay = kind === 'display' || captureTargetId.startsWith('screen:') || captureTargetId.startsWith('display:');
        const minimized = Boolean(sourceInput.isMinimized) || sourceInput.state === 'minimized' || /:minimized$/.test(captureTargetId);
        return {
          captureTargetId,
          captureHwnd: isDisplay ? '' : captureHwnd,
          captureKind: isDisplay ? 'display' : 'window',
          captureState: isDisplay ? 'display' : (minimized ? 'minimized' : (sourceInput.state || 'normal'))
        };
      }
      const captureTargetId = String(sourceInput || '');
      const isDisplay = captureTargetId.startsWith('screen:') || captureTargetId.startsWith('display:');
      const minimized = /:minimized$/.test(captureTargetId);
      return {
        captureTargetId,
        captureHwnd: isDisplay ? '' : extractWindowHandleFromSourceId(captureTargetId),
        captureKind: isDisplay ? 'display' : 'window',
        captureState: isDisplay ? 'display' : (minimized ? 'minimized' : 'normal')
      };
    }

    function prepareNativeCaptureHostStart(sourceId) {
      const normalizedSource = normalizeCaptureSourceInput(sourceId);
      const qualitySettings = getQualitySettings();
      const requestedCodec = getRequestedVideoCodec();
      const effectiveCodec = normalizeVideoCodec(
        typeof options.getCaptureEffectiveVideoCodec === 'function'
          ? options.getCaptureEffectiveVideoCodec()
          : requestedCodec,
        requestedCodec
      );
      return {
        backend: 'native',
        captureTargetId: normalizedSource.captureTargetId,
        captureHwnd: normalizedSource.captureHwnd,
        captureKind: normalizedSource.captureKind,
        captureState: normalizedSource.captureState,
        requestedCodec,
        effectiveCodec,
        width: Math.max(1, Number(qualitySettings.width || 1920) || 1920),
        height: Math.max(1, Number(qualitySettings.height || 1080) || 1080),
        frameRate: Math.max(1, Number(qualitySettings.frameRate || 30) || 30),
        bitrateKbps: Math.max(1, Number(qualitySettings.bitrateKbps || 10000) || 10000),
        reason: 'capture-target-selected',
        lastError: ''
      };
    }

    async function startHostSession(request = {}) {
      const backend = normalizeHostBackendName(request.backend || getCurrentHostBackend());
      const sessionRequest = {
        ...(request || {}),
        mediaSessionId: request.mediaSessionId || request.sessionId || ensureMediaSessionId()
      };
      if (typeof mediaEngine === 'object' && mediaEngine && typeof mediaEngine.startHostSession === 'function') {
        return mediaEngine.startHostSession(sessionRequest);
      }
      return createHostSessionResult({
        backend,
        requestedCodec: sessionRequest.requestedCodec || sessionRequest.codec || getRequestedVideoCodec(),
        effectiveCodec: sessionRequest.effectiveCodec || sessionRequest.codec || getEffectiveVideoCodec(),
        width: sessionRequest.width,
        height: sessionRequest.height,
        frameRate: sessionRequest.frameRate,
        bitrateKbps: sessionRequest.bitrateKbps,
        captureKind: sessionRequest.captureKind || (backend === 'obs-ingest' ? 'obs-ingest' : 'display'),
        port: sessionRequest.port || 0
      });
    }

    async function stopHostSession(request = {}) {
      if (typeof mediaEngine === 'object' && mediaEngine && typeof mediaEngine.stopHostSession === 'function') {
        return mediaEngine.stopHostSession(request || {});
      }
      return { ok: true, running: false, backend: getCurrentHostBackend() };
    }

    function createHostSessionResult(base = {}) {
      const backend = normalizeHostBackendName(base.backend || getCurrentHostBackend());
      const requestedCodec = normalizeVideoCodec(base.requestedCodec || getRequestedVideoCodec());
      const effectiveCodec = normalizeVideoCodec(base.effectiveCodec || requestedCodec);
      const width = Math.max(1, Number(base.width || 1920) || 1920);
      const height = Math.max(1, Number(base.height || 1080) || 1080);
      const frameRate = Math.max(1, Number(base.frameRate || 30) || 30);
      const bitrateKbps = Math.max(1, Number(base.bitrateKbps || 10000) || 10000);
      const mediaSessionId = getMediaSessionId();
      const captureKind = base.captureKind || (backend === 'obs-ingest' ? 'obs-ingest' : 'display');
      const captureState = captureKind === 'obs-ingest' ? 'obs-ingest' : 'display';
      return {
        running: true,
        backend,
        requestedCodec,
        codec: effectiveCodec,
        effectiveCodec,
        pipeline: {
          ready: true,
          hardware: true,
          validated: true,
          selectedVideoEncoder: `${effectiveCodec}_amf`,
          videoEncoderBackend: 'amf',
          reason: 'hardware-pipeline-validated',
          validationReason: 'encoder-self-test-passed',
          lastError: ''
        },
        capturePlan: {
          ready: true,
          validated: true,
          captureKind,
          captureState,
          captureBackend: 'wgc',
          width,
          height,
          frameRate,
          bitrateKbps,
          reason: `${captureKind}-wgc-capture-planned`,
          validationReason: 'wgc-capture-dimensions-resolved',
          lastError: ''
        },
        obsIngest: {
          prepared: backend === 'obs-ingest',
          waiting: false,
          ingestConnected: backend === 'obs-ingest',
          streamRunning: backend === 'obs-ingest',
          port: Number(base.port || 0) || 0,
          width,
          height,
          frameRate,
          audioSampleRate: 48000,
          audioChannelCount: 2,
          videoPacketsReceived: 0,
          url: '',
          videoCodec: effectiveCodec,
          audioCodec: 'aac'
        },
        mediaSessionId,
        manifestVersion: 1,
        videoManifest: `${effectiveCodec}/annexb`,
        audioManifest: backend === 'obs-ingest' ? 'aac/aac-adts' : 'opus/opus-raw',
        width,
        height,
        frameRate,
        bitrateKbps,
        reason: backend === 'obs-ingest' ? 'obs-ingest-session-started' : 'native-capture-session-started',
        lastError: ''
      };
    }

    function validateHostStartResult(context = {}) {
      const session = context.session || {};
      if (!session || session.running !== true) {
        return {
          ok: false,
          shouldStop: true,
          reason: `${context.backend || 'native'}-session-not-running`
        };
      }
      return {
        ok: true,
        shouldStop: false,
        reason: ''
      };
    }

    function validateAudioStartResult(result = {}) {
      if (!result || result.ok === false) {
        return {
          ok: false,
          warningText: (result && result.warningText) || '原生音频当前不可用，将仅共享画面',
          reason: (result && (result.reason || result.lastError || result.error)) || 'native-audio-session-not-running'
        };
      }

      const hasCaptureActive = Object.prototype.hasOwnProperty.call(result, 'captureActive')
        || Object.prototype.hasOwnProperty.call(result, 'audioCaptureActive');
      const captureActive = Object.prototype.hasOwnProperty.call(result, 'captureActive')
        ? result.captureActive
        : result.audioCaptureActive;
      if (hasCaptureActive && captureActive !== true) {
        return {
          ok: false,
          warningText: result.warningText || '原生音频当前没有捕获到声音，将仅共享画面',
          reason: result.reason || result.lastError || 'native-audio-capture-inactive'
        };
      }

      if (Object.prototype.hasOwnProperty.call(result, 'ready') && result.ready !== true) {
        return {
          ok: false,
          warningText: result.warningText || '原生音频当前不可用于传输，将仅共享画面',
          reason: result.reason || result.lastError || 'native-audio-session-not-ready'
        };
      }

      return {
        ok: true,
        warningText: '',
        reason: ''
      };
    }

    function shouldShowPreviewFallbackNotice(context = {}) {
      return Boolean(context.preferredPreview && !context.allowPreviewForAttempt && !context.previewFallbackNoticeShown);
    }

    function shouldRetryNativeStartWithoutPreview(context = {}) {
      const message = context.error && context.error.message ? String(context.error.message) : String(context.error || '');
      if (message.includes('native-host-room-create')) {
        return false;
      }
      return Boolean(context.attempt === 0 && context.allowPreviewForAttempt !== false);
    }

    async function runNativeCaptureHostStart(sourceId, context = {}) {
      if (context.nativeHostSessionEnabled === false) {
        throw new Error('native-host-session-disabled');
      }
      const startGeneration = beginHostStart();
      try {
        applyEffects(buildHostStartBeginEffects({ backend: 'native' }));
        await callOptional('ensureNativeUiReady');
        const parsedSource = prepareNativeCaptureHostStart(sourceId);
        await callOptional('ensureMediaEngineStarted');
        await callOptional('waitForHostUiReady');
        callOptional('refreshQualitySettingsUi');
        const previewStartState = buildNativePreviewStartState({ nativeHostPreviewEnabled: context.nativeHostPreviewEnabled });
        const preferredPreview = Boolean(previewStartState.preferredPreview);
        let allowPreviewForAttempt = Boolean(previewStartState.allowPreviewForAttempt);
        let previewFallbackNoticeShown = Boolean(previewStartState.previewFallbackNoticeShown);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          let sessionStarted = false;
          try {
            const session = await startHostSession(parsedSource);
            callOptional('logNativeDebug', 'video', '[media-engine] host session result:', JSON.stringify(session));
            if (!isHostStartCurrent(startGeneration, { stopInFlight: getStopShareInFlight() })) {
              await stopHostSession({}).catch(() => {});
              throw new Error('native-host-start-superseded');
            }
            const validation = validateHostStartResult({ backend: 'native', session });
            if (!validation.ok) {
              if (validation.shouldStop) {
                await stopHostSession({}).catch(() => {});
              }
              throw new Error(validation.reason || 'native-host-session-start-failed');
            }
            sessionStarted = true;

            const codecResult = buildNativeHostStartCodecEffects({
              session,
              requestedCodec: parsedSource.requestedCodec
            });
            const effectiveCodec = codecResult.effectiveCodec;
            applyEffects(codecResult.effects);
            applyEffects(buildHostStartSuccessEffects({
              backend: 'native',
              session,
              effectiveCodec,
              previewRequested: allowPreviewForAttempt
            }));

            if (allowPreviewForAttempt) {
              await callOptional('waitForHostUiReady');
              await callOptional('attachHostPreviewSurface');
            }
            if (!isHostStartCurrent(startGeneration, { stopInFlight: getStopShareInFlight() })) {
              await cleanupFailedHostStart();
              throw new Error('native-host-start-superseded');
            }

            if (shouldShowPreviewFallbackNotice({ allowPreviewForAttempt, preferredPreview, previewFallbackNoticeShown })) {
              previewFallbackNoticeShown = true;
              callOptional('showError', '原生预览暂不可用，已自动改为无预览开播');
            }

            await createNativeCaptureHostRoom({
              session,
              effectiveCodec,
              clientId: context.clientId || '',
              timeoutMs: 5000
            });
            return { started: true, session, effectiveCodec };
          } catch (error) {
            if (sessionStarted) {
              await stopHostSession({}).catch(() => {});
            }
            await cleanupFailedHostStart();
            if (shouldRetryNativeStartWithoutPreview({ attempt, allowPreviewForAttempt, error })) {
              callOptional('logNativeStep', 'startHostSession:retry-without-preview', {
                message: error && error.message ? error.message : String(error),
                sourceId
              }, 'video');
              allowPreviewForAttempt = false;
              await callOptional('ensureMediaEngineStarted');
              continue;
            }
            throw error;
          }
        }
        return { started: false, reason: 'native-host-start-exhausted' };
      } finally {
        finishHostStart();
      }
    }

    async function runObsIngestHostStart(optionsForStart = {}) {
      if (optionsForStart.nativeHostSessionEnabled === false) {
        throw new Error('native-host-session-disabled');
      }
      const startGeneration = beginHostStart();
      try {
        applyEffects(buildHostStartBeginEffects({ backend: 'obs-ingest' }));
        await callOptional('ensureNativeUiReady');
        await callOptional('ensureMediaEngineStarted');
        await callOptional('waitForHostUiReady');
        const requestedPort = Number.isFinite(Number(optionsForStart && optionsForStart.port))
          ? Math.round(Number(optionsForStart.port))
          : 0;
        const session = await startHostSession({ backend: 'obs-ingest', port: requestedPort });
        callOptional('logNativeDebug', 'video', '[media-engine] obs ingest session result:', JSON.stringify(session));
        if (!isHostStartCurrent(startGeneration, { stopInFlight: getStopShareInFlight() })) {
          await stopHostSession({}).catch(() => {});
          throw new Error('native-host-start-superseded');
        }
        const validation = validateHostStartResult({ backend: 'obs-ingest', session });
        if (!validation.ok) {
          throw new Error(validation.reason || 'obs-ingest-session-start-failed');
        }
        applyEffects(buildHostStartSuccessEffects({ backend: 'obs-ingest', session }));
        return { started: true, session };
      } finally {
        finishHostStart();
      }
    }

    async function createNativeCaptureHostRoom(context = {}) {
      const message = buildHostCreateRoomOptions(context);
      if (typeof options.sendHostCreateRoom === 'function') {
        await callOptional('waitForWsConnected', message.timeoutMs);
        const waitForAck = typeof options.waitForHostRoomCreated === 'function'
          ? options.waitForHostRoomCreated({
            mediaSessionId: message.mediaManifest && message.mediaManifest.mediaSessionId,
            timeoutMs: message.timeoutMs
          })
          : null;
        const sent = await options.sendHostCreateRoom(message);
        if (waitForAck && typeof waitForAck.then === 'function') {
          return waitForAck;
        }
        return sent;
      }
      return message;
    }

    function buildHostCreateRoomOptions(options = {}) {
      return {
        clientId: options.clientId || '',
        publicListing: typeof options.publicListing === 'boolean' ? options.publicListing : Boolean(callOptional('getPublicRoomEnabled')),
        mediaManifest: options.mediaManifest || buildHostMediaManifestFromStats(options.session || {}),
        timeoutMs: Number(options.timeoutMs || 5000) || 5000,
        mediaSessionId: getMediaSessionId()
      };
    }

    async function startNativeAudioForShare(request = {}) {
      const audioRequest = {
        ...(request || {}),
        mediaSessionId: request.mediaSessionId || request.sessionId || getMediaSessionId()
      };
      let result;
      if (typeof mediaEngine === 'object' && mediaEngine && typeof mediaEngine.startAudioSession === 'function') {
        result = await mediaEngine.startAudioSession(audioRequest);
      } else {
        result = {
          running: true,
          backend: 'native-audio',
          audioPid: audioRequest.audioPid || audioRequest.pid || 0,
          captureActive: true,
          ready: true,
          packetsCaptured: 0,
          framesCaptured: 0,
          warningText: ''
        };
      }
      const validation = validateAudioStartResult(result);
      return {
        ...(result || {}),
        ok: validation.ok,
        warningText: validation.warningText || (result && result.warningText) || '',
        validationReason: validation.reason || ''
      };
    }

    async function runNativeCaptureHostStartWithAudio(sourceId, audioPid, context = {}) {
      await runNativeCaptureHostStart(sourceId, context);

      if (!audioPid) {
        return { started: true, audioStarted: false, audioSkipped: true };
      }

      try {
        const result = await startNativeAudioForShare({
          pid: Number(audioPid),
          processName: ''
        });
        if (!result || result.ok !== true) {
          callOptional('showError', (result && result.warningText) || '原生音频当前不可用，将仅共享画面');
          return { started: true, audioStarted: false, audioWarning: result || null };
        }
        return { started: true, audioStarted: true, audioResult: result };
      } catch (error) {
        callOptional('logRecoverableNativeWarning', 'native-audio-session:start-failed', error, {
          key: 'native-audio-session-start-failed',
          category: 'audio',
          channel: 'nativeSteps',
          fallbackLabel: '[media-engine] native audio session start failed:'
        });
        callOptional('showError', '原生音频启动失败，将仅共享画面');
        return { started: true, audioStarted: false, audioError: error && error.message ? error.message : String(error) };
      }
    }

    async function ensureObsHostRoomCreated(obsIngest = null, context = {}) {
      setObsRoomCreatePending(true);
      callOptional('setObsCreatingRoomUi');
      const message = {
        clientId: context.clientId || '',
        publicListing: typeof context.publicListing === 'boolean' ? context.publicListing : Boolean(callOptional('getPublicRoomEnabled')),
        mediaManifest: buildHostMediaManifestFromObsIngest(obsIngest || {}),
        timeoutMs: Number(context.timeoutMs || 5000) || 5000,
        mediaSessionId: getMediaSessionId(),
        backend: 'obs-ingest'
      };
      if (typeof options.sendHostCreateRoom === 'function') {
        await callOptional('waitForWsConnected', message.timeoutMs);
        const waitForAck = typeof options.waitForHostRoomCreated === 'function'
          ? options.waitForHostRoomCreated({
            mediaSessionId: message.mediaManifest && message.mediaManifest.mediaSessionId,
            timeoutMs: message.timeoutMs
          })
          : null;
        const sent = await options.sendHostCreateRoom(message);
        if (waitForAck && typeof waitForAck.then === 'function') {
          return waitForAck;
        }
        return sent;
      }
      return message;
    }

    async function teardownObsHostRoom(context = {}) {
      const reason = context.reason || 'host-room-ended';
      if (typeof options.sendLeaveRoom === 'function') {
        await Promise.resolve(options.sendLeaveRoom({
          roomId: context.roomId || '',
          clientId: context.clientId || '',
          sessionToken: context.sessionToken || '',
          reason,
          sendOptions: { queueIfDisconnected: false }
        }));
      }
      clearRoomState(reason, { resetMediaSessionId: true, clearObsFlags: true });
      resetPlaybackState();
      resetObsRoomUiWaitingForStream();
    }

    async function cleanupFailedHostStart() {
      setHostStartInFlight(false);
      setNativeHostSessionRunning(false);
      setHostPreviewAttached(false);
      setHostWaitingWindowRestore(false);
      callOptional('resetFailedHostStartUi');
      callOptional('resetShareStartPendingUi');
    }

    async function cleanupStopResources() {
      callOptional('stopHostStatsPolling');
      callOptional('stopViewerStatsPolling');
      callOptional('detachHostPreviewSurface');
      const peerIds = typeof options.getPeerIds === 'function' ? options.getPeerIds() : [];
      for (const peerId of Array.isArray(peerIds) ? peerIds : []) {
        await Promise.resolve(callOptional('closePeer', peerId, { clearRetryState: true })).catch(() => {});
      }
      await stopHostSession({}).catch(() => {});
      setHostPreviewAttached(false);
      setHostWaitingWindowRestore(false);
    }

    async function finalizeStopState() {
      const roomSnapshot = typeof options.getRoomSnapshot === 'function' ? options.getRoomSnapshot() : null;
      if (roomSnapshot && roomSnapshot.role === 'host' && roomSnapshot.roomId && typeof options.sendLeaveRoom === 'function') {
        await Promise.resolve(options.sendLeaveRoom({
          roomId: roomSnapshot.roomId,
          clientId: roomSnapshot.clientId || '',
          sessionToken: roomSnapshot.sessionToken || '',
          reason: 'host-room-ended',
          sendOptions: { queueIfDisconnected: false }
        })).catch(() => {});
      }
      setNativeHostSessionRunning(false);
      setStopShareInFlight(false);
      setHostStartInFlight(false);
      setHostPreviewAttached(false);
      setHostWaitingWindowRestore(false);
      setObsRoomCreatePending(false);
      setObsIngestStreamActive(false);
      resetMediaSessionId();
      clearRoomState('host-room-ended', { clearObsFlags: true });
      resetPlaybackState();
      resetStopUiState();
      callOptional('markHostSessionStopped');
    }

    async function runStopShare(context = {}) {
      if (typeof context.event === 'object' && context.event) {
        if (typeof context.event.preventDefault === 'function') {
          context.event.preventDefault();
        }
        if (typeof context.event.stopImmediatePropagation === 'function') {
          context.event.stopImmediatePropagation();
        } else if (typeof context.event.stopPropagation === 'function') {
          context.event.stopPropagation();
        }
      }
      const stopStart = beginStopShare({
        peerCount: Number(context.peerCount || 0),
        hasRoom: Boolean(context.hasRoom),
        sessionRole: context.sessionRole || null
      });
      if (!stopStart || stopStart.started !== true) {
        return { stopped: false, reason: stopStart && stopStart.reason ? stopStart.reason : 'stop-share-not-started' };
      }
      try {
        await cleanupStopResources();
        await finalizeStopState();
        return { stopped: true };
      } finally {
        finishStopShare();
      }
    }

    function buildNativeHostStartCodecEffects(context = {}) {
      const effectiveCodec = normalizeVideoCodec(
        (context.session && (context.session.effectiveCodec || context.session.codec)) ||
          context.requestedCodec ||
          getRequestedVideoCodec(),
        'h264'
      );
      return {
        effectiveCodec,
        effects: [
          { type: 'setNativeEffectiveCodec', codec: effectiveCodec }
        ]
      };
    }

    function buildHostStartBeginEffects(context = {}) {
      const backend = normalizeHostBackendName(context.backend || getCurrentHostBackend());
      const effects = [
        { type: 'setCurrentHostBackend', backend },
        { type: 'setNativeHostSessionRunning', running: true },
        { type: 'setHostStartInFlight', inFlight: true },
        { type: 'setStopShareInFlight', inFlight: false },
        { type: 'setRoomInfoHidden', hidden: false },
        { type: 'setShareButtons', sharing: true },
        { type: 'setHostStatus', text: backend === 'obs-ingest' ? '等待 OBS 推流...' : '正在启动...', waiting: true }
      ];
      if (backend === 'obs-ingest') {
        effects.push({ type: 'setHostWaitingWindowRestore', waiting: false });
      }
      return effects;
    }

    function buildHostStartSuccessEffects(context = {}) {
      const backend = normalizeHostBackendName(context.backend || getCurrentHostBackend());
      const previewRequested = Boolean(context.previewRequested);
      const effectiveCodec = normalizeVideoCodec(context.effectiveCodec || getEffectiveVideoCodec());
      const effects = [
        { type: 'setCurrentHostBackend', backend },
        { type: 'setNativeHostSessionRunning', running: true },
        { type: 'setHostStartInFlight', inFlight: false },
        { type: 'setStopShareInFlight', inFlight: false },
        { type: 'setNativeEffectiveCodec', codec: effectiveCodec },
        { type: 'setHostPreviewRequested', requested: previewRequested },
        { type: 'setHostPreviewElementHidden', hidden: !previewRequested },
        { type: 'setHostPreviewAttached', attached: false },
        { type: 'setRoomInfoHidden', hidden: false },
        { type: 'setShareButtons', sharing: true },
        { type: 'call', name: 'startHostStatsPolling' }
      ];
      if (backend === 'obs-ingest') {
        effects.push({ type: 'setObsIngestStreamActive', active: true });
        effects.push({ type: 'setHostStatus', text: 'OBS 已连接，等待有效节目流...', waiting: true });
      } else {
        effects.push({ type: 'setHostStatus', text: '原生分享已就绪', waiting: false });
      }
      return effects;
    }

    function buildHostSessionStoppedEffects() {
      return [
        { type: 'setNativeHostSessionRunning', running: false },
        { type: 'setHostStartInFlight', inFlight: false },
        { type: 'setStopShareInFlight', inFlight: false },
        { type: 'setHostWaitingWindowRestore', waiting: false },
        { type: 'setHostPreviewAttached', attached: false },
        { type: 'setObsRoomCreatePending', pending: false },
        { type: 'setObsIngestStreamActive', active: false }
      ];
    }

    function buildObsMediaStateEffects(params = {}) {
      const stateName = String(params.state || '');
      const obsIngest = params.obsIngest || params.obs || null;
      const effects = [
        { type: 'setCurrentHostBackend', backend: 'obs-ingest' },
        { type: 'setHostWaitingWindowRestore', waiting: false }
      ];

      if (obsIngest) {
        effects.push({ type: 'call', name: 'updateHostEncoderDetail', args: [null, obsIngest] });
      }

      if (stateName === 'obs-ingest-ended') {
        effects.push({ type: 'setNativeHostSessionRunning', running: false });
        effects.push({ type: 'setObsIngestStreamActive', active: false });
        effects.push({ type: 'setObsRoomCreatePending', pending: false });
        effects.push({ type: 'setHostStatus', text: 'OBS 推流已断开', waiting: true });
        effects.push({ type: 'call', name: 'teardownObsHostRoom', args: ['obs-ingest-ended'] });
        return effects;
      }

      effects.push({ type: 'setNativeHostSessionRunning', running: true });
      if (stateName === 'obs-stream-running') {
        effects.push({ type: 'setObsIngestStreamActive', active: true });
        effects.push({ type: 'setHostStatus', text: 'OBS 推流中', waiting: false });
        effects.push({ type: 'call', name: 'ensureObsHostRoomCreated', args: [obsIngest] });
      } else if (stateName === 'obs-ingest-connected') {
        effects.push({ type: 'setObsIngestStreamActive', active: false });
        effects.push({ type: 'setHostStatus', text: 'OBS 已连接，等待有效节目流...', waiting: true });
      } else {
        effects.push({ type: 'setObsIngestStreamActive', active: false });
        effects.push({ type: 'setHostStatus', text: '等待 OBS 推流...', waiting: true });
      }
      return effects;
    }

    function buildMediaStateUpdateEffects(params = {}, context = {}) {
      const stateName = String(params.state || '');
      if (stateName.startsWith('obs-')) {
        return buildObsMediaStateEffects(params);
      }
      const state = params.state || {};
      return [
        {
          type: 'setViewerMediaState',
          state: {
            upstreamConnected: Boolean(state.upstreamConnected),
            videoStarted: Boolean(state.videoStarted),
            viewerReadySent: Boolean(state.viewerReadySent)
          }
        },
        {
          type: 'setNativeHostSessionRunning',
          running: Boolean(context.nativeHostSessionRunning)
        },
        {
          type: 'setHostWaitingWindowRestore',
          waiting: Boolean(context.nativeHostStartInFlight)
        }
      ];
    }

    function applyMediaStateUpdate(params = {}, context = {}) {
      if (!params || !params.state) {
        return [];
      }
      const effects = buildMediaStateUpdateEffects(params, context);
      applyEffects(effects);
      return effects;
    }

    function buildHostMediaManifestFromStats(stats = {}) {
      return {
        ...buildEncodedMediaManifest({
          mediaSessionId: getMediaSessionId(),
          codec: getEffectiveVideoCodec(),
          width: stats.width,
          height: stats.height,
          frameRate: stats.frameRate,
          sourceType: 'native-capture'
        }),
        width: Math.max(1, Number(stats.width || 1920) || 1920),
        height: Math.max(1, Number(stats.height || 1080) || 1080),
        frameRate: Math.max(1, Number(stats.frameRate || 30) || 30),
        captureKind: stats.captureKind || stats.captureState || 'display',
        captureBackend: stats.captureBackend || 'wgc',
        backend: getCurrentHostBackend(),
        reason: 'host-capture-artifact'
      };
    }

    function buildHostMediaManifestFromObsIngest(obsIngest = {}) {
      return {
        ...buildEncodedMediaManifest({
          mediaSessionId: getMediaSessionId(),
          codec: normalizeVideoCodec(obsIngest.videoCodec || getEffectiveVideoCodec()),
          audioCodec: normalizeAudioCodec(obsIngest.audioCodec || 'aac'),
          width: obsIngest.width,
          height: obsIngest.height,
          frameRate: obsIngest.frameRate,
          sourceType: 'obs-ingest'
        }),
        width: Math.max(1, Number(obsIngest.width || 1920) || 1920),
        height: Math.max(1, Number(obsIngest.height || 1080) || 1080),
        frameRate: Math.max(1, Number(obsIngest.frameRate || 30) || 30),
        captureKind: 'obs-ingest',
        captureBackend: 'obs-ingest',
        backend: 'obs-ingest',
        reason: 'obs-ingest-artifact'
      };
    }

    function buildNativePreviewStartState(context = {}) {
      const preferredPreview = Boolean(context.nativeHostPreviewEnabled);
      const requestedPreview = typeof options.shouldRequestHostPreview === 'function'
        ? Boolean(options.shouldRequestHostPreview('native'))
        : getHostPreviewRequested();
      setHostPreviewRequested(requestedPreview);
      const allowPreviewForAttempt = preferredPreview && requestedPreview;
      return {
        preferredPreview,
        allowPreviewForAttempt,
        previewFallbackNoticeShown: false
      };
    }

    function applyEffects(effects = []) {
      for (const effect of Array.isArray(effects) ? effects : [effects]) {
        if (!effect || typeof effect !== 'object') {
          continue;
        }
        switch (effect.type) {
          case 'setNativeHostSessionRunning':
            setNativeHostSessionRunning(Boolean(effect.running));
            break;
          case 'setHostStartInFlight':
            setHostStartInFlight(Boolean(effect.inFlight));
            break;
          case 'setStopShareInFlight':
            setStopShareInFlight(Boolean(effect.inFlight));
            break;
          case 'setHostStopUiState':
            setHostStopUiState(Boolean(effect.stopping));
            break;
          case 'setHostPreviewRequested':
            setHostPreviewRequested(Boolean(effect.requested));
            break;
          case 'setHostPreviewElementHidden':
            setHostPreviewElementHidden(Boolean(effect.hidden));
            break;
          case 'setHostPreviewAttached':
            setHostPreviewAttached(Boolean(effect.attached));
            break;
          case 'setViewerCount':
            setViewerCount(effect.count);
            break;
          case 'setShareButtons':
            setShareButtons(Boolean(effect.sharing));
            break;
          case 'setHostStatus':
            setHostStatus(effect.text || '', Boolean(effect.waiting));
            break;
          case 'setRoomInfoHidden':
            setRoomInfoHidden(Boolean(effect.hidden));
            break;
          case 'setObsRoomCreatePending':
            setObsRoomCreatePending(Boolean(effect.pending));
            break;
          case 'setObsIngestStreamActive':
            setObsIngestStreamActive(Boolean(effect.active));
            break;
          case 'setHostWaitingWindowRestore':
            setHostWaitingWindowRestore(Boolean(effect.waiting));
            break;
          case 'setNativeEffectiveCodec':
            callOptional('setNativeEffectiveCodec', effect.codec || 'h264');
            break;
          case 'setViewerMediaState':
            setViewerMediaState(effect.state || {});
            break;
          case 'setMediaSessionId':
            setMediaSessionId(effect.mediaSessionId || '');
            break;
          case 'setHostStartGeneration':
            setHostStartGeneration(effect.generation || 0);
            break;
          case 'setCurrentHostBackend':
            callOptional('setCurrentHostBackend', effect.backend || 'native');
            break;
          case 'call':
            if (effect.name) {
              callOptional(effect.name, ...(effect.args || []));
            }
            break;
          default:
            break;
        }
      }
    }

    function bindHostControlEvents(bindOptions = {}) {
      if (hostControlEventsBound) {
        return;
      }
      hostControlEventsBound = true;
      const stopShareButton = bindOptions.stopShareButton || null;
      const isHostSessionRunning = typeof bindOptions.isHostSessionRunning === 'function'
        ? bindOptions.isHostSessionRunning
        : () => false;
      const onStopShare = typeof bindOptions.onStopShare === 'function'
        ? bindOptions.onStopShare
        : null;
      const onStopShareError = typeof bindOptions.onStopShareError === 'function'
        ? bindOptions.onStopShareError
        : () => {};

      if (!stopShareButton || !onStopShare) {
        return;
      }

      stopShareButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        onStopShare({ event, hostSessionRunning: isHostSessionRunning() }).catch((error) => {
          onStopShareError(error);
        });
      }, true);
    }

    return {
      normalizeVideoCodec,
      beginHostStart,
      finishHostStart,
      beginStopShare,
      finishStopShare,
      runStopShare,
      isHostStartCurrent,
      applyEffects,
      buildHostStartBeginEffects,
      buildNativePreviewStartState,
      prepareNativeCaptureHostStart,
      startHostSession,
      stopHostSession,
      runNativeCaptureHostStart,
      runNativeCaptureHostStartWithAudio,
      runObsIngestHostStart,
      validateHostStartResult,
      validateAudioStartResult,
      buildNativeHostStartCodecEffects,
      buildHostStartSuccessEffects,
      shouldShowPreviewFallbackNotice,
      shouldRetryNativeStartWithoutPreview,
      createNativeCaptureHostRoom,
      cleanupFailedHostStart,
      buildHostMediaManifestFromStats,
      buildHostMediaManifestFromObsIngest,
      startNativeAudioForShare,
      buildMediaStateUpdateEffects,
      applyMediaStateUpdate,
      ensureObsHostRoomCreated,
      teardownObsHostRoom,
      clearRoomState,
      resetPlaybackState,
      resetStopUiState,
      resetObsRoomUiWaitingForStream,
      cleanupStopResources,
      finalizeStopState,
      bindHostControlEvents,
      resetMediaSessionId,
      ensureMediaSessionId,
      buildHostSessionStartedEffects: buildHostStartSuccessEffects,
      buildHostSessionStoppedEffects,
      buildObsMediaStateEffects,
      getCurrentHostBackend,
      getNativeHostSessionRunning,
      getHostPreviewRequested,
      getHostPreviewAttached,
      getHostWaitingWindowRestore,
      getNativeHostEffectiveCodec,
      getCurrentHostMediaSessionId,
      getMediaSessionId,
      setMediaSessionId
    };
  }

  VDS.nativeSession = {
    createSessionState,
    createController,
    normalizeVideoCodec
  };
})();

