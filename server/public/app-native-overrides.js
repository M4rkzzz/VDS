const installNativeAuthorityOverrides = function (installOptions = {}) {
  const nativeEntry = window.VDS && window.VDS.nativeEntry ? window.VDS.nativeEntry : null;
  const installManagedByEntry = Boolean(installOptions && installOptions.installManagedByEntry);
  if (!installManagedByEntry) {
    if (window.__vdsNativeAuthorityOverridesInstalled) {
      return null;
    }
    if (nativeEntry && typeof nativeEntry.markLegacyOverridesInstalled === 'function') {
      nativeEntry.markLegacyOverridesInstalled();
    } else {
      window.__vdsNativeAuthorityOverridesInstalled = true;
    }
  }

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
  if (nativeEntry && typeof nativeEntry.setRuntimeFlags === 'function') {
    nativeEntry.setRuntimeFlags({ nativePeerTransportEnabled });
  }

  if (!window.isElectron || !mediaEngine) {
    return null;
  }
  if (!nativeEntry || typeof nativeEntry.createRequired !== 'function') {
    throw new Error('native-entry-unavailable');
  }
  const roomClient = window.VDS && window.VDS.roomClient ? window.VDS.roomClient : null;
  if (!roomClient || typeof roomClient.registerMessageHandler !== 'function') {
    throw new Error('room-client-dispatcher-unavailable');
  }

  const nativeDiagnostics = nativeEntry.createRequired('nativeDiagnostics', 'create', 'native-diagnostics-unavailable', { verboseNativeLogs });
  const nativeMediaEngineController = nativeEntry.createRequired('nativeMediaEngine', 'createController', 'native-media-engine-controller-unavailable', {
      mediaEngine,
      logCapabilities: (capabilities) => {
        if (capabilities) {
          nativeDiagnostics.logNativeDebug('misc', 'Native media engine capabilities:', capabilities);
        }
      },
      eventHandlers: {
        onSignal: (params) => nativePeerController.handleLocalSignalEventAndSend(params, { roomId: currentRoomId }),
        onPeerState: (params) => nativePeerController.handlePeerStateEvent(params),
        onMediaState: (params) => nativeSessionController.applyMediaStateUpdate(params, {
          nativeHostStartInFlight,
          nativeHostSessionRunning,
          currentRoomId,
          sessionRole
        })
      }
    });

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

  let nativeHostStartGeneration = 0;

  const HOST_PREVIEW_SURFACE_ID = 'embedded-host-preview';

  const legacyAppStateBridge = nativeEntry.createRequired('nativeRendererState', 'createLegacyAppStateBridge', 'native-renderer-state-bridge-unavailable', {
    setters: {
      currentRoomId: (value) => { currentRoomId = value; },
      sessionRole: (value) => { sessionRole = value; },
      currentSessionToken: (value) => { currentSessionToken = value; },
      myChainPosition: (value) => { myChainPosition = value; },
      hostId: (value) => { hostId = value; },
      upstreamPeerId: (value) => { upstreamPeerId = value; },
      upstreamConnected: (value) => { upstreamConnected = value; },
      viewerReadySent: (value) => { viewerReadySent = value; },
      videoStarted: (value) => { videoStarted = value; },
      isHost: (value) => { isHost = value; }
    }
  });

  let nativeHostSessionRunning = false;
  let nativeHostStartInFlight = false;
  let nativeUiReadyPromise = null;
  let hostPreviewSurfaceAttached = false;
  let viewerVolumeSynced = false;
  let currentWindowBounds = null;
  let stopScreenShareInFlight = false;
  let hostWaitingWindowRestore = false;
  let nativeHostEffectiveCodec = 'h264';
  const nativeSessionState = nativeEntry.createRequired('nativeSession', 'createSessionState', 'native-session-state-unavailable');
  let currentHostMediaSessionId = '';
  let currentMediaManifest = null;
  const appStateSyncBridge = nativeEntry.createRequired('nativeRendererState', 'createAppStateSyncBridge', 'native-renderer-state-sync-bridge-unavailable', {
    getMediaManifest: () => currentMediaManifest || null,
    syncAppState: (patch, metadata) => {
      if (typeof window.__vdsSyncAppState !== 'function') {
        return null;
      }
      return window.__vdsSyncAppState(patch, metadata);
    }
  });
  const nativeRendererState = nativeEntry.createRequired('nativeRendererState', 'createController', 'native-renderer-state-controller-unavailable', {
    applyPatch: (patch) => legacyAppStateBridge.applyPatch(patch),
    elements: {
      waitingMessage: elements.waitingMessage,
      connectionStatus: elements.connectionStatus,
      roomInfo: elements.roomInfo,
      roomIdDisplay: elements.roomIdDisplay,
      viewerCount: elements.viewerCount,
      joinForm: elements.joinForm,
      viewerStatus: elements.viewerStatus,
      viewerRoomId: elements.viewerRoomId,
      btnLeave: elements.btnLeave,
      chainPosition: elements.chainPosition,
      btnStartShare: elements.btnStartShare,
      btnStopShare: elements.btnStopShare,
      hostStatus: elements.hostStatus,
      hostVideoContainer
    }
  });
  const nativeViewerControls = nativeEntry.createRequired('nativeViewerControls', 'createController', 'native-viewer-controls-unavailable', {
    mediaEngine,
    elements: {
      viewerVolumeInput,
      viewerVolumeValue,
      viewerFullscreenVolumeInput,
      viewerFullscreenVolumeValue,
      viewerFullscreenMuteButton
    },
    logRecoverableNativeWarning: (...args) => nativeDiagnostics.logRecoverableNativeWarning(...args)
  });
  const nativeViewerFullscreenControls = nativeEntry.createRequired('nativeViewerFullscreenControls', 'createController', 'native-viewer-fullscreen-controls-unavailable', {
    electronApi,
    viewerControls: nativeViewerControls,
    elements: {
      fullscreenButtons: [hostFullscreenButton, viewerFullscreenButton],
      remoteContainer: remoteVideoContainer,
      underbar: viewerFullscreenUnderbar,
      volumeControl: viewerFullscreenVolumeControl,
      volumeInput: viewerVolumeInput,
      fullscreenVolumeInput: viewerFullscreenVolumeInput,
      muteButton: viewerFullscreenMuteButton,
      exitButton: viewerFullscreenExitButton
    },
    getCurrentWindowBounds: () => currentWindowBounds,
    forceSurfaceResync: () => nativeSurfaceController.forceResync()
  });
  const p2pStateMachine = nativeEntry.createRequired('p2pStateMachine', 'create', 'p2p-state-machine-unavailable', {
      getStatusElementForPeer: (peerId) => getP2pStatusElementForPeer(peerId),
      getPeerMeta: (peerId) => peerConnectionMeta.get(peerId) || null,
      renderDiagnosticReport: () => renderP2pDiagnosticReport(),
      getViewerMediaWaitSnapshot: (peerId) => ({
        sessionRole,
        upstreamPeerId,
        videoStarted,
        upstreamConnected
      }),
      getViewerUpstreamOfferWaitSnapshot: (peerId) => ({
        sessionRole,
        roomId: currentRoomId,
        upstreamPeerId,
        peerExists: peerConnections.has(peerId),
        chainPosition: myChainPosition,
        clientId,
        sessionToken: currentSessionToken || ''
      }),
      onViewerMediaWaitTimeout: () => nativeRendererState.setViewerConnectionState('已连接，等待画面...'),
      onViewerUpstreamOfferTimeout: (peerId, snapshot) => {
        nativeDiagnostics.logNativeStep('viewer:upstream-offer-timeout', {
          peerId,
          roomId: snapshot.roomId,
          chainPosition: snapshot.chainPosition
        }, 'connection');
        roomClient.sendViewerReconnectReady({
          roomId: snapshot.roomId,
          clientId: snapshot.clientId,
          sessionToken: snapshot.sessionToken || '',
          chainPosition: snapshot.chainPosition,
          upstreamPeerId: peerId,
          failedUpstreamPeerId: peerId
        });
      }
    });
  const nativeStatsController = nativeEntry.createRequired('nativeStats', 'createController', 'native-stats-controller-unavailable', {
      mediaEngine,
      diagnostics: nativeDiagnostics,
      elements,
      roomClient,
      nativeSessionState,
      viewerControls: nativeViewerControls,
      p2pStateMachine,
      renderP2pDiagnosticReport: () => renderP2pDiagnosticReport(),
      renderHostCaptureDiagnosticReport: () => renderHostCaptureDiagnosticReport(),
      isObsIngestHostBackend: () => isObsIngestHostBackend(),
      isNativeHostSessionRunning: () => nativeHostSessionRunning,
      isHost: () => isHost,
      getCurrentRoomId: () => currentRoomId,
      syncHostWaitingWindowRestoreUi: (waiting, restoredText) => {
        hostWaitingWindowRestore = Boolean(waiting);
        nativeRendererState.syncHostWaitingWindowRestoreUi(hostWaitingWindowRestore, {
          restoredText: restoredText || '原生分享已恢复',
          obsIngestHostBackend: isObsIngestHostBackend()
        });
      },
      isHostWaitingWindowRestore: () => hostWaitingWindowRestore,
      getNativeHostEffectiveCodec: () => nativeHostEffectiveCodec,
      getUpstreamPeerId: () => upstreamPeerId,
      getSessionRole: () => sessionRole,
      setViewerMediaState: (state) => nativeRendererState.setViewerMediaState(state),
      getViewerVolumeSynced: () => viewerVolumeSynced,
      setViewerVolumeSynced: (value) => {
        viewerVolumeSynced = Boolean(value);
      },
      getViewerReadySent: () => viewerReadySent,
      setViewerReadySent: (value) => {
        viewerReadySent = Boolean(value);
      },
      getChainPosition: () => myChainPosition,
      getClientId: () => clientId,
      getCurrentSessionToken: () => currentSessionToken
    });  const nativeSurfaceController = nativeEntry.createRequired('nativeSurface', 'createController', 'native-surface-controller-unavailable', {
      mediaEngine,
      electronApi,
      surfaceEmbeddingEnabled: nativeSurfaceEmbeddingEnabled,
      remoteVideoContainer,
      hostPreviewElement: hostVideoContainer,
      hostPreviewSurfaceId: HOST_PREVIEW_SURFACE_ID,
      hostPreviewTarget: 'host-capture-artifact',
      viewerFullscreenUnderbar,
      diagnostics: nativeDiagnostics,
      logNativeStep: (scope, payload, category) => nativeDiagnostics.logNativeStep(scope, payload, category),
      onSurfaceTrackingRemoved: (surfaceId, reason) => onEmbeddedSurfaceTrackingRemoved(surfaceId, reason),
      logSyncAllError: (error) => nativeDiagnostics.logRecoverableNativeWarning('syncAllEmbeddedSurfaces:failed', error, {
        key: 'sync-all-embedded-surfaces',
        category: 'video',
        channel: 'nativeSteps',
        fallbackLabel: '[media-engine] syncAllEmbeddedSurfaces failed:'
      }),
      refreshWindowBounds: () => refreshCurrentWindowBounds(),
      setCurrentWindowBounds: (bounds) => {
        currentWindowBounds = bounds || null;
      },
      getCurrentWindowBounds: () => currentWindowBounds,
      getHostPreviewState: () => ({
        nativeHostPreviewEnabled,
        nativeHostSessionRunning,
        hostPreviewRequested: nativeSessionState.getHostPreviewRequested()
      }),
      isHostPreviewAttached: () => hostPreviewSurfaceAttached,
      setHostPreviewAttached: (attached) => {
        hostPreviewSurfaceAttached = Boolean(attached);
      },
      hideLegacyVideoElements: () => hideLegacyVideoElements(),
      isBlockingModalVisible,
      shouldReserveViewerFullscreenUnderbarSpace: () => nativeViewerFullscreenControls.shouldReserveUnderbarSpace()
    });
  const nativeRoomMessages = nativeEntry.createRequired('nativeRoomMessages', 'createController', 'native-room-message-controller-unavailable', {
      roomClient,
      elements,
      p2pStateMachine,
      nativeSessionState,
      syncRendererAppState: (reason, patch) => syncRendererAppState(reason, patch),
      updateViewerCount: (viewerId, leftPosition) => updateViewerCount(viewerId, leftPosition),
      closePeerConnection: (peerId, options) => nativePeerController.closePeerConnection(peerId, options),
      resetViewerState: () => resetViewerState(),
      clearAllRelayOfferRetries: () => clearAllRelayOfferRetries(),
      rememberMediaManifest: (mediaManifest) => rememberMediaManifest(mediaManifest),
      clearAllPeerConnections: (options) => clearAllPeerConnections(options),
      resetViewerFpsIndicator: () => nativeStatsController.resetViewerFpsIndicator(),
      setViewerRoomState: (state) => nativeRendererState.setViewerRoomState(state),
      markViewerRoomJoinedPending: () => nativeRendererState.markViewerRoomJoinedPending(),
      handleViewerJoinSucceeded: () => {
        if (typeof window.__vdsHandleViewerJoinSucceeded === 'function') {
          window.__vdsHandleViewerJoinSucceeded();
        }
      },
      renderViewerPlaybackPrefsUi: () => {
        if (typeof window.__vdsRenderViewerPlaybackPrefsUi === 'function') {
          window.__vdsRenderViewerPlaybackPrefsUi();
        }
      },
      setViewerConnectionState: (message) => nativeRendererState.setViewerConnectionState(message),
      setViewerConnectedState: () => nativeRendererState.setViewerConnectedState(),
      setViewerJoinedUi: (state) => nativeRendererState.setViewerJoinedUi(state),
      getViewerCount: () => nativeRendererState.getViewerCount(),
      setViewerCount: (count) => nativeRendererState.setViewerCount(count),
      getCurrentHostMediaSessionId: () => currentHostMediaSessionId,
      isNativeHostSessionRunning: () => nativeHostSessionRunning,
      isHost: () => isHost,
      logNativeStep: (event, payload, category) => nativeDiagnostics.logNativeStep(event, payload, category),
      getClientId: () => clientId,
      getCurrentSessionToken: () => currentSessionToken,
      isObsIngestHostBackend: () => isObsIngestHostBackend(),
      setHostRoomState: (state) => nativeRendererState.setHostRoomState(state),
      setHostRoomActiveUi: (state) => nativeRendererState.setHostRoomActiveUi(state),
      setSessionRoomState: (state) => nativeRendererState.setSessionRoomState(state),
      setViewerResumeState: (state) => nativeRendererState.setViewerResumeState(state),
      setIsHost: (value) => nativeRendererState.setIsHost(value),
      getHostId: () => hostId,
      getUpstreamPeerId: () => upstreamPeerId,
      getChainPosition: () => myChainPosition,
      isUpstreamConnected: () => upstreamConnected,
      resetShareStartPendingUi: () => {
        if (typeof window.__vdsResetShareStartPendingUi === 'function') {
          window.__vdsResetShareStartPendingUi();
        }
      },
      copyRoomIdToClipboard: typeof window.__vdsCopyRoomIdToClipboard === 'function'
        ? (payload) => window.__vdsCopyRoomIdToClipboard(payload)
        : null,
      renderHostPublicListingUi: () => {
        if (typeof window.__vdsRenderHostPublicListingUi === 'function') {
          window.__vdsRenderHostPublicListingUi();
        }
      },
      startHostStatsPolling: () => nativeStatsController.startHostStatsPolling(),
      isHostWaitingWindowRestore: () => hostWaitingWindowRestore,
      syncHostWaitingWindowRestoreUi: (waiting) => {
        hostWaitingWindowRestore = Boolean(waiting);
        nativeRendererState.syncHostWaitingWindowRestoreUi(hostWaitingWindowRestore, {
          obsIngestHostBackend: isObsIngestHostBackend()
        });
      },
      showError: (message) => showError(message)
    });
  const nativePeerController = nativeEntry.createRequired('nativePeer', 'createController', 'native-peer-controller-unavailable', {
      mediaEngine,
      surfaceController: nativeSurfaceController,
      roomClient,
      logNativeStep: (scope, payload, category) => nativeDiagnostics.logNativeStep(scope, payload, category),
      logRecoverableNativeWarning: (scope, error, options) => nativeDiagnostics.logRecoverableNativeWarning(scope, error, options),
      getPeerMeta: (peerId) => peerConnectionMeta.get(peerId) || null,
      setPeerMeta: (peerId, meta) => {
        peerConnectionMeta.set(peerId, meta);
        return meta;
      },
      getUpstreamPeerId: () => upstreamPeerId,
      getSessionRole: () => sessionRole,
      isHost: () => isHost,
      isNativeHostSessionRunning: () => nativeHostSessionRunning,
      getCurrentRoomId: () => currentRoomId,
      getCurrentMediaManifest: () => currentMediaManifest || null,

      armViewerMediaWaitTimer: (peerId) => p2pStateMachine.armViewerMediaWaitTimer(peerId),
      setP2pStateForPeer: (peerId, state) => p2pStateMachine.setP2pStateForPeer(peerId, state),
      clearViewerMediaWaitTimer: () => p2pStateMachine.clearViewerMediaWaitTimer(),
      clearViewerUpstreamOfferWaitTimer: () => p2pStateMachine.clearViewerUpstreamOfferWaitTimer(),
      resetViewerUpstreamOfferReconnectPeer: (peerId) => p2pStateMachine.resetViewerUpstreamOfferReconnectPeer(peerId),
      setViewerConnectionState: (message) => nativeRendererState.setViewerConnectionState(message),
      setPeerConnection: (peerId, handle) => peerConnections.set(peerId, handle),
      getPeerConnection: (peerId) => peerConnections.get(peerId) || null,
      deletePeerConnection: (peerId) => peerConnections.delete(peerId),
      deletePeerMeta: (peerId) => peerConnectionMeta.delete(peerId),
      renderP2pDiagnosticReport: () => renderP2pDiagnosticReport(),
      createOffer: (peerId, options) => createOffer(peerId, options),
      closePeerConnection: (peerId, options) => nativePeerController.closePeerConnection(peerId, options),
      getRecoveryRoomSnapshot: () => ({
        role: sessionRole,
        roomId: currentRoomId,
        clientId,
        sessionToken: currentSessionToken || '',
        chainPosition: myChainPosition
      })
    });
  const nativePeerMessages = nativeEntry.createRequired('nativePeerMessages', 'createController', 'native-peer-message-controller-unavailable', {
      roomClient,
      nativePeerController,
      diagnostics: nativeDiagnostics,
      rememberMediaManifest: (mediaManifest) => rememberMediaManifest(mediaManifest),
      isNativeHostSessionRunning: () => nativeHostSessionRunning,
      isHost: () => isHost,
      syncRendererAppState: (reason, patch) => syncRendererAppState(reason, patch),
      updateViewerCount: (viewerId) => updateViewerCount(viewerId),
      createOffer: (viewerId, options) => nativePeerController.createHostViewerOffer(viewerId, options),
      createOfferToNextViewer: (nextViewerId, caps) => nativePeerController.createRelayViewerOffer(nextViewerId, caps),
      closePeerConnection: (peerId, options) => nativePeerController.closePeerConnection(peerId, options),
      getHostId: () => hostId,
      getUpstreamPeerId: () => upstreamPeerId,
      getSessionRole: () => sessionRole,
      setUpstreamPeerId: (peerId) => nativeRendererState.setUpstreamPeerId(peerId),
      getCurrentRoomId: () => currentRoomId,
      getClientId: () => clientId,
      getCurrentSessionToken: () => currentSessionToken,
      setChainPosition: (chainPosition) => nativeRendererState.setChainPosition(chainPosition),
      getPeerConnection: (peerId) => peerConnections.get(peerId) || null,
      getCurrentMediaManifest: () => currentMediaManifest || null,
      setP2pStateForPeer: (peerId, state) => p2pStateMachine.setP2pStateForPeer(peerId, state),
      setViewerMediaState: (state) => nativeRendererState.setViewerMediaState(state),
      clearViewerMediaWaitTimer: () => p2pStateMachine.clearViewerMediaWaitTimer(),
      clearViewerUpstreamOfferWaitTimer: () => p2pStateMachine.clearViewerUpstreamOfferWaitTimer(),
      resetViewerUpstreamOfferReconnectPeer: (peerId) => p2pStateMachine.resetViewerUpstreamOfferReconnectPeer(peerId),
      setViewerConnectionState: (message) => nativeRendererState.setViewerConnectionState(message),
      setViewerJoinedUi: (state) => nativeRendererState.setViewerJoinedUi(state),
      getViewerCount: () => nativeRendererState.getViewerCount(),
      setViewerCount: (count) => nativeRendererState.setViewerCount(count),
      startViewerStatsPolling: () => nativeStatsController.startViewerStatsPolling(),
      recreatePeerForRemoteOffer: (peerId, decision, existingHandle, mediaManifest) => recreateNativePeerForRemoteOffer(peerId, decision, existingHandle, mediaManifest),
      markViewerChainReconnectPending: () => {
        nativeRendererState.markViewerChainReconnectPending();
        p2pStateMachine.clearViewerMediaWaitTimer();
        p2pStateMachine.clearViewerUpstreamOfferWaitTimer();
        nativeRendererState.setViewerConnectionState('正在重建上游连接...');
      }
    });
  const nativeSessionController = nativeEntry.createRequired('nativeSession', 'createController', 'native-session-controller-unavailable', {
      mediaEngine,
      getQualitySettings: () => qualitySettings || {},
      getCurrentHostBackend: () => nativeSessionState.getCurrentHostBackend(),
      getRequestedVideoCodec: () => (typeof getRequestedCodecPreference === 'function'
        ? getRequestedCodecPreference()
        : (qualitySettings.codecPreference || 'h264')),
      getCaptureEffectiveVideoCodec: () => (typeof getEffectiveCodecPreference === 'function'
        ? getEffectiveCodecPreference()
        : (qualitySettings.codecPreference || 'h264')),
      getEffectiveVideoCodec: () => nativeHostEffectiveCodec,
      getPublicRoomEnabled: () => Boolean(qualitySettings && qualitySettings.publicRoomEnabled),
      getMediaSessionId: () => currentHostMediaSessionId,
      setMediaSessionId: (mediaSessionId) => {
        currentHostMediaSessionId = String(mediaSessionId || '');
      },
      getHostStartGeneration: () => nativeHostStartGeneration,
      setHostStartGeneration: (generation) => {
        nativeHostStartGeneration = Number(generation) || 0;
      },
      setHostStartInFlight: (inFlight) => {
        nativeHostStartInFlight = Boolean(inFlight);
      },
      getStopShareInFlight: () => stopScreenShareInFlight,
      setStopShareInFlight: (inFlight) => {
        stopScreenShareInFlight = Boolean(inFlight);
      },
      setHostStopUiState: (stopping) => nativeRendererState.setHostStopUiState(stopping),
      setNativeHostSessionRunning: (running) => {
        nativeHostSessionRunning = Boolean(running);
      },
      setCurrentHostBackend: (backend) => {
        nativeSessionState.setCurrentHostBackend(backend);
      },
      setLocalStream: (stream) => {
        localStream = stream || null;
      },
      setHostWaitingWindowRestore: (waiting) => {
        hostWaitingWindowRestore = Boolean(waiting);
      },
      setObsIngestStreamActive: (active) => {
        nativeSessionState.setObsIngestStreamActive(active);
      },
      setNativeEffectiveCodec: (codec) => {
        if (typeof qualitySettings === 'object' && qualitySettings) {
          const effectiveCodec = nativeSessionController.normalizeVideoCodec(codec, qualitySettings.codecPreference || 'h264');
          qualitySettings.codecPreference = effectiveCodec;
          nativeHostEffectiveCodec = effectiveCodec;
        }
      },
      lockCodecUiToNativeH264: () => {
        if (typeof window.__vdsRefreshQualitySettingsUi === 'function') {
          window.__vdsRefreshQualitySettingsUi();
        }
      },
      setHostPreviewRequested: (requested) => {
        nativeSessionState.setHostPreviewRequested(requested);
      },
      hideLegacyVideoElements: () => hideLegacyVideoElements(),
      setHostPreviewElementHidden: (hidden) => nativeRendererState.setHostPreviewElementHidden(hidden),
      startHostStatsPolling: () => nativeStatsController.startHostStatsPolling(),
      setRoomInfoHidden: (hidden) => nativeRendererState.setRoomInfoHidden(hidden),
      setViewerCount: (count) => nativeRendererState.setViewerCount(count),
      setShareButtons: (sharing) => nativeRendererState.setShareButtons(sharing),
      setHostStatus: (text, waiting) => nativeRendererState.setHostStatus(text, waiting),
      syncHostWaitingWindowRestoreUi: (waiting, restoredText) => {
        hostWaitingWindowRestore = Boolean(waiting);
        nativeRendererState.syncHostWaitingWindowRestoreUi(hostWaitingWindowRestore, {
          restoredText: restoredText || '原生分享已恢复',
          obsIngestHostBackend: isObsIngestHostBackend()
        });
      },
      updateHostEncoderDetail: (pipeline, obsIngest) => nativeStatsController.updateHostEncoderDetail(pipeline || null, obsIngest || null),
      ensureObsHostRoomCreated: (obsIngest) => nativeSessionController.ensureObsHostRoomCreated(obsIngest || null, {
        clientId,
        timeoutMs: 5000
      }).catch((error) => {
        nativeSessionState.setObsRoomCreatePending(false);
        showError(error && error.message ? error.message : 'websocket-timeout');
      }),
      teardownObsHostRoom: (reason) => nativeSessionController.teardownObsHostRoom({ reason: reason || 'host-room-ended' }),
      logRecoverableNativeWarning: (scope, error, warningOptions) => nativeDiagnostics.logRecoverableNativeWarning(scope, error, warningOptions),
      stopHostStatsPolling: () => nativeStatsController.stopHostStatsPolling(),
      stopViewerStatsPolling: () => nativeStatsController.stopViewerStatsPolling(),
      detachHostPreviewSurface: () => nativeSurfaceController.detachHostPreviewSurface(),
      getPeerIds: () => nativePeerController.getPeerHandleIds(),
      closePeer: (peerId, options) => nativePeerController.closePeerConnection(peerId, options),
      logNativeStep: (event, payload, category) => nativeDiagnostics.logNativeStep(event, payload, category),
      logNativeDebug: (...args) => nativeDiagnostics.logNativeDebug(...args),
      ensureNativeUiReady: () => ensureNativeUiReady(),
      ensureMediaEngineStarted: () => nativeMediaEngineController.ensureStarted(),
      waitForHostUiReady: () => waitForHostUiReady(),
      refreshQualitySettingsUi: () => {
        if (typeof window.__vdsRefreshQualitySettingsUi === 'function') {
          window.__vdsRefreshQualitySettingsUi();
        }
      },
      attachHostPreviewSurface: () => nativeSurfaceController.attachHostPreviewSurface(),
      shouldRequestHostPreview: (backend) => shouldShowNativeHostPreviewForBackend(backend),
      showError: (message) => showError(message),
      waitForWsConnected: (timeoutMs) => waitForWsConnected(timeoutMs),
      sendHostCreateRoom: (message) => roomClient.createRoom(message),
      waitForHostRoomCreated: (request) => waitForHostRoomCreated(request),
      resetShareStartPendingUi: () => {
        if (typeof window.__vdsResetShareStartPendingUi === 'function') {
          window.__vdsResetShareStartPendingUi();
        }
      },
      setHostPreviewAttached: (attached) => {
        hostPreviewSurfaceAttached = Boolean(attached);
      },
      removeHostPreviewSurfaceTracking: (reason) => nativeSurfaceController.removeSurfaceTracking(HOST_PREVIEW_SURFACE_ID, reason || 'surface-sync-failed'),
      removeEmbeddedSurfaceTracking: (surfaceId, reason) => {
        if (surfaceId) {
          nativeSurfaceController.removeSurfaceTracking(surfaceId, reason || 'surface-sync-failed');
        }
      },
      resetFailedHostStartUi: () => resetHostUiAfterFailedStart(),
      markHostSessionStopped: () => markNativeHostSessionStopped(),
      getRoomSnapshot: () => ({
        role: sessionRole,
        roomId: currentRoomId,
        clientId,
        sessionToken: currentSessionToken || ''
      }),
      sendLeaveRoom: (snapshot) => roomClient.leaveRoom(snapshot),
      patchRendererState: (patch) => legacyAppStateBridge.applyPatch(patch),
      setCurrentMediaManifest: (mediaManifest) => {
        currentMediaManifest = mediaManifest || null;
      },
      syncRendererAppState: (reason, patch) => syncRendererAppState(reason, patch),
      setRelayStream: (stream) => {
        relayStream = stream || null;
      },
      clearViewerMediaWaitTimer: () => p2pStateMachine.clearViewerMediaWaitTimer(),
      clearViewerUpstreamOfferWaitTimer: () => p2pStateMachine.clearViewerUpstreamOfferWaitTimer(),
      resetViewerUpstreamOfferReconnectPeer: () => p2pStateMachine.resetViewerUpstreamOfferReconnectPeer(),
      resetHostFpsIndicators: () => nativeStatsController.resetHostFpsIndicators(),
      setHostPreviewRequestedForBackend: (backend) => nativeSessionState.setHostPreviewRequested(shouldShowNativeHostPreviewForBackend(backend)),
      resetStoppedRoomUi: (options) => nativeRendererState.resetStoppedRoomUi(options),
      resetObsRoomUiWaitingForStream: () => nativeRendererState.resetObsRoomUiWaitingForStream(),
      canCreateObsHostRoom: () => isHost && nativeHostSessionRunning && isObsIngestHostBackend(),
      hasActiveObsHostRoomOrPending: () => Boolean(currentRoomId || nativeSessionState.getObsRoomCreatePending()),
      setObsRoomCreatePending: (pending) => {
        nativeSessionState.setObsRoomCreatePending(pending);
      },
      setObsCreatingRoomUi: () => nativeRendererState.setObsCreatingRoomUi(),
      buildObsHostMediaManifest: (obsIngest) => (obsIngest
        ? nativeSessionController.buildHostMediaManifestFromObsIngest(obsIngest)
        : nativeSessionController.buildHostMediaManifestFromStats(nativeDiagnostics.getLatestP2pStatsSnapshot())),
      rememberMediaManifest: (mediaManifest) => rememberMediaManifest(mediaManifest)
    });
  function isBlockingModalVisible() {
    return Boolean(document.querySelector('.modal:not(.hidden)'));
  }
  function onEmbeddedSurfaceTrackingRemoved(surfaceId, reason = 'surface-sync-failed') {
    if (surfaceId === HOST_PREVIEW_SURFACE_ID) {
      hostPreviewSurfaceAttached = false;
    }
    if (nativeDiagnostics.shouldShowDebugLogsFor('video', 'nativeSteps')) {
      nativeDiagnostics.logNativeStep('surface-tracking:removed', { surfaceId, reason }, 'video');
    }
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

  function isObsIngestHostBackend(backend = nativeSessionState.getCurrentHostBackend()) {
    return normalizeHostBackendName(backend) === 'obs-ingest';
  }

  function shouldShowNativeHostPreviewForBackend(backend = nativeSessionState.getCurrentHostBackend()) {
    return !isObsIngestHostBackend(backend) &&
      nativeHostPreviewEnabled &&
      !(typeof qualitySettings === 'object' && qualitySettings && qualitySettings.previewEnabled === false);
  }

  function rememberMediaManifest(mediaManifest) {
    if (mediaManifest && typeof mediaManifest === 'object') {
      currentMediaManifest = mediaManifest;
      syncRendererAppState('media-manifest-updated', { mediaManifest: currentMediaManifest });
    }
  }

  function syncRendererAppState(reason, overrides = {}) {
    return appStateSyncBridge.sync(reason, overrides);
  }

  async function waitForHostUiReady() {
    if (!hostVideoContainer) {
      return;
    }
    await waitForNextPaint();
    hostVideoContainer.getBoundingClientRect();
    await waitForNextPaint();
  }

  function resetHostUiAfterFailedStart() {
    nativeHostSessionRunning = false;
    hostWaitingWindowRestore = false;
    nativeSessionState.setObsRoomCreatePending(false);
    nativeSessionState.setObsIngestStreamActive(false);
    nativeSessionState.setCurrentHostBackend(getRequestedHostBackend());
    hostPreviewSurfaceAttached = false;
    nativeStatsController.stopHostStatsPolling();
    nativeStatsController.resetHostFpsIndicators();
    nativeStatsController.updateHostEncoderDetail(null);
    hideLegacyVideoElements();
    const hostPreviewRequested = nativeSessionState.setHostPreviewRequested(shouldShowNativeHostPreviewForBackend(nativeSessionState.getCurrentHostBackend()));
    nativeRendererState.resetHostReadyUi({ hostPreviewRequested });
  }

  function markNativeHostSessionStopped() {
    nativeHostSessionRunning = false;
    hostWaitingWindowRestore = false;
    nativeSessionState.setObsRoomCreatePending(false);
    nativeSessionState.setObsIngestStreamActive(false);
    nativeSessionState.setCurrentHostBackend(getRequestedHostBackend());
  }


  async function ensureNativeUiReady() {
    if (nativeUiReadyPromise) {
      await nativeUiReadyPromise;
    }
  }

  function isNativePeerDriverActive() {
    return nativeEntry && typeof nativeEntry.isNativePeerDriverActive === 'function'
      ? nativeEntry.isNativePeerDriverActive()
      : nativePeerTransportEnabled;
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

  function getP2pStatusElementForPeer(peerId) {
    const handle = nativePeerController.getPeerHandle(peerId);
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

  function buildP2pDiagnosticReport() {
    const activeStatus = isHost
      ? (elements.hostP2pStatus && elements.hostP2pStatus.textContent)
      : (elements.viewerP2pStatus && elements.viewerP2pStatus.textContent);
    const latestP2pStatsSnapshot = nativeDiagnostics.getLatestP2pStatsSnapshot();
    const statsPeers = Array.isArray(latestP2pStatsSnapshot && latestP2pStatsSnapshot.peers)
      ? latestP2pStatsSnapshot.peers
      : [];
    const diagnosticPeers = nativePeerController.buildPeerDiagnosticEntries(statsPeers);
    return nativeDiagnostics.buildP2pDiagnosticReport({
        role: sessionRole || (isHost ? 'host' : 'viewer'),
        roomId: currentRoomId,
        clientId,
        p2pStatus: activeStatus,
        upstreamPeerId,
        hostId,
        chainPosition: myChainPosition,
        mediaManifest: currentMediaManifest,
        connected: upstreamConnected,
        videoStarted,
        natMappingAvailable: Boolean(mediaEngine && typeof mediaEngine.openNatMapping === 'function'),
        showHealthyPeerDetails: nativeDiagnostics.shouldShowDebugLogsFor('p2p', 'periodicStats') || verboseNativeLogs,
        peers: diagnosticPeers
    });
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

  function renderHostCaptureDiagnosticReport() {
    if (elements.hostCaptureDiagnosticOutput) {
      elements.hostCaptureDiagnosticOutput.textContent = nativeDiagnostics.getLatestHostCaptureDiagnosticReport();
    }
  }

  function waitForHostRoomCreated(request = {}) {
    const expectedMediaSessionId = String(request.mediaSessionId || '').trim();
    const timeoutMs = Math.max(1000, Number(request.timeoutMs || 5000) || 5000);
    if (!roomClient || typeof roomClient.waitForMessage !== 'function') {
      return Promise.reject(new Error('room-client-wait-message-unavailable'));
    }
    return Promise.race([
      roomClient.waitForMessage('room-created', (data) => {
        const ackMediaSessionId = data && data.mediaManifest && data.mediaManifest.mediaSessionId
          ? String(data.mediaManifest.mediaSessionId).trim()
          : '';
        return !expectedMediaSessionId || !ackMediaSessionId || ackMediaSessionId === expectedMediaSessionId;
      }, timeoutMs),
      roomClient.waitForMessage('error', () => true, timeoutMs).then((data) => {
        const code = data && data.code ? String(data.code) : 'server-error';
        throw new Error(`native-host-room-create-failed:${code}`);
      })
    ]).catch((error) => {
      if (error && String(error.message || '').includes('room-client-wait-message-timeout')) {
        throw new Error('native-host-room-create-timeout');
      }
      throw error;
    });
  }

  async function startScreenShareWithSource(sourceId) {
    await nativeSessionController.runNativeCaptureHostStart(sourceId, {
      nativeHostSessionEnabled,
      nativeHostPreviewEnabled,
      clientId
    });
  }

  async function startScreenShareWithObsIngest(options = {}) {
    await nativeSessionController.runObsIngestHostStart({
      ...(options || {}),
      nativeHostSessionEnabled
    });
  }

  async function startScreenShareWithAudio(sourceId, audioPid) {
    await nativeSessionController.runNativeCaptureHostStartWithAudio(sourceId, audioPid, {
      nativeHostSessionEnabled,
      nativeHostPreviewEnabled,
      clientId
    });
  }

  async function stopScreenShare(context = {}) {
    await nativeSessionController.runStopShare({
      event: context && context.event,
      peerCount: nativePeerController.getPeerHandleCount(),
      hasRoom: Boolean(currentRoomId),
      sessionRole
    });
  }

  function createPeerConnection(peerId, isInitiator, kind = 'direct', options = {}) {
    if (!isNativePeerDriverActive()) {
      throw new Error('native-peer-transport-disabled');
    }

    return nativePeerController.createPeerConnection(peerId, isInitiator, kind, {
      encodedMediaDataChannel: options.encodedMediaDataChannel !== false,
      mediaManifest: options.mediaManifest || currentMediaManifest || null
    });
  }

  async function createOffer(viewerId, options = {}) {
    return nativePeerController.createHostViewerOffer(viewerId, options);
  }

  async function createOfferToNextViewer(nextViewerId, nextViewerMediaCapabilities) {
    return nativePeerController.createRelayViewerOffer(nextViewerId, nextViewerMediaCapabilities);
  }

  function scheduleRelayOfferRetry(nextViewerId, error) {
    return nativePeerMessages.scheduleRelayOfferRetry(nextViewerId, error);
  }

  function clearAllRelayOfferRetries() {
    return nativePeerMessages.clearAllRelayOfferRetries();
  }

  async function recreateNativePeerForRemoteOffer(peerId, decision, existingHandle, mediaManifest) {
    const result = await nativePeerController.recreatePeerForRemoteOffer(peerId, decision || {}, {
      existingHandle,
      kind: 'upstream',
      mediaManifest
    });
    return result && result.handle;
  }

  async function handleOffer(data) {
    return nativePeerMessages.handleOfferMessage(data);
  }

  async function handleAnswer(data) {
    return nativePeerMessages.handleAnswerMessage(data);
  }

  async function handleIceCandidate(data) {
    return nativePeerMessages.handleIceCandidateMessage(data);
  }

  async function closePeerConnection(peerId, options = {}) {
    if (!isNativePeerDriverActive()) {
      throw new Error('native-peer-transport-disabled');
    }

    return nativePeerController.closePeerConnection(peerId, options);
  }

  async function clearAllPeerConnections(options = {}) {
    if (!isNativePeerDriverActive()) {
      throw new Error('native-peer-transport-disabled');
    }

    return nativePeerController.closeAllPeers({ options });
  }

  async function handleMessage(data) {
    nativeDiagnostics.logNativeDebug('connection', 'Received:', data.type);
    return false;
  }

  async function initializeNativeUi() {
    nativeDiagnostics.logNativeStep('initializeNativeUi:config', {
      nativePeerTransportEnabled,
      nativeHostSessionEnabled,
      nativeHostPreviewEnabled,
      nativeSurfaceEmbeddingEnabled,
      verboseNativeLogs
    });
    if (typeof window.__vdsRefreshQualitySettingsUi === 'function') {
      window.__vdsRefreshQualitySettingsUi();
    }
    hideLegacyVideoElements();

    nativeViewerControls.applyVolumeUi(100);
    nativeViewerFullscreenControls.bindViewerEvents({
      onMuteToggleError: (error) => nativeDiagnostics.logRecoverableNativeWarning('viewer-volume:mute-toggle-failed', error, {
        key: 'viewer-volume-mute-toggle',
        category: 'audio',
        channel: 'nativeSteps',
        fallbackLabel: '[media-engine] mute toggle failed:'
      }),
      onExitFullscreenError: (error) => nativeDiagnostics.logRecoverableNativeWarning('viewer-fullscreen:exit-failed', error, {
        key: 'viewer-fullscreen-exit',
        category: 'video',
        channel: 'nativeSteps',
        fallbackLabel: '[media-engine] viewer fullscreen exit failed:'
      }),
      onEscapeError: (error) => nativeDiagnostics.logRecoverableNativeWarning('fullscreen-escape:failed', error, {
        key: 'fullscreen-escape',
        category: 'video',
        channel: 'nativeSteps',
        fallbackLabel: '[media-engine] fullscreen escape failed:'
      })
    });

    nativeSessionController.bindHostControlEvents({
      stopShareButton: elements.btnStopShare,
      isHostSessionRunning: () => nativeHostSessionRunning,
      onStopShare: (context) => stopScreenShare(context),
      onStopShareError: (error) => {
        nativeDiagnostics.logNativeDebug('video', '[media-engine] stopScreenShare failed:', error && error.message ? error.message : String(error));
        showError(`停止共享失败：${error && error.message ? error.message : String(error)}`);
      }
    });

    await nativeSurfaceController.bindLayoutEvents();

    nativeDiagnostics.bindMediaEngineEvents(mediaEngine, {
      onEvent: (event) => nativeMediaEngineController.handleEvent(event)
    });

    await nativeMediaEngineController.ensureStarted();
  }

  const legacyGlobalBindings = {
    isNativePeerDriverActive,
    isNativePeerHandle: (handle) => nativePeerController.isNativePeerHandle(handle),
    startScreenShareWithSource,
    startScreenShareWithObsIngest,
    startScreenShareWithAudio,
    stopScreenShare,
    createPeerConnection,
    createOffer,
    createOfferToNextViewer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    closePeerConnection,
    clearAllPeerConnections,
    handleMessage,
    setViewerConnectionState: (message) => nativeRendererState.setViewerConnectionState(message),
    __vdsClearNativePendingRemoteCandidates: () => nativePeerController.clearAllPendingRemoteCandidates(),
    __vdsBuildP2pDiagnosticReport: buildP2pDiagnosticReport,
    __vdsRenderP2pDiagnosticReport: renderP2pDiagnosticReport,
    __vdsBuildHostCaptureDiagnosticReport: () => nativeDiagnostics.getLatestHostCaptureDiagnosticReport(),
    __vdsRenderHostCaptureDiagnosticReport: renderHostCaptureDiagnosticReport,
    __vdsGetCurrentHostMediaSessionId: () => currentHostMediaSessionId,
    __vdsEnsureCurrentHostMediaSessionId: () => nativeSessionController.ensureMediaSessionId()
  };
  nativeRoomMessages.registerHandlers();
  nativePeerMessages.registerHandlers();
  nativeUiReadyPromise = initializeNativeUi();

  nativeUiReadyPromise.catch((error) => {
    console.error('[media-engine] native override init failed:', error);
    showError(`Native init failed: ${error && error.message ? error.message : String(error)}`);
  });

  return legacyGlobalBindings;
};

if (window.VDS && window.VDS.nativeEntry && typeof window.VDS.nativeEntry.installLegacyOverrides === 'function') {
  window.VDS.nativeEntry.installLegacyOverrides(installNativeAuthorityOverrides);
}
