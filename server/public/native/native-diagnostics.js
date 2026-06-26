(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeDiagnostics) {
    return;
  }

  function create(options = {}) {
    const verboseNativeLogs = Boolean(options.verboseNativeLogs);
    const rateLimitState = new Map();
    const recoverableWarnings = new Map();
    const statsPollingTimers = new Map();
    let latestP2pStatsSnapshot = null;
    let latestHostCaptureDiagnosticReport = '等待采集数据...';

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

    function readDebugMode() {
      if (typeof options.debugModeReader === 'function') {
        try {
          return Boolean(options.debugModeReader());
        } catch (_error) {
          return false;
        }
      }
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

    function shouldShowDebugLogsFor(category = 'misc', channel = 'renderer') {
      if (verboseNativeLogs) {
        return true;
      }

      if (typeof options.debugLogGateReader === 'function') {
        try {
          return Boolean(options.debugLogGateReader(category, channel));
        } catch (_error) {
          return false;
        }
      }

      if (typeof window.__vdsShouldDebugLog === 'function') {
        try {
          return Boolean(window.__vdsShouldDebugLog(category, channel));
        } catch (_error) {
          return false;
        }
      }

      return readDebugMode();
    }

    function shouldEmitNativeDebugLog(key, intervalMs = 1000) {
      if (verboseNativeLogs || intervalMs <= 0) {
        return { emit: true, suppressed: 0 };
      }

      const now = Date.now();
      const state = rateLimitState.get(key) || { lastAt: 0, suppressed: 0 };
      if (now - state.lastAt < intervalMs) {
        state.suppressed += 1;
        rateLimitState.set(key, state);
        return { emit: false, suppressed: state.suppressed };
      }

      const suppressed = state.suppressed;
      rateLimitState.set(key, { lastAt: now, suppressed: 0 });
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

    function logMediaEngineEventSummary(event) {
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

      if (isHighFrequencySurfaceEvent && !shouldShowDebugLogsFor(debugCategory, 'highFrequency')) {
        return;
      }
      if (eventName === 'audio-data' && !shouldShowDebugLogsFor(debugCategory, 'highFrequency')) {
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

    function bindMediaEngineEvents(mediaEngine, callbacks = {}) {
      if (!mediaEngine) {
        return;
      }
      if (typeof mediaEngine.onEvent === 'function') {
        mediaEngine.onEvent((event) => {
          logMediaEngineEventSummary(event);
          if (logMediaEngineWarningEvent(event)) {
            return;
          }
          if (event && event.event === 'audio-data') {
            return;
          }
          if (typeof callbacks.onEvent === 'function') {
            callbacks.onEvent(event);
          }
        });
      }
      if (typeof mediaEngine.onStatus === 'function') {
        mediaEngine.onStatus((status) => {
          logNativeDebug('misc', 'Native media engine status updated:', status);
        });
      }
    }

    function logMediaEngineWarningEvent(event) {
      if (!event || event.event !== 'warning' || !event.params || !event.params.message) {
        return false;
      }

      const warningKey = `agent-warning:${event.params.scope || 'misc'}:${event.params.message}`;
      const rate = shouldEmitNativeDebugLog(warningKey, 5000);
      if (rate.emit) {
        logNativeWarningLine(
          '[media-engine warning]',
          event.params.message,
          rate.suppressed ? `suppressed=${rate.suppressed}` : ''
        );
      }
      return true;
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

    function logRecoverableNativeWarning(scope, error, warningOptions = {}) {
      const {
        key = scope,
        category = 'video',
        channel = 'nativeSteps',
        intervalMs = 5000,
        fallbackLabel = '[media-engine]'
      } = warningOptions;
      const message = error && error.message ? error.message : String(error);
      const now = Date.now();
      const lastLoggedAt = recoverableWarnings.get(key) || 0;
      if (!shouldShowDebugLogsFor(category, channel) && now - lastLoggedAt < intervalMs) {
        return;
      }
      recoverableWarnings.set(key, now);
      if (shouldShowDebugLogsFor(category, channel)) {
        logNativeStep(scope, { key, message }, category);
        return;
      }
      logNativeWarningLine(fallbackLabel, message);
    }

    function clearRecoverableWarning(key) {
      if (key) {
        recoverableWarnings.delete(key);
      }
    }

    function buildHostCaptureDiagnosticReportFromStats(stats, fpsSnapshot = {}, reportOptions = {}) {
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
      const currentHostBackend = reportOptions.currentHostBackend;

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

    const hostFpsSample = {
      sourceFrames: null,
      previewFrames: null,
      sentFrames: null,
      sampledAtMs: 0
    };
    const viewerFpsSample = {
      receivedFrames: null,
      renderedFrames: null,
      sampledAtMs: 0
    };

    function resetHostFpsSample() {
      hostFpsSample.sourceFrames = null;
      hostFpsSample.previewFrames = null;
      hostFpsSample.sentFrames = null;
      hostFpsSample.sampledAtMs = 0;
    }

    function updateHostFpsSample(sourceFrames, previewFrames, sentFrames, nowMs = Date.now()) {
      if (
        hostFpsSample.sampledAtMs <= 0 ||
        hostFpsSample.sourceFrames === null ||
        hostFpsSample.previewFrames === null ||
        hostFpsSample.sentFrames === null
      ) {
        hostFpsSample.sourceFrames = Number.isFinite(sourceFrames) ? sourceFrames : 0;
        hostFpsSample.previewFrames = Number.isFinite(previewFrames) ? previewFrames : 0;
        hostFpsSample.sentFrames = Number.isFinite(sentFrames) ? sentFrames : 0;
        hostFpsSample.sampledAtMs = nowMs;
        return {
          sourceFps: Number.isFinite(sourceFrames) && sourceFrames > 0 ? 0 : '-',
          previewFps: Number.isFinite(previewFrames) && previewFrames > 0 ? 0 : '-',
          sendFps: Number.isFinite(sentFrames) && sentFrames > 0 ? 0 : '-'
        };
      }

      const deltaMs = Math.max(1, nowMs - hostFpsSample.sampledAtMs);
      const sourceFps = Number.isFinite(sourceFrames)
        ? Math.max(0, sourceFrames - hostFpsSample.sourceFrames) * 1000 / deltaMs
        : NaN;
      const previewFps = Number.isFinite(previewFrames)
        ? Math.max(0, previewFrames - hostFpsSample.previewFrames) * 1000 / deltaMs
        : NaN;
      const sendFps = Number.isFinite(sentFrames)
        ? Math.max(0, sentFrames - hostFpsSample.sentFrames) * 1000 / deltaMs
        : NaN;

      hostFpsSample.sourceFrames = Number.isFinite(sourceFrames) ? sourceFrames : hostFpsSample.sourceFrames;
      hostFpsSample.previewFrames = Number.isFinite(previewFrames) ? previewFrames : hostFpsSample.previewFrames;
      hostFpsSample.sentFrames = Number.isFinite(sentFrames) ? sentFrames : hostFpsSample.sentFrames;
      hostFpsSample.sampledAtMs = nowMs;
      return {
        sourceFps: Number.isFinite(sourceFps) ? Math.round(sourceFps) : '-',
        previewFps: Number.isFinite(previewFps) ? Math.round(previewFps) : '-',
        sendFps: Number.isFinite(sendFps) ? Math.round(sendFps) : '-'
      };
    }

    function resetViewerFpsSample() {
      viewerFpsSample.receivedFrames = null;
      viewerFpsSample.renderedFrames = null;
      viewerFpsSample.sampledAtMs = 0;
    }

    function updateViewerFpsSample(receivedFrames, renderedFrames, nowMs = Date.now()) {
      if (
        !Number.isFinite(receivedFrames) ||
        !Number.isFinite(renderedFrames) ||
        receivedFrames < 0 ||
        renderedFrames < 0
      ) {
        return null;
      }

      if (viewerFpsSample.receivedFrames === null || viewerFpsSample.renderedFrames === null || viewerFpsSample.sampledAtMs <= 0) {
        viewerFpsSample.receivedFrames = receivedFrames;
        viewerFpsSample.renderedFrames = renderedFrames;
        viewerFpsSample.sampledAtMs = nowMs;
        return {
          receiveFps: receivedFrames > 0 ? 0 : '-',
          renderFps: renderedFrames > 0 ? 0 : '-'
        };
      }

      const deltaMs = Math.max(1, nowMs - viewerFpsSample.sampledAtMs);
      const receiveFps = Math.max(0, receivedFrames - viewerFpsSample.receivedFrames) * 1000 / deltaMs;
      const renderFps = Math.max(0, renderedFrames - viewerFpsSample.renderedFrames) * 1000 / deltaMs;
      viewerFpsSample.receivedFrames = receivedFrames;
      viewerFpsSample.renderedFrames = renderedFrames;
      viewerFpsSample.sampledAtMs = nowMs;
      return {
        receiveFps: Math.round(receiveFps),
        renderFps: Math.round(renderFps)
      };
    }

    function buildHostStatsSummary(stats, summaryOptions = {}) {
      const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
      const surfaces = Array.isArray(stats && stats.surfaces) ? stats.surfaces : [];
      const peer = peers.find((entry) => entry && entry.role === 'host-downstream') || null;
      const surface = surfaces.find((entry) => entry && (entry.target === 'host-session-video' || entry.target === 'host-capture-artifact')) || null;
      const hostPlan = stats && stats.hostCapturePlan ? stats.hostCapturePlan : null;
      const hostPipeline = stats && stats.hostPipeline ? stats.hostPipeline : null;
      const obsIngest = stats && stats.obsIngest ? stats.obsIngest : null;
      const obsIngestHostBackend = Boolean(summaryOptions.obsIngestHostBackend);
      const reason = summaryOptions.reason || 'periodic';
      const currentHostBackend = summaryOptions.currentHostBackend || 'native';
      const sourceFrames = obsIngestHostBackend
        ? (obsIngest && Number.isFinite(obsIngest.videoPacketsReceived) ? obsIngest.videoPacketsReceived : NaN)
        : (peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.sourceFramesCaptured) ? peer.mediaBinding.sourceFramesCaptured : NaN);
      const captureFrames = surface && Number.isFinite(surface.decodedFramesRendered) ? surface.decodedFramesRendered : NaN;
      const sentFrames = peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.framesSent) ? peer.mediaBinding.framesSent : NaN;
      return {
        peer,
        surface,
        hostPlan,
        hostPipeline,
        obsIngest,
        sourceFrames,
        captureFrames,
        sentFrames,
        logFields: [
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
          `encodedDataChannelReady=${Boolean(peer && peer.peerTransport && peer.peerTransport.encodedMediaDataChannelReady)}`,
          `encodedDataChannelState=${peer && peer.peerTransport && peer.peerTransport.encodedMediaDataChannelState ? peer.peerTransport.encodedMediaDataChannelState : 'n/a'}`,
          `encodedDataChannelFramesSent=${peer && peer.peerTransport && Number.isFinite(peer.peerTransport.encodedMediaDataChannelFramesSent) ? peer.peerTransport.encodedMediaDataChannelFramesSent : 0}`,
          `framesSent=${peer && peer.mediaBinding && Number.isFinite(peer.mediaBinding.framesSent) ? peer.mediaBinding.framesSent : 0}`,
          `bindingReason=${peer && peer.mediaBinding && peer.mediaBinding.reason ? peer.mediaBinding.reason : 'n/a'}`
        ]
      };
    }

    function buildRelayStatsLogEntry(relayPeer, reason) {
      const peerTransport = relayPeer && relayPeer.peerTransport ? relayPeer.peerTransport : null;
      const relayRuntime = relayPeer && relayPeer.relaySubscriberRuntime ? relayPeer.relaySubscriberRuntime : null;
      return {
        peerId: relayPeer && relayPeer.peerId ? relayPeer.peerId : 'unknown',
        fields: [
          `reason=${reason}`,
          `peer=${relayPeer && relayPeer.peerId ? relayPeer.peerId : 'n/a'}`,
          `transportState=${peerTransport && peerTransport.connectionState ? peerTransport.connectionState : 'n/a'}`,
          `encodedDataChannelReady=${Boolean(peerTransport && peerTransport.encodedMediaDataChannelReady)}`,
          `encodedDataChannelState=${peerTransport && peerTransport.encodedMediaDataChannelState ? peerTransport.encodedMediaDataChannelState : 'n/a'}`,
          `encodedDataChannelFramesSent=${peerTransport && Number.isFinite(peerTransport.encodedMediaDataChannelFramesSent) ? peerTransport.encodedMediaDataChannelFramesSent : 0}`,
          `encodedDataChannelFramesReceived=${peerTransport && Number.isFinite(peerTransport.encodedMediaDataChannelFramesReceived) ? peerTransport.encodedMediaDataChannelFramesReceived : 0}`,
          `videoFramesSent=${peerTransport && Number.isFinite(peerTransport.videoFramesSent) ? peerTransport.videoFramesSent : 0}`,
          `audioFramesSent=${peerTransport && Number.isFinite(peerTransport.audioFramesSent) ? peerTransport.audioFramesSent : 0}`,
          `pendingBootstrap=${Boolean(relayRuntime && relayRuntime.pendingVideoBootstrap)}`,
          `bootstrapSnapshotSent=${Boolean(relayRuntime && relayRuntime.bootstrapSnapshotSent)}`,
          `relayFramesSent=${relayRuntime && Number.isFinite(relayRuntime.framesSent) ? relayRuntime.framesSent : 0}`,
          `relayReason=${relayRuntime && relayRuntime.reason ? relayRuntime.reason : 'n/a'}`,
          `relayError=${relayRuntime && relayRuntime.lastError ? relayRuntime.lastError : ''}`
        ]
      };
    }

    function buildViewerStatsSummary(stats, summaryOptions = {}) {
      const upstreamPeerId = summaryOptions.upstreamPeerId || '';
      const reason = summaryOptions.reason || 'periodic';
      const peers = Array.isArray(stats && stats.peers) ? stats.peers : [];
      const peer = peers.find((entry) => entry && entry.peerId === upstreamPeerId) || null;
      const surfaces = Array.isArray(stats && stats.surfaces) ? stats.surfaces : [];
      const surface = surfaces.find((entry) => entry && entry.target === `peer-video:${upstreamPeerId}`) || null;
      const peerTransport = peer && peer.peerTransport ? peer.peerTransport : null;
      const renderedFrames = Math.max(
        peerTransport && Number.isFinite(peerTransport.decodedFramesRendered) ? peerTransport.decodedFramesRendered : 0,
        surface && Number.isFinite(surface.decodedFramesRendered) ? surface.decodedFramesRendered : 0
      );
      const receivedFrames = peerTransport && Number.isFinite(peerTransport.remoteVideoFramesReceived)
        ? peerTransport.remoteVideoFramesReceived
        : (peerTransport && Number.isFinite(peerTransport.encodedMediaDataChannelFramesReceived) ? peerTransport.encodedMediaDataChannelFramesReceived : 0);
      return {
        peers,
        peer,
        peerTransport,
        surface,
        renderedFrames,
        receivedFrames,
        peerLogFields: peerTransport ? [
          `reason=${reason}`,
          `peer=${peer.peerId || 'n/a'}`,
          `receiverConfigured=${Boolean(peerTransport.videoReceiverConfigured)}`,
          `decoderReady=${Boolean(peerTransport.decoderReady)}`,
          `framesReceived=${receivedFrames}`,
          `encodedDataChannelFramesReceived=${peerTransport.encodedMediaDataChannelFramesReceived || 0}`,
          `framesRendered=${peerTransport.decodedFramesRendered || 0}`,
          `surfaceFrameStddevMs=${surface && typeof surface.frameIntervalStddevMs === 'number' ? surface.frameIntervalStddevMs.toFixed(3) : '0.000'}`,
          `submittedVideo=${peer.receiverRuntime && peer.receiverRuntime.submittedVideoUnits ? peer.receiverRuntime.submittedVideoUnits : 0}`,
          `dispatchedAudio=${peer.receiverRuntime && peer.receiverRuntime.dispatchedAudioBlocks ? peer.receiverRuntime.dispatchedAudioBlocks : 0}`,
          `droppedVideo=${peer.receiverRuntime && peer.receiverRuntime.droppedVideoUnits ? peer.receiverRuntime.droppedVideoUnits : 0}`,
          `droppedAudio=${peer.receiverRuntime && peer.receiverRuntime.droppedAudioBlocks ? peer.receiverRuntime.droppedAudioBlocks : 0}`,
          `receiverReason=${peer.receiverRuntime && peer.receiverRuntime.reason ? peer.receiverRuntime.reason : 'n/a'}`,
          `receiverError=${peer.receiverRuntime && peer.receiverRuntime.lastError ? peer.receiverRuntime.lastError : ''}`,
          `mediaReady=${Boolean(peerTransport.mediaPlaneReady)}`,
          `surfaceReason=${surface && surface.reason ? surface.reason : 'n/a'}`,
          `surfaceError=${surface && surface.lastError ? surface.lastError : ''}`
        ] : [],
        relayLogEntries: peers.filter((entry) => entry && entry.role === 'relay-downstream').map((relayPeer) => buildRelayStatsLogEntry(relayPeer, reason))
      };
    }

    function getStatsPollingIntervalMs() {
      const configured = Number(options.statsPollingIntervalMs);
      return Number.isFinite(configured) && configured > 0 ? configured : 5000;
    }

    function stopStatsPolling(scope, stopOptions = {}) {
      const pollingScope = String(scope || 'default');
      const existing = statsPollingTimers.get(pollingScope) || null;
      if (existing && existing.intervalId) {
        window.clearInterval(existing.intervalId);
      }
      if (existing) {
        statsPollingTimers.delete(pollingScope);
      }
      const onStop = typeof stopOptions.onStop === 'function'
        ? stopOptions.onStop
        : (existing && typeof existing.onStop === 'function' ? existing.onStop : null);
      if (onStop) {
        onStop();
      }
    }

    function startStatsPolling(scope, pollingOptions = {}) {
      const pollingScope = String(scope || 'default');
      stopStatsPolling(pollingScope, { onStop: pollingOptions.onStop });
      if (typeof pollingOptions.onStart === 'function') {
        pollingOptions.onStart();
      }

      const intervalMs = getStatsPollingIntervalMs();
      const shouldContinue = typeof pollingOptions.shouldContinue === 'function'
        ? pollingOptions.shouldContinue
        : () => true;
      const onTick = typeof pollingOptions.onTick === 'function'
        ? pollingOptions.onTick
        : null;
      const tick = (reason = 'periodic') => {
        if (!shouldContinue()) {
          stopStatsPolling(pollingScope);
          return null;
        }
        return onTick ? onTick(reason) : null;
      };

      const intervalId = window.setInterval(() => tick('periodic'), intervalMs);
      statsPollingTimers.set(pollingScope, {
        intervalId,
        onStop: pollingOptions.onStop || null
      });
      tick('initial');
      return { scope: pollingScope, intervalMs };
    }

    function setLatestP2pStatsSnapshot(stats) {
      latestP2pStatsSnapshot = stats || null;
      return latestP2pStatsSnapshot;
    }

    function getLatestP2pStatsSnapshot() {
      return latestP2pStatsSnapshot;
    }

    function setLatestHostCaptureDiagnosticReport(report) {
      latestHostCaptureDiagnosticReport = String(report || '等待采集数据...');
      return latestHostCaptureDiagnosticReport;
    }

    function getLatestHostCaptureDiagnosticReport() {
      return latestHostCaptureDiagnosticReport;
    }

    function buildP2pDiagnosticReport(snapshot = {}) {
      const lines = [];
      const mediaManifest = snapshot.mediaManifest || null;
      const peers = Array.isArray(snapshot.peers) ? snapshot.peers : [];
      const showHealthyPeerDetails = Boolean(snapshot.showHealthyPeerDetails);

      lines.push(`role: ${formatDiagnosticValue(snapshot.role)}`);
      lines.push(`roomId: ${formatDiagnosticValue(snapshot.roomId)}`);
      lines.push(`clientId: ${formatDiagnosticValue(snapshot.clientId)}`);
      lines.push(`p2pStatus: ${formatDiagnosticValue(snapshot.p2pStatus)}`);
      lines.push(`upstreamPeerId: ${formatDiagnosticValue(snapshot.upstreamPeerId)}`);
      lines.push(`hostId: ${formatDiagnosticValue(snapshot.hostId)}`);
      lines.push(`chainPosition: ${Number.isInteger(snapshot.chainPosition) ? snapshot.chainPosition : '-'}`);
      if (mediaManifest) {
        lines.push(`mediaSessionId: ${formatDiagnosticValue(mediaManifest.mediaSessionId)}`);
        lines.push(`manifestVersion: ${formatDiagnosticValue(mediaManifest.manifestVersion)}`);
        lines.push(`videoManifest: ${formatDiagnosticValue(mediaManifest.video && mediaManifest.video.codec)}/${formatDiagnosticValue(mediaManifest.video && mediaManifest.video.payloadFormat)}`);
        lines.push(`audioManifest: ${formatDiagnosticValue(mediaManifest.audio && mediaManifest.audio.codec)}/${formatDiagnosticValue(mediaManifest.audio && mediaManifest.audio.payloadFormat)}`);
      }
      lines.push(`connected: ${formatDiagnosticValue(snapshot.connected)}`);
      lines.push(`videoStarted: ${formatDiagnosticValue(snapshot.videoStarted)}`);
      lines.push(`natMappingAvailable: ${formatDiagnosticValue(snapshot.natMappingAvailable)}`);
      lines.push('');
      lines.push('peers:');

      if (peers.length === 0) {
        lines.push('- none');
      }

      peers.forEach((entry) => {
        const peerId = entry && entry.peerId ? entry.peerId : '';
        const handle = entry && entry.handle ? entry.handle : {};
        const meta = entry && entry.meta ? entry.meta : null;
        const candidateCounts = entry && entry.candidateCounts ? entry.candidateCounts : { host: 0, srflx: 0, relay: 0, other: 0 };
        const statsPeer = entry && entry.statsPeer ? entry.statsPeer : null;
        const peerTransport = statsPeer && statsPeer.peerTransport ? statsPeer.peerTransport : {};
        const receiverRuntime = statsPeer && statsPeer.receiverRuntime ? statsPeer.receiverRuntime : {};
        const selectedLocalCandidate = peerTransport.selectedLocalCandidate || '';
        const selectedRemoteCandidate = peerTransport.selectedRemoteCandidate || '';
        const encodedDataChannelReady = Boolean(peerTransport.encodedMediaDataChannelReady);
        const encodedDataChannelOpen = Boolean(peerTransport.encodedMediaDataChannelOpen);
        const framesSent = peerTransport.videoFramesSent || peerTransport.encodedMediaDataChannelFramesSent || (statsPeer && statsPeer.mediaBinding && statsPeer.mediaBinding.framesSent) || 0;
        const framesReceived = peerTransport.remoteVideoFramesReceived || peerTransport.encodedMediaDataChannelFramesReceived || 0;
        const framesDecoded = peerTransport.decodedFramesRendered || 0;
        const droppedVideoUnits = receiverRuntime.droppedVideoUnits || 0;
        const droppedAudioBlocks = receiverRuntime.droppedAudioBlocks || 0;
        const invalidDataChannelFrames = peerTransport.encodedMediaDataChannelInvalidFrames || 0;
        const receiverError = receiverRuntime.lastError || '';
        const healthyPeer =
          handle.connectionState === 'connected' &&
          handle.iceConnectionState === 'connected' &&
          encodedDataChannelOpen &&
          encodedDataChannelReady &&
          invalidDataChannelFrames === 0 &&
          droppedVideoUnits === 0 &&
          !receiverError &&
          (framesSent > 0 || framesReceived > 0 || framesDecoded > 0);
        const showPeerDetails = !healthyPeer || showHealthyPeerDetails;

        lines.push(`- ${peerId} ${formatDiagnosticValue(handle.role)}/${formatDiagnosticValue(handle.kind)} ${formatDiagnosticValue(handle.connectionState)}/${formatDiagnosticValue(handle.iceConnectionState)} dc=${encodedDataChannelReady ? 'ready' : formatDiagnosticValue(peerTransport.encodedMediaDataChannelState)} pair=${summarizeSelectedCandidate(selectedLocalCandidate)}>${summarizeSelectedCandidate(selectedRemoteCandidate)} rtt=${normalizeDiagnosticNumber(peerTransport.roundTripTimeMs)}ms v=${formatDiagnosticValue(framesSent)}/${formatDiagnosticValue(framesReceived)}/${formatDiagnosticValue(framesDecoded)} a=${formatDiagnosticValue(peerTransport.audioFramesSent || 0)}/${formatDiagnosticValue(peerTransport.remoteAudioFramesReceived || 0)} drop=${formatDiagnosticValue(droppedVideoUnits)}/${formatDiagnosticValue(droppedAudioBlocks)} attempt=${formatDiagnosticValue(meta && meta.edgeAttemptId)}`);
        if (!showPeerDetails) {
          return;
        }
        lines.push(`  peerId: ${peerId}`);
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
        lines.push(`  mediaSessionId: ${formatDiagnosticValue(statsPeer && statsPeer.mediaSessionId)}`);
        lines.push(`  mediaManifestVersion: ${formatDiagnosticValue(statsPeer && statsPeer.mediaManifestVersion)}`);
        lines.push(`  expectedVideoCodec: ${formatDiagnosticValue(statsPeer && statsPeer.expectedVideoCodec)}`);
        lines.push(`  expectedAudioCodec: ${formatDiagnosticValue(statsPeer && statsPeer.expectedAudioCodec)}`);
        lines.push(`  encodedDataChannelRequested: ${formatDiagnosticValue(Boolean(peerTransport.encodedMediaDataChannelRequested))}`);
        lines.push(`  encodedDataChannelOpen: ${formatDiagnosticValue(encodedDataChannelOpen)}`);
        lines.push(`  encodedDataChannelReady: ${formatDiagnosticValue(encodedDataChannelReady)}`);
        lines.push(`  encodedDataChannelState: ${formatDiagnosticValue(peerTransport.encodedMediaDataChannelState)}`);
        lines.push(`  encodedDataChannelFramesSent: ${formatDiagnosticValue(peerTransport.encodedMediaDataChannelFramesSent || 0)}`);
        lines.push(`  encodedDataChannelFramesReceived: ${formatDiagnosticValue(peerTransport.encodedMediaDataChannelFramesReceived || 0)}`);
        lines.push(`  encodedDataChannelInvalidFrames: ${formatDiagnosticValue(invalidDataChannelFrames)}`);
        lines.push(`  videoSent: ${formatDiagnosticValue(framesSent)}`);
        lines.push(`  videoReceived: ${formatDiagnosticValue(framesReceived)}`);
        lines.push(`  videoDecoded: ${formatDiagnosticValue(framesDecoded)}`);
        lines.push(`  audioSent: ${formatDiagnosticValue(peerTransport.audioFramesSent || 0)}`);
        lines.push(`  audioReceived: ${formatDiagnosticValue(peerTransport.remoteAudioFramesReceived || 0)}`);
        lines.push(`  nackRetransmissions: ${formatDiagnosticValue(peerTransport.nackRetransmissions || 0)}`);
        lines.push(`  pliRequestsReceived: ${formatDiagnosticValue(peerTransport.pliRequestsReceived || 0)}`);
        lines.push(`  keyframeRequestsSent: ${formatDiagnosticValue(peerTransport.keyframeRequestsSent || 0)}`);
        lines.push(`  decoderRecoveryCount: ${formatDiagnosticValue(peerTransport.decoderRecoveryCount || 0)}`);
        lines.push(`  droppedVideoUnits: ${formatDiagnosticValue(droppedVideoUnits)}`);
        lines.push(`  droppedAudioBlocks: ${formatDiagnosticValue(droppedAudioBlocks)}`);
        lines.push(`  receiverReason: ${formatDiagnosticValue(receiverRuntime.reason)}`);
        lines.push(`  receiverError: ${formatDiagnosticValue(receiverError)}`);
      });

      return lines.join('\n');
    }

    return {
      formatDiagnosticValue,
      normalizeDiagnosticNumber,
      summarizeSelectedCandidate,
      buildHostStatsSummary,
      buildViewerStatsSummary,
      resetHostFpsSample,
      updateHostFpsSample,
      resetViewerFpsSample,
      updateViewerFpsSample,
      buildP2pDiagnosticReport,
      buildHostCaptureDiagnosticReportFromStats,
      isDebugModeEnabled: readDebugMode,
      shouldShowDebugLogsFor,
      shouldEmitNativeDebugLog,
      getStatsPollingIntervalMs,
      startStatsPolling,
      stopStatsPolling,
      setLatestP2pStatsSnapshot,
      getLatestP2pStatsSnapshot,
      setLatestHostCaptureDiagnosticReport,
      getLatestHostCaptureDiagnosticReport,
      appendSuppressedDebugCount,
      getNativeDebugCategoryFromScope,
      getNativeDebugCategoryFromEvent,
      summarizeNativeLogValue,
      logNativeDebug,
      logNativeStep,
      logMediaEngineEventSummary,
      logMediaEngineWarningEvent,
      bindMediaEngineEvents,
      logNativeStatsLine,
      logNativeWarningLine,
      logRecoverableNativeWarning,
      clearRecoverableWarning
    };
  }

  VDS.nativeDiagnostics = { create };
})();
