(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.p2pStateMachine) {
    return;
  }

  const DEFAULT_STATE_LABELS = Object.freeze({
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

  function create(options = {}) {
    const stateLabels = Object.freeze({
      ...DEFAULT_STATE_LABELS,
      ...(options.stateLabels && typeof options.stateLabels === 'object' ? options.stateLabels : {})
    });

    function getStateLabel(state) {
      return stateLabels[state] || '';
    }

    function setStatusElementState(target, state) {
      const label = getStateLabel(state);
      if (!target || !label) {
        return false;
      }
      target.dataset.p2pState = state;
      target.textContent = `P2P：${label}`;
      return true;
    }

    function setP2pStateForPeer(peerId, state) {
      const target = typeof options.getStatusElementForPeer === 'function'
        ? options.getStatusElementForPeer(peerId)
        : null;
      if (!target) {
        return false;
      }

      const meta = typeof options.getPeerMeta === 'function'
        ? options.getPeerMeta(peerId)
        : null;
      if (meta) {
        meta.p2pUiState = state;
      }

      const changed = setStatusElementState(target, state);
      if (changed && typeof options.renderDiagnosticReport === 'function') {
        options.renderDiagnosticReport();
      }
      return changed;
    }

    function classifyFailure(meta) {
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

    let viewerMediaWaitTimerId = null;
    let viewerUpstreamOfferWaitTimerId = null;
    let viewerUpstreamOfferReconnectSentForPeerId = '';

    function clearViewerMediaWaitTimer() {
      if (viewerMediaWaitTimerId) {
        window.clearTimeout(viewerMediaWaitTimerId);
        viewerMediaWaitTimerId = null;
      }
    }

    function clearViewerUpstreamOfferWaitTimer() {
      if (viewerUpstreamOfferWaitTimerId) {
        window.clearTimeout(viewerUpstreamOfferWaitTimerId);
        viewerUpstreamOfferWaitTimerId = null;
      }
    }

    function resetViewerUpstreamOfferReconnectPeer(peerId) {
      if (!peerId || viewerUpstreamOfferReconnectSentForPeerId === peerId) {
        viewerUpstreamOfferReconnectSentForPeerId = '';
      }
    }

    function armViewerUpstreamOfferWaitTimer(peerId) {
      clearViewerUpstreamOfferWaitTimer();
      const snapshot = typeof options.getViewerUpstreamOfferWaitSnapshot === 'function'
        ? options.getViewerUpstreamOfferWaitSnapshot(peerId)
        : null;
      if (!snapshot || !peerId || !snapshot.roomId || snapshot.sessionRole !== 'viewer') {
        return false;
      }
      if (viewerUpstreamOfferReconnectSentForPeerId && viewerUpstreamOfferReconnectSentForPeerId !== peerId) {
        viewerUpstreamOfferReconnectSentForPeerId = '';
      }
      const timeoutMs = Number(options.viewerUpstreamOfferWaitTimeoutMs) || 6000;
      viewerUpstreamOfferWaitTimerId = window.setTimeout(() => {
        viewerUpstreamOfferWaitTimerId = null;
        const current = typeof options.getViewerUpstreamOfferWaitSnapshot === 'function'
          ? options.getViewerUpstreamOfferWaitSnapshot(peerId)
          : null;
        if (!current || current.sessionRole !== 'viewer' || !current.roomId || current.upstreamPeerId !== peerId || current.peerExists) {
          return;
        }
        if (viewerUpstreamOfferReconnectSentForPeerId === peerId) {
          return;
        }
        viewerUpstreamOfferReconnectSentForPeerId = peerId;
        if (typeof options.onViewerUpstreamOfferTimeout === 'function') {
          options.onViewerUpstreamOfferTimeout(peerId, current);
        }
      }, timeoutMs);
      return true;
    }

    function armViewerMediaWaitTimer(peerId) {
      clearViewerMediaWaitTimer();
      if (!peerId) {
        return false;
      }
      const timeoutMs = Number(options.viewerMediaWaitTimeoutMs) || 7000;
      viewerMediaWaitTimerId = window.setTimeout(() => {
        viewerMediaWaitTimerId = null;
        const snapshot = typeof options.getViewerMediaWaitSnapshot === 'function'
          ? options.getViewerMediaWaitSnapshot(peerId)
          : null;
        if (!snapshot || snapshot.sessionRole !== 'viewer' || snapshot.upstreamPeerId !== peerId || snapshot.videoStarted || snapshot.upstreamConnected) {
          return;
        }
        setP2pStateForPeer(peerId, 'media-waiting');
        if (typeof options.onViewerMediaWaitTimeout === 'function') {
          options.onViewerMediaWaitTimeout(peerId, snapshot);
        }
      }, timeoutMs);
      return true;
    }

    return {
      getStateLabel,
      setStatusElementState,
      setP2pStateForPeer,
      classifyFailure,
      clearViewerMediaWaitTimer,
      clearViewerUpstreamOfferWaitTimer,
      resetViewerUpstreamOfferReconnectPeer,
      armViewerUpstreamOfferWaitTimer,
      armViewerMediaWaitTimer
    };
  }

  VDS.p2pStateMachine = {
    DEFAULT_STATE_LABELS,
    create
  };
})();
