(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativePeerMessages) {
    return;
  }

  function createController(options = {}) {
    const roomClient = options.roomClient || null;
    const nativePeerController = options.nativePeerController || null;
    const diagnostics = options.diagnostics || null;

    async function callRequired(name, ...args) {
      const handler = options[name];
      if (typeof handler !== 'function') {
        throw new Error(`${name}-unavailable`);
      }
      return handler(...args);
    }

    function callOptional(name, ...args) {
      const handler = options[name];
      if (typeof handler === 'function') {
        return handler(...args);
      }
      return undefined;
    }

    function isStaleNativePeerError(error) {
      return nativePeerController && typeof nativePeerController.isStaleNativePeerError === 'function'
        ? nativePeerController.isStaleNativePeerError(error)
        : false;
    }

    function logNativeStep(scope, payload, category) {
      if (diagnostics && typeof diagnostics.logNativeStep === 'function') {
        diagnostics.logNativeStep(scope, payload, category);
      }
    }

    function logRecoverableNativeWarning(scope, error, details) {
      if (diagnostics && typeof diagnostics.logRecoverableNativeWarning === 'function') {
        diagnostics.logRecoverableNativeWarning(scope, error, details);
      }
    }

    function rememberMediaManifest(mediaManifest) {
      callOptional('rememberMediaManifest', mediaManifest);
    }

    function isHost() {
      return typeof options.isHost === 'function' ? Boolean(options.isHost()) : false;
    }

    function isNativeHostSessionRunning() {
      return typeof options.isNativeHostSessionRunning === 'function'
        ? Boolean(options.isNativeHostSessionRunning())
        : false;
    }

    function syncRendererAppState(reason, patch) {
      callOptional('syncRendererAppState', reason, patch);
    }

    function updateViewerCount(viewerId) {
      callOptional('updateViewerCount', viewerId);
    }

    function getViewerCount() {
      return Math.max(0, Number(callOptional('getViewerCount')) || 0);
    }

    function getOptionValue(name, fallback = null) {
      return typeof options[name] === 'function' ? options[name]() : fallback;
    }

    function getSessionRole() {
      const role = getOptionValue('getSessionRole', '');
      return typeof role === 'string' ? role : '';
    }

    function getPeerConnection(peerId) {
      return typeof options.getPeerConnection === 'function' ? options.getPeerConnection(peerId) : null;
    }

    function getCurrentMediaManifest() {
      return typeof options.getCurrentMediaManifest === 'function' ? options.getCurrentMediaManifest() : null;
    }

    function sendViewerReconnectReady(optionsForReconnect = {}) {
      if (roomClient && typeof roomClient.sendViewerReconnectReady === 'function') {
        return roomClient.sendViewerReconnectReady(optionsForReconnect);
      }
      throw new Error('room-client-viewer-reconnect-unavailable');
    }

    async function closePeerConnection(peerId, closeOptions) {
      if (typeof options.closePeerConnection === 'function') {
        return options.closePeerConnection(peerId, closeOptions);
      }
      return null;
    }

    function scheduleRelayOfferRetry(peerId, error) {
      if (!peerId || getSessionRole() !== 'viewer' || isHost()) {
        return;
      }
      if (error && error.nonRetryableRelay) {
        nativePeerController.clearPeerReconnect(peerId);
        logRecoverableNativeWarning('relay:connect-to-next-failfast', error, {
          key: `relay-connect-failfast:${peerId}`,
          category: 'connection',
          channel: 'nativeSteps',
          fallbackLabel: `[media-engine relay] failfast connect-to-next: ${peerId}`
        });
        return;
      }

      const existing = nativePeerController.getPeerReconnectState(peerId);
      const nextAttempt = Number(existing.attempts || 0) + 1;
      if (nextAttempt > 2) {
        nativePeerController.clearPeerReconnect(peerId);
        logRecoverableNativeWarning('relay:connect-to-next-exhausted', error, {
          key: `relay-connect-exhausted:${peerId}`,
          category: 'connection',
          channel: 'nativeSteps',
          fallbackLabel: `[media-engine relay] exhausted connect-to-next retries: ${peerId}`
        });
        return;
      }

      nativePeerController.schedulePeerReconnect(peerId, nextAttempt, undefined, async (retryPeerId) => {
        if (getSessionRole() !== 'viewer' || isHost() || !getOptionValue('getCurrentRoomId', '') || !getOptionValue('getUpstreamPeerId', '')) {
          return;
        }
        try {
          await callRequired('createOfferToNextViewer', retryPeerId);
        } catch (retryError) {
          scheduleRelayOfferRetry(retryPeerId, retryError);
        }
      });
    }

    function clearAllRelayOfferRetries() {
      nativePeerController.clearAllPeerReconnects();
    }

    function closeStaleViewerUpstreamPeers(activePeerId) {
      if (isHost() || !activePeerId) {
        return;
      }
      nativePeerController.scheduleStalePeerCleanup(activePeerId, {
        delayMs: 250,
        isPeerActive: (peerId) => peerId === getOptionValue('getUpstreamPeerId', ''),
        closePeer: (peerId) => {
          closePeerConnection(peerId, { clearRetryState: true }).catch(() => {});
        }
      });
    }

    function applyQueuedRemoteCandidateFlushResult(peerId, result) {
      nativePeerController.applyQueuedRemoteCandidateFlushResult(peerId, result);
    }

    function applyRemoteIceCandidateEffects(effects) {
      nativePeerController.applyRemoteIceCandidateEffects(effects);
    }

    function applyViewerUpstreamSwitch(switchDecision) {
      if (!switchDecision) {
        return;
      }
      if (switchDecision.shouldUpdateUpstream) {
        callOptional('setUpstreamPeerId', switchDecision.nextUpstreamPeerId);
      }
      if (!switchDecision.resetViewerState) {
        return;
      }
      callOptional('setViewerMediaState', {
        upstreamConnected: false,
        viewerReadySent: false,
        videoStarted: false
      });
      if (switchDecision.clearMediaWaitTimer) {
        callOptional('clearViewerMediaWaitTimer');
      }
      if (switchDecision.clearOfferWaitTimer) {
        callOptional('clearViewerUpstreamOfferWaitTimer');
      }
      if (switchDecision.connectionLabel) {
        callOptional('setViewerConnectionState', switchDecision.connectionLabel);
      }
    }

    async function handleViewerJoinedMessage(data) {
      rememberMediaManifest(data && data.mediaManifest);
      if (!isNativeHostSessionRunning()) {
        throw new Error('native-host-session-not-running');
      }
      if (!(data && data.reconnect)) {
        if (Number.isFinite(Number(data && data.viewerCount))) {
          const viewerCount = Math.max(0, Number(data.viewerCount) || 0);
          callOptional('setViewerCount', viewerCount);
          syncRendererAppState('viewer-joined-count', { viewerCount });
        } else {
          updateViewerCount(data && data.viewerId);
          syncRendererAppState('viewer-joined-count', { viewerCount: getViewerCount() });
        }
      }
      try {
        await callRequired('createOffer', data && data.viewerId, {
          force: Boolean(data && data.reconnect),
          viewerMediaCapabilities: data && data.viewerMediaCapabilities
        });
      } catch (error) {
        if (!isStaleNativePeerError(error)) {
          throw error;
        }
        logNativeStep('viewer-joined:stale-offer-ignored', {
          viewerId: data && data.viewerId,
          message: error && error.message ? error.message : String(error)
        }, 'connection');
      }
    }

    async function handleConnectToNextMessage(data) {
      try {
        rememberMediaManifest(data && data.mediaManifest);
        await callRequired('createOfferToNextViewer', data && data.nextViewerId, data && data.nextViewerMediaCapabilities);
      } catch (error) {
        const nextViewerId = data && data.nextViewerId;
        logRecoverableNativeWarning('relay:connect-to-next-failed', error, {
          key: `relay-connect-failed:${nextViewerId}`,
          category: 'connection',
          channel: 'nativeSteps',
          fallbackLabel: `[media-engine relay] connect-to-next failed: ${nextViewerId}`
        });
        await closePeerConnection(nextViewerId, { clearRetryState: true }).catch(() => {});
        scheduleRelayOfferRetry(nextViewerId, error);
      }
    }

    async function handleChainReconnectMessage(data) {
      clearAllRelayOfferRetries();
      rememberMediaManifest(data && data.mediaManifest);
      const chainPosition = data && data.newChainPosition;
      callOptional('setChainPosition', chainPosition);
      const hostId = getOptionValue('getHostId', '');
      const nextUpstreamPeerId = (data && data.upstreamPeerId) || hostId;
      const currentUpstreamPeer = nextUpstreamPeerId ? getPeerConnection(nextUpstreamPeerId) : null;
      const alreadySwitchingToRequestedUpstream =
        nextUpstreamPeerId &&
        getOptionValue('getUpstreamPeerId', '') === nextUpstreamPeerId &&
        currentUpstreamPeer &&
        ['new', 'connecting', 'connected'].includes(currentUpstreamPeer.connectionState);
      callOptional('setUpstreamPeerId', nextUpstreamPeerId);
      syncRendererAppState('chain-reconnect', {
        hostId,
        upstreamPeerId: nextUpstreamPeerId,
        chainPosition
      });
      if (!alreadySwitchingToRequestedUpstream) {
        callOptional('markViewerChainReconnectPending');
      }
      const currentRoomId = getOptionValue('getCurrentRoomId', '');
      if (currentRoomId && nextUpstreamPeerId) {
        await sendViewerReconnectReady({
          roomId: currentRoomId,
          clientId: getOptionValue('getClientId', ''),
          sessionToken: getOptionValue('getCurrentSessionToken', '') || '',
          chainPosition,
          upstreamPeerId: nextUpstreamPeerId
        });
      }
      callOptional('setViewerJoinedUi', {
        roomId: currentRoomId,
        chainPosition
      });
    }

    async function handleAnswerMessage(data) {
      const fromId = (data && data.fromClientId) || (data && data.targetId);
      const remoteAttemptId = nativePeerController.getSignalAttemptId(data);
      const remoteDescription = nativePeerController.normalizeSessionDescription(data && data.sdp);
      logNativeStep('signal:answer', {
        fromId,
        targetId: data && data.targetId,
        sdpLength: remoteDescription.sdp ? String(remoteDescription.sdp).length : 0
      });
      const peerId = getPeerConnection(fromId) ? fromId : data && data.targetId;
      const pc = getPeerConnection(peerId);
      if (!pc) {
        return;
      }
      const result = await nativePeerController.finalizeRemoteAnswer(peerId, remoteDescription, remoteAttemptId, getCurrentMediaManifest());
      if (result.action === 'ignore') {
        if (result.reason === 'stale-attempt') {
          logNativeStep('signal:answer:ignored', { peerId, attemptId: remoteAttemptId, reason: 'stale-attempt' }, 'connection');
        } else if (result.reason === 'stale-answer-without-local-offer') {
          logNativeStep('signal:answer:ignored', { peerId, reason: 'stale-answer-without-local-offer' });
        }
        return;
      }
      applyQueuedRemoteCandidateFlushResult(peerId, result.flushResult);
    }

    async function handleIceCandidateMessage(data) {
      const peerId = data && data.fromClientId;
      const remoteAttemptId = nativePeerController.getSignalAttemptId(data);
      if (!(data && data.candidate)) {
        return;
      }

      logNativeStep('signal:ice-candidate', {
        peerId,
        candidateLength: String(data.candidate || '').length
      });

      const result = await nativePeerController.finalizeRemoteIceCandidate(peerId, data.candidate, remoteAttemptId);
      applyRemoteIceCandidateEffects(result && result.effects);
    }

    async function handleOfferMessage(data) {
      try {
        const fromId = data && data.fromClientId;
        const remoteAttemptId = nativePeerController.getSignalAttemptId(data);
        const remoteDescription = nativePeerController.normalizeSessionDescription(data && data.sdp);
        callOptional('clearViewerUpstreamOfferWaitTimer');
        callOptional('resetViewerUpstreamOfferReconnectPeer', fromId);
        logNativeStep('signal:offer', {
          fromId,
          isHost: isHost(),
          sdpLength: remoteDescription.sdp ? String(remoteDescription.sdp).length : 0
        });

        const viewerUpstreamSwitch = nativePeerController.prepareViewerUpstreamSwitch({
          isHost: isHost(),
          currentUpstreamPeerId: getOptionValue('getUpstreamPeerId', ''),
          nextUpstreamPeerId: fromId
        });
        rememberMediaManifest(data && data.mediaManifest);
        applyViewerUpstreamSwitch(viewerUpstreamSwitch);

        let pc = getPeerConnection(fromId);
        let remoteOfferAppliedByController = false;
        const result = await nativePeerController.handleRemoteOffer(fromId, remoteDescription, remoteAttemptId, getCurrentMediaManifest());
        if (result.action === 'ignore') {
          if (result.reason === 'stale-attempt') {
            logNativeStep('signal:offer:ignored', { fromId, attemptId: remoteAttemptId, reason: 'stale-attempt' }, 'connection');
          }
          return;
        }
        if (result.action === 'flush') {
          pc = result.handle;
          const flushResult = await nativePeerController.flushQueuedRemoteCandidates(fromId, pc);
          applyQueuedRemoteCandidateFlushResult(fromId, flushResult);
          if (!isHost()) {
            callOptional('startViewerStatsPolling');
          }
          return;
        }
        if (result.recreatePeer) {
          pc = await callRequired('recreatePeerForRemoteOffer', fromId, result, pc, getCurrentMediaManifest());
        } else {
          pc = result.handle;
          remoteOfferAppliedByController = result.action === 'applied';
        }
        if (!remoteOfferAppliedByController) {
          await nativePeerController.applyRecreatedRemoteOffer(fromId, pc, remoteDescription, remoteAttemptId, getCurrentMediaManifest(), 'upstream');
        }
        if (!isHost()) {
          await nativePeerController.attachViewerRemoteOfferSurface(fromId);
        }
        const answerResult = await nativePeerController.flushQueuedAndCreateAnswer(fromId, pc, {
          roomId: getOptionValue('getCurrentRoomId', ''),
          timeoutMs: 15000
        });
        applyQueuedRemoteCandidateFlushResult(fromId, answerResult && answerResult.flushResult);
        if (!isHost()) {
          callOptional('startViewerStatsPolling');
          if (viewerUpstreamSwitch.staleCleanupRequired) {
            closeStaleViewerUpstreamPeers(fromId);
          }
        }
      } catch (error) {
        if (!isStaleNativePeerError(error)) {
          throw error;
        }
        logNativeStep('signal:offer:stale-ignored', {
          fromId: data && data.fromClientId,
          message: error && error.message ? error.message : String(error)
        }, 'connection');
      }
    }

    function registerHandlers() {
      if (!roomClient || typeof roomClient.registerMessageHandler !== 'function') {
        throw new Error('room-client-dispatcher-unavailable');
      }
      roomClient.registerMessageHandler('viewer-joined', handleViewerJoinedMessage);
      roomClient.registerMessageHandler('connect-to-next', handleConnectToNextMessage);
      roomClient.registerMessageHandler('chain-reconnect', handleChainReconnectMessage);
      roomClient.registerMessageHandler('answer', handleAnswerMessage);
      roomClient.registerMessageHandler('ice-candidate', handleIceCandidateMessage);
      roomClient.registerMessageHandler('offer', handleOfferMessage);
    }

    return {
      registerHandlers,
      handleViewerJoinedMessage,
      handleConnectToNextMessage,
      handleChainReconnectMessage,
      handleAnswerMessage,
      handleIceCandidateMessage,
      handleOfferMessage,
      scheduleRelayOfferRetry,
      clearAllRelayOfferRetries,
      closeStaleViewerUpstreamPeers
    };
  }

  VDS.nativePeerMessages = { createController };
})();
