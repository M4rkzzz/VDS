(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeRendererState) {
    return;
  }

  function createController(options = {}) {
    function applyPatch(patch) {
      if (typeof options.applyPatch === 'function') {
        options.applyPatch(patch || {});
      }
    }

    function getElements() {
      return options.elements || {};
    }

    function getElement(name, fallbackId) {
      const elements = getElements();
      if (elements[name]) {
        return elements[name];
      }
      return fallbackId && typeof document !== 'undefined' ? document.getElementById(fallbackId) : null;
    }

    function setViewerConnectionState(message) {
      const elements = getElements();
      if (elements.waitingMessage) {
        elements.waitingMessage.classList.remove('hidden');
      }
      if (elements.connectionStatus) {
        elements.connectionStatus.textContent = message;
        elements.connectionStatus.classList.remove('connected');
      }
    }

    function setViewerConnectedState() {
      const elements = getElements();
      if (elements.connectionStatus) {
        elements.connectionStatus.textContent = '已连接';
        elements.connectionStatus.classList.add('connected');
      }
    }

    function setViewerJoinedUi(state = {}) {
      const elements = getElements();
      if (elements.joinForm) {
        elements.joinForm.classList.add('hidden');
      }
      if (elements.viewerStatus) {
        elements.viewerStatus.classList.remove('hidden');
      }
      if (elements.viewerRoomId) {
        elements.viewerRoomId.textContent = state.roomId || '';
      }
      if (elements.btnLeave) {
        elements.btnLeave.classList.remove('hidden');
      }
      if (elements.chainPosition) {
        elements.chainPosition.textContent = String((Number(state.chainPosition) || 0) + 1);
      }
    }

    function setHostStopUiState(stopping) {
      const elements = getElements();
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

    function syncHostWaitingWindowRestoreUi(waiting, optionsForSync = {}) {
      const elements = getElements();
      const restoredText = optionsForSync.restoredText || '原生分享已恢复';
      if (!elements.hostStatus) {
        return;
      }
      if (optionsForSync.obsIngestHostBackend) {
        elements.hostStatus.textContent = waiting ? '等待 OBS 推流...' : restoredText;
        elements.hostStatus.classList.toggle('waiting', Boolean(waiting));
        return;
      }
      if (waiting) {
        elements.hostStatus.textContent = '等待窗口恢复...';
        elements.hostStatus.classList.add('waiting');
        return;
      }
      elements.hostStatus.textContent = restoredText;
      elements.hostStatus.classList.remove('waiting');
    }

    function setHostPreviewContainerVisible(visible) {
      const elements = getElements();
      if (elements.hostVideoContainer) {
        elements.hostVideoContainer.classList.toggle('hidden', !visible);
      }
    }

    function setHostPreviewElementHidden(hidden) {
      setHostPreviewContainerVisible(!hidden);
    }

    function setRoomInfoHidden(hidden) {
      const elements = getElements();
      const roomInfo = elements.roomInfo || getElement('roomInfo', 'room-info');
      if (roomInfo) {
        roomInfo.classList.toggle('hidden', Boolean(hidden));
      }
    }

    function setViewerCount(count) {
      const elements = getElements();
      if (elements.viewerCount) {
        elements.viewerCount.textContent = String(Math.max(0, Number(count) || 0));
      }
    }

    function getViewerCount() {
      const elements = getElements();
      return Math.max(0, Number(elements.viewerCount && elements.viewerCount.textContent) || 0);
    }

    function setShareButtons(sharing) {
      const elements = getElements();
      if (elements.btnStartShare) {
        elements.btnStartShare.classList.toggle('hidden', Boolean(sharing));
      }
      if (elements.btnStopShare) {
        elements.btnStopShare.classList.toggle('hidden', !Boolean(sharing));
      }
    }

    function setHostStatus(text, waiting) {
      const elements = getElements();
      if (elements.hostStatus) {
        elements.hostStatus.textContent = text || '';
        elements.hostStatus.classList.toggle('waiting', Boolean(waiting));
      }
    }

    function setObsCreatingRoomUi() {
      setHostStatus('OBS 节目流已接入，正在创建房间...', true);
    }

    function setHostRoomActiveUi(state = {}) {
      const elements = getElements();
      const roomIdDisplay = elements.roomIdDisplay || getElement('roomIdDisplay', 'room-id-display');
      if (roomIdDisplay) {
        roomIdDisplay.textContent = state.roomId || '';
      }
      setRoomInfoHidden(false);
      if (Object.prototype.hasOwnProperty.call(state, 'viewerCount')) {
        setViewerCount(state.viewerCount);
      }
      setShareButtons(true);
      if (Object.prototype.hasOwnProperty.call(state, 'statusText')) {
        setHostStatus(state.statusText, Boolean(state.waiting));
      }
    }

    function resetHostReadyUi(optionsForReset = {}) {
      const elements = getElements();
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
      setHostPreviewContainerVisible(Boolean(optionsForReset.hostPreviewRequested));
    }

    function resetStoppedRoomUi(optionsForReset = {}) {
      setRoomInfoHidden(true);
      setViewerCount(0);
      resetHostReadyUi(optionsForReset);
    }

    function resetObsRoomUiWaitingForStream() {
      setRoomInfoHidden(true);
      setViewerCount(0);
      const elements = getElements();
      if (elements.btnStartShare) {
        elements.btnStartShare.classList.add('hidden');
      }
      if (elements.btnStopShare) {
        elements.btnStopShare.classList.remove('hidden');
      }
      setHostStatus('等待 OBS 推流...', true);
    }

    function setViewerMediaState(state = {}) {
      const patch = {
        upstreamConnected: Boolean(state.upstreamConnected),
        videoStarted: Boolean(state.videoStarted)
      };
      if (Object.prototype.hasOwnProperty.call(state, 'viewerReadySent')) {
        patch.viewerReadySent = Boolean(state.viewerReadySent);
      }
      applyPatch(patch);
    }

    function markViewerRoomJoinedPending() {
      applyPatch({
        viewerReadySent: false,
        videoStarted: false,
        upstreamConnected: false
      });
    }

    function setViewerRoomState(state = {}) {
      applyPatch({
        currentRoomId: state.roomId,
        sessionRole: 'viewer',
        currentSessionToken: state.sessionToken || '',
        myChainPosition: state.chainPosition,
        hostId: state.hostId,
        upstreamPeerId: state.upstreamPeerId
      });
    }

    function setHostRoomState(state = {}) {
      applyPatch({
        currentRoomId: state.roomId,
        sessionRole: 'host',
        currentSessionToken: state.sessionToken || ''
      });
      setHostRoomActiveUi({ roomId: state.roomId });
    }

    function setSessionRoomState(state = {}) {
      applyPatch({
        currentRoomId: state.roomId,
        sessionRole: state.role,
        currentSessionToken: state.sessionToken
      });
    }

    function setViewerResumeState(state = {}) {
      applyPatch({
        hostId: state.hostId,
        upstreamPeerId: state.upstreamPeerId || state.hostId,
        myChainPosition: state.chainPosition
      });
    }

    function setIsHost(value) {
      applyPatch({ isHost: Boolean(value) });
    }

    function setUpstreamPeerId(peerId) {
      applyPatch({ upstreamPeerId: peerId || '' });
    }

    function setChainPosition(chainPosition) {
      applyPatch({ myChainPosition: chainPosition });
    }

    function markViewerChainReconnectPending() {
      applyPatch({
        upstreamConnected: false,
        viewerReadySent: false,
        videoStarted: false
      });
    }

    return {
      setViewerConnectionState,
      setViewerConnectedState,
      setViewerJoinedUi,
      setHostStopUiState,
      syncHostWaitingWindowRestoreUi,
      setHostPreviewContainerVisible,
      setHostPreviewElementHidden,
      setRoomInfoHidden,
      setViewerCount,
      getViewerCount,
      setShareButtons,
      setHostStatus,
      setObsCreatingRoomUi,
      setHostRoomActiveUi,
      resetHostReadyUi,
      resetStoppedRoomUi,
      resetObsRoomUiWaitingForStream,
      setViewerMediaState,
      markViewerRoomJoinedPending,
      setViewerRoomState,
      setHostRoomState,
      setSessionRoomState,
      setViewerResumeState,
      setIsHost,
      setUpstreamPeerId,
      setChainPosition,
      markViewerChainReconnectPending
    };
  }


  function createLegacyAppStateBridge(options = {}) {
    const setters = options.setters || {};
    const fields = {
      currentRoomId: (value) => value,
      sessionRole: (value) => value,
      currentSessionToken: (value) => value || '',
      myChainPosition: (value) => value,
      hostId: (value) => value,
      upstreamPeerId: (value) => value || '',
      upstreamConnected: (value) => Boolean(value),
      viewerReadySent: (value) => Boolean(value),
      videoStarted: (value) => Boolean(value),
      isHost: (value) => Boolean(value)
    };

    function applyPatch(patch = {}) {
      Object.keys(fields).forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(patch, field)) {
          return;
        }
        if (typeof setters[field] === 'function') {
          setters[field](fields[field](patch[field]));
        }
      });
    }

    return { applyPatch };
  }

  function createAppStateSyncBridge(options = {}) {
    function sync(reason, overrides = {}) {
      if (typeof options.syncAppState !== 'function') {
        return null;
      }
      const mediaManifest = typeof options.getMediaManifest === 'function'
        ? options.getMediaManifest()
        : null;
      return options.syncAppState({
        mediaManifest: mediaManifest || null,
        ...overrides
      }, { reason });
    }

    return { sync };
  }

  VDS.nativeRendererState = { createController, createLegacyAppStateBridge, createAppStateSyncBridge };
})();
