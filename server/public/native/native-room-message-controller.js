(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeRoomMessages) {
    return;
  }

  function createController(options = {}) {
    const roomClient = options.roomClient || null;
    const elements = options.elements || {};
    const p2pStateMachine = options.p2pStateMachine || null;
    const nativeSessionState = options.nativeSessionState || null;

    function syncRendererAppState(reason, patch) {
      if (typeof options.syncRendererAppState === 'function') {
        options.syncRendererAppState(reason, patch);
      }
    }

    function callOptional(name, ...args) {
      const handler = options[name];
      if (typeof handler === 'function') {
        return handler(...args);
      }
      return undefined;
    }

    function updateViewerCount(viewerId, leftPosition) {
      if (typeof options.updateViewerCount === 'function') {
        options.updateViewerCount(viewerId, leftPosition);
      }
    }

    function getViewerCount() {
      return Math.max(0, Number(callOptional('getViewerCount')) || 0);
    }

    function showError(message) {
      if (typeof options.showError === 'function') {
        options.showError(message);
      }
    }

    function clearViewerUpstreamOfferWaitTimer() {
      if (p2pStateMachine && typeof p2pStateMachine.clearViewerUpstreamOfferWaitTimer === 'function') {
        p2pStateMachine.clearViewerUpstreamOfferWaitTimer();
      }
    }

    function clearViewerMediaWaitTimer() {
      if (p2pStateMachine && typeof p2pStateMachine.clearViewerMediaWaitTimer === 'function') {
        p2pStateMachine.clearViewerMediaWaitTimer();
      }
    }

    function armViewerUpstreamOfferWaitTimer(peerId) {
      if (p2pStateMachine && typeof p2pStateMachine.armViewerUpstreamOfferWaitTimer === 'function') {
        p2pStateMachine.armViewerUpstreamOfferWaitTimer(peerId);
      }
    }

    function setObsRoomCreatePending(pending) {
      if (nativeSessionState && typeof nativeSessionState.setObsRoomCreatePending === 'function') {
        nativeSessionState.setObsRoomCreatePending(Boolean(pending));
      }
    }

    function getObsIngestStreamActive() {
      return nativeSessionState && typeof nativeSessionState.getObsIngestStreamActive === 'function'
        ? Boolean(nativeSessionState.getObsIngestStreamActive())
        : false;
    }

    function getOptionValue(name, fallback = '') {
      return typeof options[name] === 'function' ? options[name]() : fallback;
    }

    function getBooleanOption(name, fallback = false) {
      return typeof options[name] === 'function' ? Boolean(options[name]()) : Boolean(fallback);
    }

    function logNativeStep(event, payload, category) {
      callOptional('logNativeStep', event, payload, category);
    }

    function sendLeaveRoom(optionsForLeave = {}) {
      if (roomClient && typeof roomClient.leaveRoom === 'function') {
        return roomClient.leaveRoom(optionsForLeave);
      }
      return false;
    }

    function isObsIngestHostBackend() {
      return typeof options.isObsIngestHostBackend === 'function' ? Boolean(options.isObsIngestHostBackend()) : false;
    }

    function getAckMediaSessionId(data) {
      return data && data.mediaManifest && typeof data.mediaManifest.mediaSessionId === 'string'
        ? data.mediaManifest.mediaSessionId.trim()
        : '';
    }

    function setHostWaitingOrStatus(text, waiting) {
      callOptional('setHostStatus', text, waiting);
    }

    function handleViewerCountUpdatedMessage(data) {
      const viewerCount = Math.max(0, Number(data && data.viewerCount) || 0);
      callOptional('setViewerCount', viewerCount);
      syncRendererAppState('viewer-count-updated', { viewerCount });
    }

    async function handleViewerLeftMessage(data) {
      if (Number.isFinite(Number(data && data.viewerCount))) {
        const viewerCount = Math.max(0, Number(data.viewerCount) || 0);
        callOptional('setViewerCount', viewerCount);
        syncRendererAppState('viewer-left-count', { viewerCount });
      } else {
        updateViewerCount(null, data && data.leftPosition);
        syncRendererAppState('viewer-left-count', { viewerCount: getViewerCount() });
      }
      if (typeof options.closePeerConnection === 'function') {
        await options.closePeerConnection(data && data.viewerId, { clearRetryState: true });
      }
    }

    async function handleHostDisconnectedMessage() {
      showError('分享者已断开连接');
      clearViewerUpstreamOfferWaitTimer();
      if (typeof options.resetViewerState === 'function') {
        await options.resetViewerState();
      }
    }

    async function handleErrorMessage(data) {
      setObsRoomCreatePending(false);
      if (typeof window.__vdsHandleViewerJoinError === 'function') {
        const handled = await window.__vdsHandleViewerJoinError(data);
        if (handled) {
          return;
        }
      }
      showError(data && data.message);
    }

    async function handleRoomJoinedMessage(data) {
      callOptional('clearAllRelayOfferRetries');
      callOptional('rememberMediaManifest', data && data.mediaManifest);
      if (typeof options.clearAllPeerConnections === 'function') {
        await options.clearAllPeerConnections({ clearRetryState: true });
      }
      callOptional('resetViewerFpsIndicator');
      const roomId = data && data.roomId;
      const sessionToken = data && data.sessionToken ? data.sessionToken : '';
      const chainPosition = data && data.chainPosition;
      const hostId = data && data.hostId;
      const upstreamPeerId = (data && data.upstreamPeerId) || hostId;
      callOptional('setViewerRoomState', {
        roomId,
        sessionToken,
        chainPosition,
        hostId,
        upstreamPeerId
      });
      syncRendererAppState('room-joined', {
        role: 'viewer',
        roomId,
        sessionToken,
        hostId,
        upstreamPeerId,
        chainPosition
      });
      callOptional('markViewerRoomJoinedPending');
      clearViewerMediaWaitTimer();
      armViewerUpstreamOfferWaitTimer(upstreamPeerId);
      callOptional('handleViewerJoinSucceeded');
      callOptional('setViewerJoinedUi', { roomId, chainPosition });
      callOptional('renderViewerPlaybackPrefsUi');
      callOptional('setViewerConnectionState', '等待上游连接...');
    }

    async function handleRoomCreatedMessage(data) {
      setObsRoomCreatePending(false);
      const ackMediaSessionId = getAckMediaSessionId(data);
      const currentHostMediaSessionId = getOptionValue('getCurrentHostMediaSessionId', '');
      const nativeHostSessionRunning = Boolean(getOptionValue('isNativeHostSessionRunning', false));
      if (!nativeHostSessionRunning || !currentHostMediaSessionId || !ackMediaSessionId || ackMediaSessionId !== currentHostMediaSessionId) {
        logNativeStep('room-created:stale-ignored', {
          roomId: data && data.roomId,
          mediaSessionId: ackMediaSessionId,
          currentMediaSessionId: currentHostMediaSessionId || '',
          nativeHostSessionRunning
        }, 'connection');
        if (data && data.roomId) {
          sendLeaveRoom({
            roomId: data.roomId,
            clientId: getOptionValue('getClientId', ''),
            sessionToken: data.sessionToken || '',
            sendOptions: { queueIfDisconnected: false }
          });
        }
        return;
      }
      callOptional('rememberMediaManifest', data && data.mediaManifest);
      if (isObsIngestHostBackend() && !getObsIngestStreamActive()) {
        sendLeaveRoom({
          roomId: data && data.roomId,
          clientId: getOptionValue('getClientId', ''),
          sessionToken: (data && data.sessionToken) || getOptionValue('getCurrentSessionToken', '') || '',
          sendOptions: { queueIfDisconnected: false }
        });
        setHostWaitingOrStatus('等待 OBS 推流...', true);
        return;
      }
      const sessionToken = data && data.sessionToken ? data.sessionToken : '';
      callOptional('setHostRoomState', { roomId: data && data.roomId, sessionToken });
      syncRendererAppState('room-created', {
        role: 'host',
        roomId: data && data.roomId,
        sessionToken,
        hostId: null,
        upstreamPeerId: null,
        chainPosition: -1,
        viewerCount: 0
      });
      callOptional('resetShareStartPendingUi');
      callOptional('setHostRoomActiveUi', { roomId: data && data.roomId });
      if (typeof options.copyRoomIdToClipboard === 'function') {
        options.copyRoomIdToClipboard({
          roomId: data && data.roomId,
          successMessage: '房间号已自动复制',
          showFailureToast: false
        }).catch((error) => {
          logNativeStep('room-created:auto-copy-room-id-failed', {
            roomId: data && data.roomId,
            message: error && error.message ? error.message : String(error)
          }, 'connection');
        });
      }
      callOptional('renderHostPublicListingUi');
      if (elements.hostP2pStatus && p2pStateMachine && typeof p2pStateMachine.setStatusElementState === 'function') {
        p2pStateMachine.setStatusElementState(elements.hostP2pStatus, 'waiting-viewer');
      }
      callOptional('startHostStatsPolling');
      if (Boolean(getOptionValue('isHostWaitingWindowRestore', false))) {
        callOptional('syncHostWaitingWindowRestoreUi', true);
      } else {
        setHostWaitingOrStatus(isObsIngestHostBackend() ? '正在共享（OBS）' : '原生分享已就绪', false);
      }
    }

    async function handleSessionResumedMessage(data) {
      const role = data && data.role;
      const roomId = data && data.roomId;
      const sessionToken = (data && data.sessionToken) || getOptionValue('getCurrentSessionToken', '') || '';
      callOptional('setSessionRoomState', { roomId, role, sessionToken });
      callOptional('rememberMediaManifest', data && data.mediaManifest);
      syncRendererAppState('session-resumed', {
        role,
        roomId,
        sessionToken,
        hostId: role === 'host' ? null : getOptionValue('getHostId', null),
        upstreamPeerId: role === 'host' ? null : getOptionValue('getUpstreamPeerId', null),
        chainPosition: role === 'host' ? -1 : getOptionValue('getChainPosition', -1),
        viewerCount: Math.max(0, Number(data && data.viewerCount) || 0)
      });
      if (role === 'host') {
        setObsRoomCreatePending(false);
        if (nativeSessionState && typeof nativeSessionState.setObsIngestStreamActive === 'function') {
          nativeSessionState.setObsIngestStreamActive(isObsIngestHostBackend() ? true : getObsIngestStreamActive());
        }
        callOptional('setIsHost', true);
        callOptional('setHostRoomActiveUi', {
          roomId,
          viewerCount: (data && data.viewerCount) || 0
        });
        callOptional('renderHostPublicListingUi');
        if (elements.hostP2pStatus && p2pStateMachine && typeof p2pStateMachine.setStatusElementState === 'function') {
          p2pStateMachine.setStatusElementState(elements.hostP2pStatus, 'waiting-viewer');
        }
        callOptional('startHostStatsPolling');
        if (getBooleanOption('isHostWaitingWindowRestore', false)) {
          callOptional('syncHostWaitingWindowRestoreUi', true);
        } else {
          setHostWaitingOrStatus(isObsIngestHostBackend() ? '正在共享（OBS）' : '原生分享已恢复', false);
        }
        return;
      }

      callOptional('setIsHost', false);
      callOptional('clearAllRelayOfferRetries');
      if (typeof options.clearAllPeerConnections === 'function') {
        await options.clearAllPeerConnections({ clearRetryState: true });
      }
      callOptional('resetViewerFpsIndicator');
      const hostId = (data && data.hostId) || getOptionValue('getHostId', null);
      const upstreamPeerId = (data && data.upstreamPeerId) || hostId;
      const chainPosition = data && data.chainPosition;
      callOptional('setViewerResumeState', { hostId, upstreamPeerId, chainPosition });
      syncRendererAppState('session-resumed-viewer', {
        role: 'viewer',
        roomId,
        sessionToken,
        hostId,
        upstreamPeerId,
        chainPosition
      });
      clearViewerMediaWaitTimer();
      armViewerUpstreamOfferWaitTimer(upstreamPeerId);
      callOptional('handleViewerJoinSucceeded');
      callOptional('setViewerJoinedUi', { roomId, chainPosition });
      callOptional('renderViewerPlaybackPrefsUi');
      if (!getBooleanOption('isUpstreamConnected', false)) {
        callOptional('setViewerConnectionState', '正在恢复上游连接...');
      } else {
        callOptional('setViewerConnectedState');
      }
    }

    function registerHandlers() {
      if (!roomClient || typeof roomClient.registerMessageHandler !== 'function') {
        throw new Error('room-client-dispatcher-unavailable');
      }
      roomClient.registerMessageHandler('viewer-count-updated', handleViewerCountUpdatedMessage);
      roomClient.registerMessageHandler('viewer-left', handleViewerLeftMessage);
      roomClient.registerMessageHandler('host-disconnected', handleHostDisconnectedMessage);
      roomClient.registerMessageHandler('error', handleErrorMessage);
      roomClient.registerMessageHandler('room-joined', handleRoomJoinedMessage);
      roomClient.registerMessageHandler('room-created', handleRoomCreatedMessage);
      roomClient.registerMessageHandler('session-resumed', handleSessionResumedMessage);
    }

    return {
      registerHandlers,
      handleViewerCountUpdatedMessage,
      handleViewerLeftMessage,
      handleHostDisconnectedMessage,
      handleErrorMessage,
      handleRoomJoinedMessage,
      handleRoomCreatedMessage,
      handleSessionResumedMessage
    };
  }

  VDS.nativeRoomMessages = { createController };
})();
