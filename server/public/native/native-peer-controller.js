(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativePeer) {
    return;
  }

  function createDefaultPeerMeta(isInitiator, kind) {
    return {
      isInitiator: Boolean(isInitiator),
      kind,
      attemptId: 0,
      edgeAttemptId: null,
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
  }

  function createPeerHandleRegistry() {
    const peerHandles = new Map();
    let peerAttemptSeq = 0;
    return {
      get: (peerId) => peerHandles.get(peerId) || null,
      set: (peerId, handle) => {
        peerHandles.set(peerId, handle);
        return handle;
      },
      delete: (peerId) => peerHandles.delete(peerId),
      count: () => peerHandles.size,
      entries: () => Array.from(peerHandles.entries()),
      ids: () => Array.from(peerHandles.keys()),
      nextAttemptId: () => {
        peerAttemptSeq += 1;
        return peerAttemptSeq;
      }
    };
  }

  function createSignalRegistry() {
    const signalBacklog = new Map();
    const signalWaiters = new Map();
    return {
      forEachBacklog: (callback) => signalBacklog.forEach(callback),
      getBacklog: (peerId) => signalBacklog.get(peerId),
      setBacklog: (peerId, entries) => signalBacklog.set(peerId, entries),
      deleteBacklog: (peerId) => signalBacklog.delete(peerId),
      hasBacklog: (peerId) => signalBacklog.has(peerId),
      backlogSize: () => signalBacklog.size,
      getWaiters: (key) => signalWaiters.get(key),
      setWaiters: (key, waiters) => signalWaiters.set(key, waiters),
      deleteWaiters: (key) => signalWaiters.delete(key),
      hasWaiters: (key) => signalWaiters.has(key),
      waiterKeys: () => Array.from(signalWaiters.keys())
    };
  }

  function createController(options = {}) {
    const peerHandleRegistry = createPeerHandleRegistry();
    const signalRegistry = createSignalRegistry();
    const peerReconnectState = new Map();
    const pendingRemoteCandidates = new Map();

    function getPeerMeta(peerId) {
      return typeof options.getPeerMeta === 'function'
        ? options.getPeerMeta(peerId)
        : null;
    }

    function setPeerMeta(peerId, meta) {
      if (typeof options.setPeerMeta === 'function') {
        options.setPeerMeta(peerId, meta);
      }
      return meta;
    }

    function getSignalPeerId(params) {
      if (typeof options.getSignalPeerId === 'function') {
        return options.getSignalPeerId(params);
      }
      return params && (params.peerId || params.targetId || params.remotePeerId) || '';
    }

    function sanitizeSignalPayload(payload) {
      if (!payload || typeof payload !== 'object') {
        return payload;
      }
      const { __queuedAt, ...publicPayload } = payload;
      return publicPayload;
    }

    function getSignalAttemptId(data) {
      const value = data && data.attemptId;
      const attemptId = Number(value);
      return Number.isInteger(attemptId) && attemptId > 0 ? attemptId : null;
    }

    function normalizeSessionDescription(description) {
      if (!description) {
        return { type: '', sdp: '' };
      }
      return {
        type: String(description.type || ''),
        sdp: String(description.sdp || '')
      };
    }

    function isSameSessionDescription(currentDescription, incomingDescription) {
      if (!currentDescription || !incomingDescription) {
        return false;
      }
      const normalizedIncoming = normalizeSessionDescription(incomingDescription);
      return (
        currentDescription.type === normalizedIncoming.type &&
        currentDescription.sdp === normalizedIncoming.sdp
      );
    }

    function extractSignalSdpText(signal) {
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

    function isMediaOfferSignal(signal, signalOptions = {}) {
      const sdpText = extractSignalSdpText(signal);
      if (sdpText.includes('m=video')) {
        return true;
      }
      return Boolean(
        signalOptions.allowEncodedDataChannel &&
        sdpText.includes('m=application') &&
        sdpText.includes('webrtc-datachannel')
      );
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

    function isStaleNativePeerError(error) {
      const message = error && error.message ? String(error.message) : String(error || '');
      return message.includes('native-peer-stale:') ||
        message.includes('Peer has not been created') ||
        Boolean(error && error.code === 'PEER_NOT_FOUND');
    }

    function hasRemoteCandidate(peerId, candidateKey) {
      const meta = getPeerMeta(peerId);
      return Boolean(candidateKey && meta && meta.remoteCandidateKeys && meta.remoteCandidateKeys.has(candidateKey));
    }

    function rememberRemoteCandidate(peerId, candidateKey) {
      const meta = getPeerMeta(peerId);
      if (!candidateKey || !meta) {
        return;
      }
      if (!meta.remoteCandidateKeys || typeof meta.remoteCandidateKeys.add !== 'function') {
        meta.remoteCandidateKeys = new Set();
      }
      meta.remoteCandidateKeys.add(candidateKey);
      if (meta.remoteCandidateKeys.size > 64) {
        meta.remoteCandidateKeys = new Set(Array.from(meta.remoteCandidateKeys).slice(-48));
      }
    }

    function queuePendingRemoteCandidate(peerId, candidate) {
      if (!peerId || !candidate) {
        return false;
      }
      if (!pendingRemoteCandidates.has(peerId)) {
        pendingRemoteCandidates.set(peerId, []);
      }
      const queued = pendingRemoteCandidates.get(peerId);
      const candidateKey = buildRemoteCandidateKey(candidate);
      const duplicate = queued.some((entry) => buildRemoteCandidateKey(entry) === candidateKey);
      if (duplicate) {
        return false;
      }
      queued.push(candidate);
      while (queued.length > 32) {
        queued.shift();
      }
      return true;
    }

    function takePendingRemoteCandidates(peerId) {
      const queued = pendingRemoteCandidates.get(peerId);
      if (!queued || !queued.length) {
        return [];
      }
      pendingRemoteCandidates.delete(peerId);
      return queued.slice();
    }

    function clearPendingRemoteCandidates(peerId) {
      pendingRemoteCandidates.delete(peerId);
    }

    function clearAllPendingRemoteCandidates() {
      const queuedCandidates = pendingRemoteCandidates.size;
      pendingRemoteCandidates.clear();
      return queuedCandidates;
    }

    function normalizeIceCandidate(candidate) {
      if (!candidate) {
        return null;
      }
      if (typeof candidate === 'object') {
        return {
          candidate: String(candidate.candidate || ''),
          sdpMid: candidate.sdpMid || '',
          sdpMLineIndex: Number.isFinite(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : 0
        };
      }
      return {
        candidate: String(candidate || ''),
        sdpMid: '',
        sdpMLineIndex: 0
      };
    }

    function rememberLocalIceCandidate(peerId, candidate) {
      const meta = getPeerMeta(peerId);
      const candidateObject = normalizeIceCandidate(candidate);
      if (!meta || !candidateObject || !candidateObject.candidate) {
        return false;
      }

      meta.localCandidateCount = Number(meta.localCandidateCount || 0) + 1;
      if (!meta.localCandidateTypes || typeof meta.localCandidateTypes.add !== 'function') {
        meta.localCandidateTypes = new Set();
      }

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
        if (!Array.isArray(meta.localHostUdpCandidates)) {
          meta.localHostUdpCandidates = [];
        }
        const exists = meta.localHostUdpCandidates.some((entry) => entry && entry.key === key);
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
      return true;
    }

    function getLocalHostUdpCandidates(peerId, limit) {
      const meta = getPeerMeta(peerId);
      const candidates = Array.isArray(meta && meta.localHostUdpCandidates)
        ? meta.localHostUdpCandidates
        : [];
      const maxCandidates = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Number(limit)
        : 4;
      return candidates
        .map((entry) => entry && entry.candidate)
        .filter(Boolean)
        .slice(0, maxCandidates);
    }

    function getCandidateTypeCounts(peerId) {
      const counts = { host: 0, srflx: 0, relay: 0, other: 0 };
      const meta = getPeerMeta(peerId);
      const types = meta && meta.localCandidateTypes instanceof Set ? meta.localCandidateTypes : null;
      if (!types) {
        return counts;
      }
      types.forEach((type) => {
        if (Object.prototype.hasOwnProperty.call(counts, type)) {
          counts[type] += 1;
        } else {
          counts.other += 1;
        }
      });
      return counts;
    }

    function buildPeerDiagnosticEntries(statsPeers = []) {
      const peers = Array.isArray(statsPeers) ? statsPeers : [];
      return getPeerHandleEntries().map(([peerId, handle]) => {
        const meta = getPeerMeta(peerId) || null;
        return {
          peerId,
          handle,
          meta,
          candidateCounts: getCandidateTypeCounts(peerId),
          statsPeer: peers.find((entry) => entry && entry.peerId === peerId) || null
        };
      });
    }

    function getSignalBacklogPerPeerLimit() {
      const configured = Number(options.signalMaxBacklogPerPeer);
      return Number.isFinite(configured) && configured > 0 ? configured : 32;
    }

    function getSignalBacklogTotalLimit() {
      const configured = Number(options.signalMaxBacklogTotal);
      return Number.isFinite(configured) && configured > 0 ? configured : 256;
    }

    function getSignalWaiterPerKeyLimit() {
      const configured = Number(options.signalMaxWaitersPerKey);
      return Number.isFinite(configured) && configured > 0 ? configured : 8;
    }

    function getSignalTtlMs() {
      const configured = Number(options.signalTtlMs);
      return Number.isFinite(configured) && configured > 0 ? configured : 30000;
    }

    function ensurePeerMeta(peerId, isInitiator, kind) {
      let meta = getPeerMeta(peerId);
      if (!meta) {
        meta = createDefaultPeerMeta(isInitiator, kind);
        setPeerMeta(peerId, meta);
      }
      return meta;
    }

    function initializePeerMetaForHandle(peerId, handle, isInitiator, kind) {
      const meta = ensurePeerMeta(peerId, isInitiator, kind);
      if (handle && Number.isInteger(handle.attemptId)) {
        meta.attemptId = handle.attemptId;
        meta.edgeAttemptId = Boolean(isInitiator) ? handle.attemptId : null;
      }
      return meta;
    }

    function applyRemoteOfferAttempt(peerId, attemptId, kind = 'upstream') {
      const meta = ensurePeerMeta(peerId, false, kind);
      if (attemptId) {
        meta.edgeAttemptId = attemptId;
      }
      return meta;
    }

    function clearPeerConnectTimeout(peerId) {
      const meta = getPeerMeta(peerId);
      if (meta && meta.connectTimeoutId) {
        clearTimeout(meta.connectTimeoutId);
        meta.connectTimeoutId = null;
      }
    }

    function clearPeerDisconnectTimer(peerId) {
      const meta = getPeerMeta(peerId);
      if (meta && meta.disconnectTimerId) {
        clearTimeout(meta.disconnectTimerId);
        meta.disconnectTimerId = null;
      }
    }

    function armPeerConnectTimeout(peerId, timeoutMs, onTimeout) {
      const meta = getPeerMeta(peerId);
      if (!meta || meta.connectTimeoutId) {
        return false;
      }
      const delayMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 15000;
      meta.connectTimeoutId = setTimeout(async () => {
        meta.connectTimeoutId = null;
        if (typeof onTimeout !== 'function') {
          return;
        }
        await onTimeout(peerId, meta);
      }, delayMs);
      return true;
    }

    function armPeerConnectFailfast(peerId, timeoutMs, onTimeout) {
      if (typeof onTimeout === 'function') {
        return armPeerConnectTimeout(peerId, timeoutMs, onTimeout);
      }
      const onConnectFailfast = async (timeoutPeerId) => {
        const decision = prepareConnectFailfastTimeout(timeoutPeerId);
        if (!decision || !decision.ready) {
          return;
        }
        await finalizeP2pFailureWithNatMapping(
          timeoutPeerId,
          classifyConnectionFailure(decision.meta),
          'connect-failfast'
        );
      };
      return armPeerConnectTimeout(peerId, timeoutMs, onConnectFailfast);
    }

    function armPeerNatMappingWait(peerId, timeoutMs, onTimeout) {
      const delayMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 7000;
      if (typeof onTimeout === 'function') {
        return armPeerConnectTimeout(peerId, delayMs, onTimeout);
      }
      const onNatMappingWaitTimeout = async (timeoutPeerId) => {
        const decision = prepareNatMappingWaitTimeout(timeoutPeerId);
        if (!decision || !decision.ready) {
          return;
        }
        if (typeof options.setP2pStateForPeer === 'function') {
          options.setP2pStateForPeer(timeoutPeerId, 'failed');
        }
        const isHost = typeof options.isHost === 'function' ? Boolean(options.isHost()) : Boolean(options.isHost);
        if (!isHost && typeof options.setViewerConnectionState === 'function') {
          options.setViewerConnectionState('端口映射已尝试，但当前网络仍无法纯 P2P 穿透');
        }
        if (typeof options.closePeerConnection === 'function') {
          await options.closePeerConnection(timeoutPeerId, { clearRetryState: false }).catch(() => {});
        }
      };
      return armPeerConnectTimeout(peerId, delayMs, onNatMappingWaitTimeout);
    }

    function armPeerDisconnectTimer(peerId, timeoutMs, onTimeout) {
      const meta = getPeerMeta(peerId);
      if (!meta || meta.disconnectTimerId) {
        return false;
      }
      const delayMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 750;
      meta.disconnectTimerId = setTimeout(async () => {
        meta.disconnectTimerId = null;
        if (typeof onTimeout !== 'function') {
          return;
        }
        await onTimeout(peerId, meta);
      }, delayMs);
      return true;
    }

    function getPeerReconnectState(peerId) {
      const state = peerReconnectState.get(peerId);
      if (!state) {
        return { attempts: 0, timerId: null };
      }
      return {
        attempts: Number(state.attempts || 0),
        timerId: state.timerId || null
      };
    }

    function clearPeerReconnect(peerId) {
      const state = peerReconnectState.get(peerId);
      if (state && state.timerId) {
        clearTimeout(state.timerId);
      }
      peerReconnectState.delete(peerId);
    }

    function schedulePeerReconnect(peerId, attempts, delayMs, onRetry) {
      clearPeerReconnect(peerId);
      const retryDelays = [750, 1500];
      const attemptIndex = Math.max(0, Number(attempts || 1) - 1);
      const timeoutMs = Number.isFinite(Number(delayMs)) && Number(delayMs) > 0
        ? Number(delayMs)
        : retryDelays[Math.min(attemptIndex, retryDelays.length - 1)];
      const timerId = setTimeout(async () => {
        peerReconnectState.delete(peerId);
        if (typeof onRetry === 'function') {
          await onRetry(peerId);
        }
      }, timeoutMs);
      peerReconnectState.set(peerId, {
        attempts: Number(attempts || 0),
        timerId
      });
      return timerId;
    }

    function clearAllPeerReconnects() {
      Array.from(peerReconnectState.keys()).forEach((peerId) => clearPeerReconnect(peerId));
    }

    function getCurrentPeerAttemptId(peerId) {
      const meta = getPeerMeta(peerId);
      return meta && Number.isInteger(meta.attemptId) && meta.attemptId > 0 ? meta.attemptId : null;
    }

    function getCurrentPeerEdgeAttemptId(peerId) {
      const meta = getPeerMeta(peerId);
      if (meta && Number.isInteger(meta.edgeAttemptId) && meta.edgeAttemptId > 0) {
        return meta.edgeAttemptId;
      }
      return getCurrentPeerAttemptId(peerId);
    }

    function isCurrentPeerAttempt(peerId, attemptId) {
      if (!attemptId) {
        return true;
      }
      return getCurrentPeerEdgeAttemptId(peerId) === attemptId;
    }

    function appendPeerAttempt(payload, peerId) {
      const attemptId = getCurrentPeerEdgeAttemptId(peerId);
      if (attemptId && payload && typeof payload === 'object') {
        payload.attemptId = attemptId;
      }
      return payload;
    }

    function getPeerEdgeState(peerId) {
      const handle = getPeerHandle(peerId) || null;
      const meta = getPeerMeta(peerId) || null;
      return {
        peerId,
        handle,
        meta,
        attemptId: handle && Number.isInteger(handle.attemptId) ? handle.attemptId : getCurrentPeerAttemptId(peerId),
        edgeAttemptId: getCurrentPeerEdgeAttemptId(peerId),
        role: handle && handle.role ? handle.role : '',
        kind: handle && handle.kind ? handle.kind : '',
        connectionState: handle && handle.connectionState ? handle.connectionState : 'none',
        closed: Boolean(handle && handle.closed),
        hasConnected: Boolean(meta && meta.hasConnected),
        restartInProgress: Boolean(meta && meta.restartInProgress)
      };
    }

    function preparePeerRecoveryRequest(peerId, reason, recoveryOptions = {}) {
      const edge = getPeerEdgeState(peerId);
      const handle = edge.handle;
      const meta = edge.meta;
      if (!peerId || !handle || edge.closed || !meta) {
        return { prepared: false, peerId, edge, reason: 'missing-peer-state' };
      }
      if (Number.isInteger(recoveryOptions.attemptId) && edge.attemptId !== recoveryOptions.attemptId) {
        return { prepared: false, peerId, edge, reason: 'stale-attempt' };
      }
      const room = recoveryOptions.roomSnapshot && typeof recoveryOptions.roomSnapshot === 'object'
        ? recoveryOptions.roomSnapshot
        : {};
      const recoveryReason = reason;
      const source = String(recoveryOptions.source || '');
      const logPayload = {
        peerId,
        reason: recoveryReason,
        role: edge.role,
        kind: edge.kind,
        attemptId: edge.attemptId,
        edgeAttemptId: edge.edgeAttemptId,
        source
      };

      if (handle.role === 'host-downstream') {
        return {
          prepared: true,
          peerId,
          action: 'host-force-offer',
          edge,
          handle,
          meta,
          logPayload
        };
      }

      if (handle.role === 'viewer-upstream' && room.roomId && room.role === 'viewer') {
        return {
          prepared: true,
          peerId,
          action: 'viewer-reconnect-ready',
          edge,
          handle,
          meta,
          logPayload,
          reconnectReady: {
            roomId: room.roomId,
            clientId: room.clientId || '',
            sessionToken: room.sessionToken || '',
            chainPosition: room.chainPosition,
            upstreamPeerId: peerId,
            failedUpstreamPeerId: peerId,
            reason: recoveryReason
          }
        };
      }

      return {
        prepared: true,
        peerId,
        action: 'none',
        edge,
        handle,
        meta,
        logPayload
      };
    }

    function getRecoveryRoomSnapshot() {
      return typeof options.getRecoveryRoomSnapshot === 'function'
        ? (options.getRecoveryRoomSnapshot() || {})
        : {};
    }

    async function requestPeerRecovery(peerId, reason, requestOptions = {}) {
      const recovery = preparePeerRecoveryRequest(peerId, reason, {
        attemptId: requestOptions.attemptId,
        source: requestOptions.source || '',
        roomSnapshot: requestOptions.roomSnapshot || getRecoveryRoomSnapshot()
      });
      if (!recovery || !recovery.prepared) {
        return false;
      }
      logNativeStep('peer:recovery-requested', recovery.logPayload, 'connection');
      if (recovery.action === 'host-force-offer') {
        if (typeof options.createOffer === 'function') {
          await options.createOffer(peerId, { force: true, reconnect: true });
          return true;
        }
        return false;
      }
      if (recovery.action === 'viewer-reconnect-ready') {
        if (typeof options.closePeerConnection === 'function') {
          await options.closePeerConnection(peerId, { clearRetryState: false }).catch(() => {});
        }
        sendViewerReconnectReady(recovery.reconnectReady);
        return true;
      }
      return false;
    }

    function prepareRemoteIceCandidate(peerId, candidate, attemptId) {
      if (!candidate) {
        return { action: 'ignore', peerId, reason: 'missing-candidate' };
      }
      const handle = getPeerHandle(peerId);
      if (handle && !isCurrentPeerAttempt(peerId, attemptId)) {
        return { action: 'ignore', peerId, handle, attemptId, reason: 'stale-attempt' };
      }
      if (!handle) {
        return { action: 'queue', peerId, reason: 'missing-peer' };
      }
      if (!handle.remoteDescription || !handle.remoteDescription.type) {
        return { action: 'queue', peerId, handle, reason: 'missing-remote-description' };
      }
      return { action: 'apply', peerId, handle };
    }

    function prepareRemoteAnswer(peerId, description, attemptId) {
      const handle = getPeerHandle(peerId);
      if (!handle) {
        return { action: 'ignore', peerId, reason: 'missing-peer' };
      }
      if (!isCurrentPeerAttempt(peerId, attemptId)) {
        return { action: 'ignore', peerId, handle, attemptId, reason: 'stale-attempt' };
      }
      if (!handle.localDescription || handle.localDescription.type !== 'offer') {
        return { action: 'ignore', peerId, handle, reason: 'stale-answer-without-local-offer' };
      }
      const remoteDescription = normalizeSessionDescription(description);
      if (isSameSessionDescription(handle.remoteDescription, remoteDescription)) {
        return { action: 'flush', peerId, handle, remoteDescription };
      }
      return { action: 'apply', peerId, handle, remoteDescription };
    }

    function prepareRemoteOffer(peerId, description, attemptId) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      if (
        attemptId &&
        meta &&
        Number.isInteger(meta.edgeAttemptId) &&
        meta.edgeAttemptId > attemptId
      ) {
        return { action: 'ignore', peerId, handle, meta, attemptId, reason: 'stale-attempt' };
      }
      const remoteDescription = normalizeSessionDescription(description);
      const shouldRecreate = Boolean(
        handle &&
        isNativePeerHandle(handle) &&
        handle.remoteDescription &&
        handle.remoteDescription.type &&
        (handle.connectionState !== 'connected' ||
          (attemptId && meta && meta.edgeAttemptId && attemptId > meta.edgeAttemptId))
      );
      if (!handle || !isNativePeerHandle(handle) || shouldRecreate) {
        return { action: 'recreate', peerId, handle, meta, remoteDescription, shouldCloseExisting: Boolean(handle) };
      }
      if (isSameSessionDescription(handle.remoteDescription, remoteDescription)) {
        return { action: 'flush', peerId, handle, meta, remoteDescription };
      }
      return { action: 'reuse', peerId, handle, meta, remoteDescription };
    }

    function buildOfferMessage(peerId, signal, messageOptions = {}) {
      return appendPeerAttempt({
        type: 'offer',
        targetId: peerId,
        sdp: signal && signal.sdp,
        roomId: messageOptions.roomId,
        ...(messageOptions.isRelay ? { isRelay: true } : {}),
        ...(messageOptions.reconnect ? { reconnect: true } : {}),
        ...(messageOptions.iceRestart ? { iceRestart: true } : {})
      }, peerId);
    }

    function buildAnswerMessage(peerId, signal, messageOptions = {}) {
      return appendPeerAttempt({
        type: 'answer',
        targetId: peerId,
        sdp: signal && signal.sdp,
        roomId: messageOptions.roomId
      }, peerId);
    }

    function prepareLocalIceCandidateSignal(params, messageOptions = {}) {
      if (!params || !params.type) {
        return { action: 'ignore', reason: 'missing-type' };
      }
      if (params.type !== 'candidate') {
        return { action: 'ignore', reason: 'unsupported-type', signalType: params.type };
      }

      const targetId = params.targetId || params.peerId || params.remotePeerId;
      const peerId = params.peerId || params.remotePeerId || params.targetId;
      const payload = appendPeerAttempt({
        type: 'ice-candidate',
        targetId,
        roomId: messageOptions.roomId,
        trickle: true
      }, targetId);

      if (params.sdp) {
        payload.sdp = params.sdp;
      }
      if (params.candidate) {
        if (!isAllowedPureP2pCandidate(params.candidate)) {
          return { action: 'block', reason: 'relay-candidate', peerId, payload };
        }
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

      return { action: 'send', peerId, payload, candidate: params.candidate || null };
    }

    function handleLocalSignalEvent(params, messageOptions = {}) {
      const peerId = getSignalPeerId(params);
      if (peerId) {
        updateSignalState(peerId, params);
        enqueueSignal(params);
      }
      return {
        peerId,
        decision: prepareLocalIceCandidateSignal(params, messageOptions)
      };
    }

    function rememberLocalIceCandidateForSignal(peerId, candidate) {
      if (!peerId || !candidate || !getPeerMeta(peerId)) {
        return false;
      }
      if (typeof options.setP2pStateForPeer === 'function') {
        options.setP2pStateForPeer(peerId, 'gathering');
      }
      return rememberLocalIceCandidate(peerId, candidate);
    }

    function handleLocalSignalEventAndSend(params, messageOptions = {}) {
      const signalResult = handleLocalSignalEvent(params, messageOptions);
      const decision = signalResult && signalResult.decision;
      if (!decision || decision.action === 'ignore') {
        return signalResult;
      }
      if (decision.action === 'block') {
        logNativeStep('signal:candidate:blocked-relay', {
          peerId: decision.peerId
        }, 'p2p');
        return signalResult;
      }
      if (decision.candidate) {
        rememberLocalIceCandidateForSignal(decision.peerId, decision.candidate);
      }
      sendSignalMessage(decision.payload);
      return signalResult;
    }

    function prepareDisconnectedRecovery(peerId, handle, recoveryOptions = {}) {
      if (!peerId) {
        return { prepared: false, reason: 'missing-peer-id' };
      }
      const currentHandle = isNativePeerHandle(handle) ? handle : getPeerHandle(peerId);
      if (!currentHandle) {
        return { prepared: false, peerId, reason: 'missing-handle' };
      }
      if (currentHandle.closed) {
        return { prepared: false, peerId, handle: currentHandle, reason: 'closed-handle' };
      }
      const meta = getPeerMeta(peerId);
      if (!meta) {
        return { prepared: false, peerId, handle: currentHandle, reason: 'missing-meta' };
      }
      if (!meta.hasConnected) {
        return { prepared: false, peerId, handle: currentHandle, meta, reason: 'not-yet-connected' };
      }
      if (meta.restartInProgress) {
        return { prepared: false, peerId, handle: currentHandle, meta, reason: 'restart-in-progress' };
      }
      if (meta.disconnectTimerId) {
        return { prepared: false, peerId, handle: currentHandle, meta, reason: 'disconnect-timer-active' };
      }
      const retryDelays = Array.isArray(recoveryOptions.reconnectDelaysMs) && recoveryOptions.reconnectDelaysMs.length
        ? recoveryOptions.reconnectDelaysMs
        : [750, 1500];
      const firstDelayMs = recoveryOptions.initialDelayMs != null
        ? recoveryOptions.initialDelayMs
        : 4000;
      const delays = [firstDelayMs].concat(retryDelays);
      const nextAttempt = Math.min(Number(meta.restartAttempts || 0) + 1, delays.length);
      const delayMs = delays[Math.max(0, nextAttempt - 1)];
      meta.restartAttempts = nextAttempt;
      meta.restartInProgress = true;
      return {
        prepared: true,
        peerId,
        handle: currentHandle,
        meta,
        attemptId: currentHandle.attemptId,
        nextAttempt,
        delayMs
      };
    }

    function prepareDisconnectedRecoveryRetry(peerId, attemptId, nextAttempt) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      const markSkipped = (reason) => {
        if (meta) {
          meta.restartInProgress = false;
        }
        return { ready: false, peerId, handle, meta, reason };
      };

      if (!peerId) {
        return markSkipped('missing-peer-id');
      }
      if (!handle) {
        return markSkipped('missing-handle');
      }
      if (handle.closed) {
        return markSkipped('closed-handle');
      }
      if (Number.isInteger(attemptId) && handle.attemptId !== attemptId) {
        return markSkipped('stale-attempt');
      }
      if (handle.connectionState === 'connected') {
        return markSkipped('already-connected');
      }
      if (!meta) {
        return { ready: false, peerId, handle, meta, reason: 'missing-meta' };
      }

      return {
        ready: true,
        peerId,
        handle,
        meta,
        logPayload: {
          peerId,
          role: handle.role,
          kind: handle.kind,
          attempt: nextAttempt
        }
      };
    }

    function logRecoverableNativeWarning(scope, error, warningOptions = {}) {
      if (typeof options.logRecoverableNativeWarning === 'function') {
        options.logRecoverableNativeWarning(scope, error, warningOptions);
      }
    }

    function scheduleDisconnectedRecovery(peerId, handle) {
      const preparedRecovery = prepareDisconnectedRecovery(peerId, handle);
      if (!preparedRecovery || !preparedRecovery.prepared) {
        return false;
      }
      const attemptId = preparedRecovery.attemptId;
      const nextAttempt = preparedRecovery.nextAttempt;
      const delayMs = preparedRecovery.delayMs;
      const onDisconnectedRecovery = async (timeoutPeerId) => {
        const retry = prepareDisconnectedRecoveryRetry(timeoutPeerId, attemptId, nextAttempt);
        if (!retry || !retry.ready) {
          return;
        }
        try {
          logNativeStep('peer:disconnected-recovery', { ...retry.logPayload }, 'connection');
          const recovered = await requestPeerRecovery(timeoutPeerId, 'ice-disconnected', {
            attemptId,
            source: 'disconnected-recovery'
          });
          if (recovered) {
            return;
          }
          if (retry.meta) {
            retry.meta.restartInProgress = false;
          }
        } catch (error) {
          if (retry.meta) {
            retry.meta.restartInProgress = false;
          }
          logRecoverableNativeWarning('peer:disconnected-recovery-failed', error, {
            key: `peer-disconnected-recovery:${timeoutPeerId}`,
            category: 'connection',
            channel: 'nativeSteps',
            fallbackLabel: `[media-engine] disconnected recovery failed: ${timeoutPeerId}`
          });
        }
      };
      armPeerDisconnectTimer(peerId, delayMs, onDisconnectedRecovery);
      return true;
    }

    function prepareP2pFailureFinalization(peerId) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      if (!peerId || !meta || !handle) {
        return { prepared: false, peerId, handle, meta, reason: 'missing-peer-state' };
      }
      if (handle.closed) {
        return { prepared: false, peerId, handle, meta, reason: 'closed-handle' };
      }
      if (meta.hasConnected || handle.connectionState === 'connected') {
        return { prepared: false, peerId, handle, meta, reason: 'already-connected' };
      }
      return { prepared: true, peerId, handle, meta };
    }

    function finalizeP2pConnectionFailure(peerId, reason, source) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      if (!peerId || !meta || !handle) {
        return { finalized: false, peerId, handle, meta, reason: 'missing-peer-state' };
      }
      handle.connectionState = 'failed';
      handle.iceConnectionState = 'failed';
      return {
        finalized: true,
        peerId,
        handle,
        meta,
        logPayload: {
          peerId,
          source,
          reason,
          localCandidateCount: meta.localCandidateCount,
          localCandidateTypes: Array.from(meta.localCandidateTypes || []),
          natMappingAttempted: Boolean(meta.natMappingAttempted),
          natMappingResultReason: meta.natMappingResultReason || ''
        },
        viewerMessage: meta.natMappingAttempted
          ? `纯 P2P 无法穿透当前网络（端口映射：${meta.natMappingResultReason || '失败'}）`
          : reason
      };
    }

    async function finalizeP2pConnectionFailureAndApply(peerId, reason, source) {
      const finalFailure = finalizeP2pConnectionFailure(peerId, reason, source);
      if (!finalFailure || !finalFailure.finalized) {
        return finalFailure;
      }
      if (typeof options.setP2pStateForPeer === 'function') {
        options.setP2pStateForPeer(peerId, 'failed');
      }
      logNativeStep('peer-connect-failed', finalFailure.logPayload, 'p2p');
      const isHost = typeof options.isHost === 'function' ? Boolean(options.isHost()) : Boolean(options.isHost);
      if (!isHost && typeof options.setViewerConnectionState === 'function') {
        options.setViewerConnectionState(finalFailure.viewerMessage || reason);
      }
      if (typeof options.closePeerConnection === 'function') {
        await options.closePeerConnection(peerId, { clearRetryState: false }).catch(() => {});
      }
      return finalFailure;
    }

    function beginNatMappingAttempt(peerId, reason, candidateLimit) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      if (!peerId || !meta || !handle) {
        return { started: false, peerId, handle, meta, reason: 'missing-peer-state' };
      }
      if (handle.closed) {
        return { started: false, peerId, handle, meta, reason: 'closed-handle' };
      }
      if (meta.hasConnected || handle.connectionState === 'connected') {
        return { started: false, peerId, handle, meta, reason: 'already-connected' };
      }
      if (meta.natMappingAttempted || meta.natMappingInProgress) {
        return { started: false, peerId, handle, meta, reason: 'already-attempted' };
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

      return {
        started: true,
        peerId,
        handle,
        meta,
        candidates: getLocalHostUdpCandidates(peerId, candidateLimit)
      };
    }

    function applyNatMappingResult(peerId, result) {
      const meta = getPeerMeta(peerId);
      if (!meta) {
        return { applied: false, peerId, reason: 'missing-meta' };
      }
      meta.natMappingCompletedAt = Date.now();
      meta.natMappingDurationMs = meta.natMappingStartedAt ? meta.natMappingCompletedAt - meta.natMappingStartedAt : null;
      meta.natMappingSuccess = Boolean(result && result.ok);
      meta.natMappingResultReason = result && result.reason ? String(result.reason) : 'nat-mapping-failed';
      meta.natMappingProtocol = result && result.protocol ? String(result.protocol) : '';
      meta.natMappingMappedCandidateCount = result && Array.isArray(result.candidates) ? result.candidates.length : 0;
      meta.natMappingError = result && Array.isArray(result.errors) && result.errors.length > 0
        ? result.errors.slice(0, 3).join('; ')
        : '';
      return { applied: true, peerId, meta };
    }

    function applyNatMappingError(peerId, error) {
      const meta = getPeerMeta(peerId);
      if (!meta) {
        return { applied: false, peerId, reason: 'missing-meta' };
      }
      meta.natMappingCompletedAt = Date.now();
      meta.natMappingDurationMs = meta.natMappingStartedAt ? meta.natMappingCompletedAt - meta.natMappingStartedAt : null;
      meta.natMappingSuccess = false;
      meta.natMappingResultReason = 'nat-mapping-error';
      meta.natMappingError = error && error.message ? error.message : String(error);
      return { applied: true, peerId, meta };
    }

    function finishNatMappingAttempt(peerId) {
      const meta = getPeerMeta(peerId);
      if (!meta) {
        return null;
      }
      meta.natMappingInProgress = false;
      return meta;
    }

    function sendNatMappedCandidatesAndArmWait(peerId, candidates, messageOptions = {}) {
      const mappedCandidates = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
      if (!peerId || mappedCandidates.length === 0) {
        return { sent: false, peerId, count: 0, reason: 'missing-candidates' };
      }
      const roomId = messageOptions.roomId || (typeof options.getCurrentRoomId === 'function' ? options.getCurrentRoomId() : '');
      for (const mappedCandidate of mappedCandidates) {
        sendSignalMessage({
          type: 'ice-candidate',
          targetId: peerId,
          roomId,
          candidate: mappedCandidate,
          trickle: true,
          natMapping: true
        });
      }
      if (messageOptions.armWait !== false) {
        armPeerNatMappingWait(peerId, messageOptions.timeoutMs, messageOptions.onTimeout);
      }
      return { sent: true, peerId, count: mappedCandidates.length, roomId };
    }

    async function attemptLastChanceNatMapping(peerId, reason, natOptions = {}) {
      const mediaEngine = options.mediaEngine || null;
      if (!mediaEngine || typeof mediaEngine.openNatMapping !== 'function') {
        return false;
      }

      const natMappingAttempt = beginNatMappingAttempt(peerId, reason, natOptions.candidateLimit);
      if (!natMappingAttempt || !natMappingAttempt.started) {
        return false;
      }

      const candidates = Array.isArray(natMappingAttempt.candidates) ? natMappingAttempt.candidates : [];
      logNativeStep('peer-nat-mapping:start', {
        peerId,
        reason,
        candidateCount: candidates.length
      }, 'p2p');
      if (typeof options.setP2pStateForPeer === 'function') {
        options.setP2pStateForPeer(peerId, 'nat-mapping');
      }
      const isHost = typeof options.isHost === 'function' ? Boolean(options.isHost()) : Boolean(options.isHost);
      if (!isHost && typeof options.setViewerConnectionState === 'function') {
        options.setViewerConnectionState('纯 P2P 直连失败，正在尝试路由器端口映射...');
      }

      const timeoutMs = Number.isFinite(Number(natOptions.timeoutMs)) && Number(natOptions.timeoutMs) > 0
        ? Number(natOptions.timeoutMs)
        : 6000;
      const setTimer = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
        ? window.setTimeout.bind(window)
        : setTimeout;

      try {
        const result = await Promise.race([
          mediaEngine.openNatMapping({
            peerId,
            candidates,
            lifetimeSeconds: 180
          }),
          new Promise((_, reject) => {
            setTimer(() => reject(new Error('nat-mapping-timeout')), timeoutMs);
          })
        ]);
        logNativeStep('peer-nat-mapping:result', {
          peerId,
          ok: Boolean(result && result.ok),
          reason: result && result.reason,
          protocol: result && result.protocol,
          mappedCandidates: result && Array.isArray(result.candidates) ? result.candidates.length : 0
        }, 'p2p');
        applyNatMappingResult(peerId, result);
        if (!result || !result.ok || !Array.isArray(result.candidates) || result.candidates.length === 0) {
          return false;
        }
        sendNatMappedCandidatesAndArmWait(peerId, result.candidates, { roomId: natOptions.roomId });
        return true;
      } catch (error) {
        applyNatMappingError(peerId, error);
        logNativeStep('peer-nat-mapping:failed', {
          peerId,
          message: error && error.message ? error.message : String(error)
        }, 'p2p');
        return false;
      } finally {
        finishNatMappingAttempt(peerId);
        if (typeof options.renderP2pDiagnosticReport === 'function') {
          options.renderP2pDiagnosticReport();
        }
      }
    }

    async function finalizeP2pFailureWithNatMapping(peerId, reason, source, failureOptions = {}) {
      const prepared = prepareP2pFailureFinalization(peerId);
      if (!prepared || !prepared.prepared) {
        return prepared;
      }
      clearPeerConnectTimeout(peerId);
      const fallbackStarted = await attemptLastChanceNatMapping(peerId, reason, {
        roomId: failureOptions.roomId
      });
      if (fallbackStarted) {
        return { finalized: false, fallbackStarted: true, peerId, reason, source };
      }
      return finalizeP2pConnectionFailureAndApply(peerId, reason, source);
    }

    function prepareConnectFailfastTimeout(peerId) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      if (!peerId || !meta) {
        return { ready: false, peerId, handle, meta, reason: 'missing-meta' };
      }
      if (meta.hasConnected) {
        return { ready: false, peerId, handle, meta, reason: 'already-connected' };
      }
      if (!handle) {
        return { ready: false, peerId, handle, meta, reason: 'missing-handle' };
      }
      if (handle.closed) {
        return { ready: false, peerId, handle, meta, reason: 'closed-handle' };
      }
      if (handle.connectionState === 'connected') {
        return { ready: false, peerId, handle, meta, reason: 'already-connected' };
      }
      return { ready: true, peerId, handle, meta };
    }

    function classifyConnectionFailure(meta) {
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

    function prepareNatMappingWaitTimeout(peerId) {
      const handle = getPeerHandle(peerId);
      const meta = getPeerMeta(peerId);
      if (!peerId || !meta) {
        return { ready: false, peerId, handle, meta, reason: 'missing-meta' };
      }
      if (meta.hasConnected) {
        return { ready: false, peerId, handle, meta, reason: 'already-connected' };
      }
      if (!handle) {
        return { ready: false, peerId, handle, meta, reason: 'missing-handle' };
      }
      if (handle.closed) {
        return { ready: false, peerId, handle, meta, reason: 'closed-handle' };
      }
      if (handle.connectionState === 'connected') {
        return { ready: false, peerId, handle, meta, reason: 'already-connected' };
      }
      return { ready: true, peerId, handle, meta };
    }

    function applyPeerStateEvent(params) {
      if (!params || !params.peerId) {
        return { handled: false, reason: 'missing-peer-id' };
      }
      const peerId = params.peerId;
      const handle = getPeerHandle(peerId);
      if (!handle) {
        return { handled: false, reason: 'missing-handle' };
      }
      const meta = getPeerMeta(peerId);
      const state = String(params.state || '');

      if (state === 'connected') {
        handle.connectionState = 'connected';
        handle.iceConnectionState = 'connected';
        if (meta) {
          meta.hasConnected = true;
          meta.restartInProgress = false;
        }
        clearPeerConnectTimeout(peerId);
        clearPeerDisconnectTimer(peerId);
        clearPeerReconnect(peerId);
        return {
          handled: true,
          peerId,
          state,
          handle,
          meta,
          uiState: handle.role === 'viewer-upstream' ? 'media-waiting' : 'connected',
          armViewerMediaWait: handle.role === 'viewer-upstream',
          effects: [
            { type: 'setP2pState', peerId, state: handle.role === 'viewer-upstream' ? 'media-waiting' : 'connected' },
            ...(handle.role === 'viewer-upstream' ? [{ type: 'armViewerMediaWaitTimer', peerId }] : [])
          ]
        };
      }

      if (state === 'connecting') {
        handle.connectionState = 'connecting';
        handle.iceConnectionState = 'checking';
        return {
          handled: true,
          peerId,
          state,
          handle,
          meta,
          uiState: 'checking',
          effects: [{ type: 'setP2pState', peerId, state: 'checking' }]
        };
      }

      if (state === 'disconnected') {
        handle.connectionState = 'disconnected';
        handle.iceConnectionState = 'disconnected';
        return {
          handled: true,
          peerId,
          state,
          handle,
          meta,
          uiState: meta && meta.hasConnected ? 'restart-attempting' : 'checking',
          scheduleDisconnectedRecovery: true,
          effects: [
            { type: 'setP2pState', peerId, state: meta && meta.hasConnected ? 'restart-attempting' : 'checking' },
            { type: 'scheduleDisconnectedRecovery', peerId, handle }
          ]
        };
      }

      if (state === 'failed') {
        handle.connectionState = 'failed';
        handle.iceConnectionState = 'failed';
        return {
          handled: true,
          peerId,
          state,
          handle,
          meta,
          clearViewerMediaWait: handle.role === 'viewer-upstream',
          finalizeFailure: true,
          failureFinalization: {
            reason: 'ICE failed',
            source: 'ice-failed'
          },
          effects: [
            ...(handle.role === 'viewer-upstream' ? [{ type: 'clearViewerMediaWaitTimer' }] : []),
            {
              type: 'finalizeP2pFailure',
              peerId,
              reason: 'ICE failed',
              source: 'ice-failed'
            }
          ]
        };
      }

      if (state === 'closed') {
        handle.connectionState = 'closed';
        handle.iceConnectionState = 'closed';
        handle.closed = true;
        return { handled: true, peerId, state, handle, meta };
      }

      return { handled: false, peerId, state, handle, meta, reason: 'unknown-state' };
    }

    function applyPeerStateEffects(effects) {
      if (!Array.isArray(effects)) {
        return;
      }
      effects.forEach((effect) => {
        if (!effect || typeof effect !== 'object') {
          return;
        }
        if (effect.type === 'setP2pState' && effect.peerId && effect.state) {
          if (typeof options.setP2pStateForPeer === 'function') {
            options.setP2pStateForPeer(effect.peerId, effect.state);
          }
        } else if (effect.type === 'armViewerMediaWaitTimer' && effect.peerId) {
          if (typeof options.armViewerMediaWaitTimer === 'function') {
            options.armViewerMediaWaitTimer(effect.peerId);
          }
        } else if (effect.type === 'scheduleDisconnectedRecovery' && effect.peerId && effect.handle) {
          scheduleDisconnectedRecovery(effect.peerId, effect.handle);
        } else if (effect.type === 'clearViewerMediaWaitTimer') {
          if (typeof options.clearViewerMediaWaitTimer === 'function') {
            options.clearViewerMediaWaitTimer();
          }
        } else if (effect.type === 'finalizeP2pFailure' && effect.peerId) {
          void finalizeP2pFailureWithNatMapping(
            effect.peerId,
            effect.reason || 'ICE failed',
            effect.source || 'ice-failed'
          );
        }
      });
    }

    function handlePeerStateEvent(params) {
      const result = applyPeerStateEvent(params);
      if (!result || !result.handled) {
        return result;
      }
      applyPeerStateEffects(result.effects);
      return result;
    }

    function getPeerHandle(peerId) {
      return peerHandleRegistry.get(peerId);
    }

    function setPeerHandle(peerId, handle) {
      return peerHandleRegistry.set(peerId, handle);
    }

    function nextPeerAttemptId() {
      return peerHandleRegistry.nextAttemptId();
    }

    function getPeerRole(isHost, kind) {
      return isHost
        ? 'host-downstream'
        : (kind === 'relay-viewer' ? 'relay-downstream' : 'viewer-upstream');
    }

    function createPeerHandle(params = {}) {
      if (!options.mediaEngine || typeof options.mediaEngine.createPeer !== 'function') {
        throw new Error('native-peer-media-engine-unavailable');
      }
      const peerId = params.peerId;
      const kind = params.kind || 'direct';
      const initiator = Boolean(params.isInitiator);
      const attemptId = nextPeerAttemptId();
      const role = getPeerRole(Boolean(params.isHost), kind);
      const encodedMediaDataChannel = params.encodedMediaDataChannel !== false;
      const handle = {
        __nativePeerHandle: true,
        peerId,
        role,
        kind,
        initiator,
        attemptId,
        encodedMediaDataChannel,
        relaySourcePeerId: null,
        connectionState: 'new',
        iceConnectionState: 'new',
        signalingState: 'stable',
        localDescription: null,
        remoteDescription: null,
        closed: false,
        __readyPromise: options.mediaEngine.createPeer({
          peerId,
          role,
          initiator,
          encodedMediaDataChannel,
          mediaManifest: params.mediaManifest || null
        })
      };
      setPeerHandle(peerId, handle);
      return handle;
    }

    function createPeerConnection(peerId, isInitiator, kind = 'direct', createOptions = {}) {
      clearSignalState(peerId);
      const handle = createPeerHandle({
        peerId,
        isInitiator,
        kind,
        isHost: typeof options.isHost === 'function' ? Boolean(options.isHost()) : Boolean(options.isHost),
        encodedMediaDataChannel: createOptions.encodedMediaDataChannel !== false,
        mediaManifest: createOptions.mediaManifest || null
      });
      if (typeof options.setPeerConnection === 'function') {
        options.setPeerConnection(peerId, handle);
      }
      initializePeerMetaForHandle(peerId, handle, isInitiator, kind);
      if (typeof options.setP2pStateForPeer === 'function') {
        options.setP2pStateForPeer(peerId, 'gathering');
      }
      armPeerConnectFailfast(peerId);
      return handle;
    }

    async function recreatePeerForRemoteOffer(peerId, decision = {}, callbacks = {}) {
      const existingHandle = callbacks.existingHandle || getPeerHandle(peerId);
      if (decision.shouldCloseExisting && existingHandle) {
        if (typeof callbacks.closePeer === 'function') {
          await callbacks.closePeer(peerId, existingHandle);
        } else {
          await closePeerConnection(peerId, callbacks.closeOptions || {});
        }
      }
      const handle = typeof callbacks.createPeer === 'function'
        ? callbacks.createPeer(peerId, false, callbacks.kind || 'upstream', {
          mediaManifest: callbacks.mediaManifest || null
        })
        : createPeerConnection(peerId, false, callbacks.kind || 'upstream', {
          mediaManifest: callbacks.mediaManifest || null
        });
      return { action: 'created', peerId, handle, shouldCloseExisting: Boolean(decision.shouldCloseExisting) };
    }

    function isNativePeerHandle(handle) {
      return Boolean(handle && handle.__nativePeerHandle);
    }

    function logNativeStep(scope, payload, category) {
      if (typeof options.logNativeStep === 'function') {
        options.logNativeStep(scope, payload, category);
      }
    }

    function sendSignalMessage(message) {
      if (message && message.type === 'viewer-reconnect-ready') {
        return sendViewerReconnectReady(message);
      }
      if (options.roomClient && typeof options.roomClient.sendSignal === 'function') {
        return options.roomClient.sendSignal(message);
      }
      if (options.roomClient && typeof options.roomClient.sendMessage === 'function') {
        return options.roomClient.sendMessage(message);
      }
      throw new Error('native-peer-room-client-unavailable');
    }

    function sendViewerReconnectReady(optionsForReconnect = {}) {
      if (options.roomClient && typeof options.roomClient.sendViewerReconnectReady === 'function') {
        return options.roomClient.sendViewerReconnectReady(optionsForReconnect);
      }
      if (typeof options.sendViewerReconnectReady === 'function') {
        return options.sendViewerReconnectReady(optionsForReconnect);
      }
      throw new Error('native-peer-viewer-reconnect-room-client-unavailable');
    }

    async function ensurePeerReady(peerId, handle) {
      if (!isNativePeerHandle(handle)) {
        return;
      }
      if (handle.closed || getPeerHandle(peerId) !== handle) {
        throw new Error(`native-peer-stale:${peerId}`);
      }
      logNativeStep('createPeer:awaitReady', { peerId, role: handle.role, kind: handle.kind });
      await handle.__readyPromise;
      if (handle.closed || getPeerHandle(peerId) !== handle) {
        throw new Error(`native-peer-stale:${peerId}`);
      }
      logNativeStep('createPeer:ready', { peerId, role: handle.role, kind: handle.kind });
    }

    async function attachPeerMediaSources(peerId, handle) {
      if (!isNativePeerHandle(handle)) {
        throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
      }
      if (!options.mediaEngine || typeof options.mediaEngine.attachPeerMediaSource !== 'function') {
        throw new Error('native-peer-media-engine-unavailable');
      }

      if (handle.kind === 'relay-viewer') {
        const relaySourcePeerId = handle.relaySourcePeerId || (typeof options.getUpstreamPeerId === 'function' ? options.getUpstreamPeerId() : '');
        if (!relaySourcePeerId) {
          throw new Error('native-relay-upstream-peer-missing');
        }

        await ensurePeerReady(peerId, handle);
        if (handle.closed || getPeerHandle(peerId) !== handle) {
          throw new Error(`native-peer-stale:${peerId}`);
        }
        return options.mediaEngine.attachPeerMediaSource({
          peerId,
          source: `peer-video:${relaySourcePeerId}`
        });
      }

      const isHost = typeof options.isHost === 'function' ? Boolean(options.isHost()) : Boolean(options.isHost);
      if (!isHost) {
        return null;
      }

      const nativeHostSessionRunning = typeof options.isNativeHostSessionRunning === 'function'
        ? Boolean(options.isNativeHostSessionRunning())
        : Boolean(options.nativeHostSessionRunning);
      if (!nativeHostSessionRunning) {
        throw new Error('native-host-session-not-running');
      }

      await ensurePeerReady(peerId, handle);
      if (handle.closed || getPeerHandle(peerId) !== handle) {
        throw new Error(`native-peer-stale:${peerId}`);
      }
      return options.mediaEngine.attachPeerMediaSource({
        peerId,
        source: 'host-session-video'
      });
    }

    async function setRemoteDescription(peerId, handle, description, mediaManifest) {
      if (!isNativePeerHandle(handle)) {
        throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
      }
      if (!options.mediaEngine || typeof options.mediaEngine.setRemoteDescription !== 'function') {
        throw new Error('native-peer-media-engine-unavailable');
      }

      logNativeStep('setRemoteDescription:request', {
        peerId,
        type: description.type,
        sdpLength: description && description.sdp ? String(description.sdp).length : 0
      });
      await ensurePeerReady(peerId, handle);
      await options.mediaEngine.setRemoteDescription({
        peerId,
        type: description.type,
        sdp: description.sdp,
        mediaManifest: mediaManifest || null
      });
      logNativeStep('setRemoteDescription:applied', {
        peerId,
        type: description.type
      });
    }

    async function applyRemoteDescription(peerId, handle, description, mediaManifest) {
      const remoteDescription = normalizeSessionDescription(description);
      await setRemoteDescription(peerId, handle, remoteDescription, mediaManifest || null);
      handle.remoteDescription = remoteDescription;
      handle.signalingState = remoteDescription.type === 'offer' ? 'have-remote-offer' : 'stable';
      return { action: 'applied', peerId, handle, remoteDescription };
    }

    async function handleRemoteAnswer(peerId, description, attemptId, mediaManifest) {
      const decision = prepareRemoteAnswer(peerId, description, attemptId);
      if (decision.action === 'ignore') {
        return decision;
      }
      if (decision.action === 'flush') {
        return { ...decision, flushQueuedCandidates: true };
      }
      if (decision.action === 'apply') {
        const applied = await applyRemoteDescription(peerId, decision.handle, decision.remoteDescription, mediaManifest || null);
        return { ...applied, flushQueuedCandidates: true };
      }
      return { action: 'ignore', peerId, reason: 'unknown-decision' };
    }

    async function finalizeRemoteAnswer(peerId, description, attemptId, mediaManifest) {
      const result = await handleRemoteAnswer(peerId, description, attemptId, mediaManifest || null);
      if (result.action === 'ignore') {
        return result;
      }
      if (result.flushQueuedCandidates) {
        const flushResult = await flushQueuedRemoteCandidates(peerId, result.handle);
        return { ...result, flushResult };
      }
      return result;
    }

    async function handleRemoteOffer(peerId, description, attemptId, mediaManifest) {
      const decision = prepareRemoteOffer(peerId, description, attemptId);
      if (decision.action === 'ignore') {
        return decision;
      }
      if (decision.action === 'flush') {
        return { ...decision, flushQueuedCandidates: true };
      }
      if (decision.action === 'recreate') {
        return { ...decision, recreatePeer: true };
      }
      if (decision.action === 'reuse') {
        const meta = getPeerMeta(peerId);
        if (attemptId && meta) {
          meta.edgeAttemptId = attemptId;
        }
        const applied = await applyRemoteDescription(peerId, decision.handle, decision.remoteDescription, mediaManifest || null);
        return { ...applied, flushQueuedCandidates: true, answerRequired: true };
      }
      return { action: 'ignore', peerId, reason: 'unknown-decision' };
    }

    async function applyRecreatedRemoteOffer(peerId, handle, description, attemptId, mediaManifest, kind = 'upstream') {
      applyRemoteOfferAttempt(peerId, attemptId, kind);
      const applied = await applyRemoteDescription(peerId, handle, description, mediaManifest || null);
      return { ...applied, flushQueuedCandidates: true, answerRequired: true };
    }

    async function attachViewerRemoteOfferSurface(peerId) {
      if (options.surfaceController && typeof options.surfaceController.attachPeerVideoSurface === 'function') {
        return options.surfaceController.attachPeerVideoSurface(peerId);
      }
      if (typeof options.attachPeerVideoSurface === 'function') {
        return options.attachPeerVideoSurface(peerId);
      }
      return null;
    }

    function prepareViewerUpstreamSwitch(params = {}) {
      const isHost = Boolean(params.isHost);
      const nextUpstreamPeerId = params.nextUpstreamPeerId ? String(params.nextUpstreamPeerId) : '';
      const currentUpstreamPeerId = params.currentUpstreamPeerId ? String(params.currentUpstreamPeerId) : '';
      if (isHost) {
        return {
          shouldUpdateUpstream: false,
          switchingViewerUpstream: false,
          resetViewerState: false,
          clearMediaWaitTimer: false,
          clearOfferWaitTimer: false,
          staleCleanupRequired: false,
          nextUpstreamPeerId: '',
          previousUpstreamPeerId: currentUpstreamPeerId,
          connectionLabel: '',
          reason: 'host'
        };
      }
      if (!nextUpstreamPeerId) {
        return {
          shouldUpdateUpstream: false,
          switchingViewerUpstream: false,
          resetViewerState: false,
          clearMediaWaitTimer: false,
          clearOfferWaitTimer: false,
          staleCleanupRequired: false,
          nextUpstreamPeerId: '',
          previousUpstreamPeerId: currentUpstreamPeerId,
          connectionLabel: '',
          reason: 'missing-next-upstream'
        };
      }
      const switchingViewerUpstream = Boolean(currentUpstreamPeerId && currentUpstreamPeerId !== nextUpstreamPeerId);
      return {
        shouldUpdateUpstream: true,
        switchingViewerUpstream,
        resetViewerState: switchingViewerUpstream,
        clearMediaWaitTimer: switchingViewerUpstream,
        clearOfferWaitTimer: switchingViewerUpstream,
        staleCleanupRequired: switchingViewerUpstream,
        nextUpstreamPeerId,
        previousUpstreamPeerId: currentUpstreamPeerId,
        connectionLabel: switchingViewerUpstream ? '正在切换上游连接...' : '',
        reason: switchingViewerUpstream ? 'switch-upstream' : 'same-or-first-upstream'
      };
    }

    async function addRemoteIceCandidate(peerId, handle, candidate) {
      if (!isNativePeerHandle(handle)) {
        throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
      }
      if (!options.mediaEngine || typeof options.mediaEngine.addRemoteIceCandidate !== 'function') {
        throw new Error('native-peer-media-engine-unavailable');
      }

      logNativeStep('addRemoteIceCandidate:request', {
        peerId,
        candidateLength: candidate ? String(candidate).length : 0
      });
      await ensurePeerReady(peerId, handle);
      await options.mediaEngine.addRemoteIceCandidate({
        peerId,
        candidate
      });
      logNativeStep('addRemoteIceCandidate:applied', { peerId });
    }

    async function applyRemoteIceCandidate(peerId, handle, candidate) {
      if (!isNativePeerHandle(handle)) {
        throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
      }
      if (!isAllowedPureP2pCandidate(candidate)) {
        return { action: 'block', peerId, handle, reason: 'relay-candidate' };
      }

      const candidateKey = buildRemoteCandidateKey(candidate);
      if (hasRemoteCandidate(peerId, candidateKey)) {
        return { action: 'duplicate', peerId, handle, candidateKey };
      }

      await addRemoteIceCandidate(peerId, handle, candidate);
      rememberRemoteCandidate(peerId, candidateKey);
      return { action: 'apply', peerId, handle, candidateKey, uiState: 'checking' };
    }

    async function handleRemoteIceCandidate(peerId, candidate, attemptId) {
      const decision = prepareRemoteIceCandidate(peerId, candidate, attemptId);
      if (decision.action === 'ignore') {
        return decision;
      }
      if (decision.action === 'queue') {
        queuePendingRemoteCandidate(peerId, candidate);
        return { ...decision, queued: true };
      }
      if (decision.action === 'apply') {
        return applyRemoteIceCandidate(peerId, decision.handle, candidate);
      }
      return { action: 'ignore', peerId, reason: 'unknown-decision' };
    }

    function buildRemoteIceCandidateEffects(result, attemptId) {
      const effects = [];
      if (result && result.action === 'ignore' && result.reason === 'stale-attempt') {
        effects.push({
          type: 'logNativeStep',
          scope: 'signal:ice-candidate:ignored',
          payload: { peerId: result.peerId, attemptId, reason: 'stale-attempt' },
          category: 'connection'
        });
      } else if (result && result.action === 'block') {
        effects.push({
          type: 'logNativeStep',
          scope: 'addRemoteIceCandidate:blocked-relay',
          payload: { peerId: result.peerId },
          category: 'p2p'
        });
      }
      if (result && result.uiState) {
        effects.push({ type: 'setP2pState', peerId: result.peerId, state: result.uiState });
      }
      return effects;
    }

    function applyRemoteIceCandidateEffects(effects) {
      if (!Array.isArray(effects)) {
        return;
      }
      effects.forEach((effect) => {
        if (!effect || typeof effect !== 'object') {
          return;
        }
        if (effect.type === 'logNativeStep') {
          logNativeStep(effect.scope, effect.payload || {}, effect.category);
        } else if (effect.type === 'setP2pState' && effect.peerId && effect.state) {
          if (typeof options.setP2pStateForPeer === 'function') {
            options.setP2pStateForPeer(effect.peerId, effect.state);
          }
        }
      });
    }

    function applyQueuedRemoteCandidateFlushResult(peerId, result) {
      const results = result && Array.isArray(result.results) ? result.results : [];
      for (const entry of results) {
        applyRemoteIceCandidateEffects(buildRemoteIceCandidateEffects({ ...entry, peerId }, null));
      }
    }

    async function finalizeRemoteIceCandidate(peerId, candidate, attemptId) {
      const result = await handleRemoteIceCandidate(peerId, candidate, attemptId);
      return { ...result, effects: buildRemoteIceCandidateEffects(result, attemptId) };
    }

    async function flushQueuedRemoteCandidates(peerId, handle) {
      const queued = takePendingRemoteCandidates(peerId);
      if (!queued.length) {
        return { action: 'none', peerId, handle, queuedCount: 0, results: [] };
      }

      const results = [];
      for (const candidate of queued) {
        results.push(await applyRemoteIceCandidate(peerId, handle, candidate));
      }
      return {
        action: 'flush',
        peerId,
        handle,
        queuedCount: queued.length,
        results,
        uiState: results.find((result) => result && result.uiState)?.uiState || ''
      };
    }

    async function closePeer(peerId, handle) {
      const currentHandle = handle || getPeerHandle(peerId);
      if (!currentHandle) {
        return null;
      }
      if (!isNativePeerHandle(currentHandle)) {
        throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
      }
      currentHandle.closed = true;
      if (options.mediaEngine && typeof options.mediaEngine.detachPeerMediaSource === 'function') {
        await options.mediaEngine.detachPeerMediaSource({ peerId }).catch(() => {});
      }
      if (options.mediaEngine && typeof options.mediaEngine.closePeer === 'function') {
        await options.mediaEngine.closePeer({ peerId }).catch(() => {});
      }
      deletePeerHandle(peerId);
      return null;
    }

    async function closePeerConnection(peerId, closeOptions = {}) {
      const handle = getPeerHandle(peerId);
      if (!handle) {
        const existing = typeof options.getPeerConnection === 'function'
          ? options.getPeerConnection(peerId)
          : null;
        if (existing) {
          throw new Error(`unexpected-renderer-peer-handle:${peerId}`);
        }
        return null;
      }

      const sessionRole = typeof options.getSessionRole === 'function' ? options.getSessionRole() : '';
      const upstreamPeerId = typeof options.getUpstreamPeerId === 'function' ? options.getUpstreamPeerId() : '';
      const closeCleanupDecision = preparePeerCloseCleanup(peerId, {
        handle,
        sessionRole,
        upstreamPeerId,
        clearRetryState: closeOptions.clearRetryState
      });
      handle.closed = true;
      try {
        if (options.surfaceController && typeof options.surfaceController.detachPeerVideoSurface === 'function') {
          await options.surfaceController.detachPeerVideoSurface(peerId).catch(() => {});
        }
        await closePeer(peerId, handle);
      } finally {
        applyPeerCloseCleanupEffects(peerId, closeCleanupDecision);
      }
      return null;
    }

    function preparePeerCloseCleanup(peerId, cleanupOptions = {}) {
      const handle = cleanupOptions.handle || getPeerHandle(peerId);
      const closingCurrentViewerUpstream = Boolean(
        handle &&
        handle.role === 'viewer-upstream' &&
        cleanupOptions.sessionRole === 'viewer' &&
        cleanupOptions.upstreamPeerId === peerId
      );
      const cleanup = {
        peerId,
        deleteNativePeerHandle: true,
        deletePeerConnection: true,
        deletePeerMeta: true,
        clearPendingRemoteCandidates: true,
        clearPeerSignalState: true,
        clearPeerConnectTimeout: true,
        clearPeerDisconnectTimer: true,
        closingCurrentViewerUpstream,
        clearViewerMediaWaitTimer: closingCurrentViewerUpstream,
        clearViewerUpstreamOfferWaitTimer: closingCurrentViewerUpstream,
        resetViewerUpstreamOfferReconnectPeer: closingCurrentViewerUpstream,
        resetViewerUpstreamOfferReconnectPeerId: closingCurrentViewerUpstream ? peerId : '',
        clearPeerReconnect: Boolean(cleanupOptions.clearRetryState),
        clearPeerReconnectId: cleanupOptions.clearRetryState ? peerId : '',
        renderP2pDiagnosticReport: true
      };
      cleanup.effects = buildPeerCloseCleanupEffects(cleanup);
      return cleanup;
    }

    function buildPeerCloseCleanupEffects(cleanup = {}) {
      const peerId = cleanup.peerId || '';
      const effects = [];
      if (cleanup.deleteNativePeerHandle) {
        effects.push({ type: 'deleteNativePeerHandle', peerId });
      }
      if (cleanup.deletePeerConnection) {
        effects.push({ type: 'deletePeerConnection', peerId });
      }
      if (cleanup.deletePeerMeta) {
        effects.push({ type: 'deletePeerMeta', peerId });
      }
      if (cleanup.clearPendingRemoteCandidates) {
        effects.push({ type: 'clearPendingRemoteCandidates', peerId });
      }
      if (cleanup.clearPeerSignalState) {
        effects.push({ type: 'clearPeerSignalState', peerId });
      }
      if (cleanup.clearPeerConnectTimeout) {
        effects.push({ type: 'clearPeerConnectTimeout', peerId });
      }
      if (cleanup.clearPeerDisconnectTimer) {
        effects.push({ type: 'clearPeerDisconnectTimer', peerId });
      }
      if (cleanup.clearViewerMediaWaitTimer) {
        effects.push({ type: 'clearViewerMediaWaitTimer' });
      }
      if (cleanup.clearViewerUpstreamOfferWaitTimer) {
        effects.push({ type: 'clearViewerUpstreamOfferWaitTimer' });
      }
      if (cleanup.resetViewerUpstreamOfferReconnectPeer) {
        effects.push({
          type: 'resetViewerUpstreamOfferReconnectPeer',
          peerId: cleanup.resetViewerUpstreamOfferReconnectPeerId || peerId
        });
      }
      if (cleanup.clearPeerReconnect) {
        effects.push({ type: 'clearPeerReconnect', peerId: cleanup.clearPeerReconnectId || peerId });
      }
      if (cleanup.renderP2pDiagnosticReport) {
        effects.push({ type: 'renderP2pDiagnosticReport' });
      }
      return effects;
    }

    function applyPeerCloseCleanupEffects(peerId, cleanupDecision = {}) {
      const effects = Array.isArray(cleanupDecision.effects)
        ? cleanupDecision.effects
        : buildPeerCloseCleanupEffects({ ...cleanupDecision, peerId });
      effects.forEach((effect) => {
        if (!effect || typeof effect !== 'object') {
          return;
        }
        const targetPeerId = effect.peerId || peerId;
        if (effect.type === 'deleteNativePeerHandle') {
          deletePeerHandle(targetPeerId);
        } else if (effect.type === 'deletePeerConnection') {
          if (typeof options.deletePeerConnection === 'function') {
            options.deletePeerConnection(targetPeerId);
          }
        } else if (effect.type === 'deletePeerMeta') {
          if (typeof options.deletePeerMeta === 'function') {
            options.deletePeerMeta(targetPeerId);
          }
        } else if (effect.type === 'clearPendingRemoteCandidates') {
          clearPendingRemoteCandidates(targetPeerId);
        } else if (effect.type === 'clearPeerSignalState') {
          clearSignalState(targetPeerId);
        } else if (effect.type === 'clearPeerConnectTimeout') {
          clearPeerConnectTimeout(targetPeerId);
        } else if (effect.type === 'clearPeerDisconnectTimer') {
          clearPeerDisconnectTimer(targetPeerId);
        } else if (effect.type === 'clearViewerMediaWaitTimer') {
          if (typeof options.clearViewerMediaWaitTimer === 'function') {
            options.clearViewerMediaWaitTimer();
          }
        } else if (effect.type === 'clearViewerUpstreamOfferWaitTimer') {
          if (typeof options.clearViewerUpstreamOfferWaitTimer === 'function') {
            options.clearViewerUpstreamOfferWaitTimer();
          }
        } else if (effect.type === 'resetViewerUpstreamOfferReconnectPeer') {
          if (typeof options.resetViewerUpstreamOfferReconnectPeer === 'function') {
            options.resetViewerUpstreamOfferReconnectPeer(targetPeerId);
          }
        } else if (effect.type === 'clearPeerReconnect') {
          clearPeerReconnect(targetPeerId);
        } else if (effect.type === 'renderP2pDiagnosticReport') {
          if (typeof options.renderP2pDiagnosticReport === 'function') {
            options.renderP2pDiagnosticReport();
          }
        }
      });
    }

    async function closeAllPeers(callbacks = {}) {
      const peerIds = getPeerHandleIds();
      const closedPeerIds = [];
      for (const peerId of peerIds) {
        if (typeof callbacks.closePeer === 'function') {
          await callbacks.closePeer(peerId, callbacks.options || {});
        } else {
          await closePeerConnection(peerId, callbacks.options || {});
        }
        closedPeerIds.push(peerId);
      }
      return { peerIds, closedPeerIds };
    }

    function deletePeerHandle(peerId) {
      return peerHandleRegistry.delete(peerId);
    }

    function getPeerHandleCount() {
      return peerHandleRegistry.count();
    }

    function getPeerHandleEntries() {
      return peerHandleRegistry.entries();
    }

    function getPeerHandleIds() {
      return peerHandleRegistry.ids();
    }

    function getStalePeerIds(activePeerId) {
      return getPeerHandleIds().filter((peerId) => peerId && peerId !== activePeerId);
    }

    function scheduleStalePeerCleanup(activePeerId, cleanupOptions = {}) {
      if (!activePeerId) {
        return { scheduled: false, activePeerId, stalePeerIds: [], reason: 'missing-active-peer' };
      }
      const stalePeerIds = getStalePeerIds(activePeerId);
      if (stalePeerIds.length === 0) {
        return { scheduled: false, activePeerId, stalePeerIds, reason: 'none' };
      }
      const delayMs = Number.isFinite(Number(cleanupOptions.delayMs)) && Number(cleanupOptions.delayMs) >= 0
        ? Number(cleanupOptions.delayMs)
        : 250;
      const timerId = setTimeout(() => {
        stalePeerIds.forEach((peerId) => {
          const isActive = typeof cleanupOptions.isPeerActive === 'function'
            ? cleanupOptions.isPeerActive(peerId)
            : peerId === activePeerId;
          if (isActive) {
            return;
          }
          if (typeof cleanupOptions.closePeer === 'function') {
            cleanupOptions.closePeer(peerId);
          }
        });
      }, delayMs);
      return { scheduled: true, activePeerId, stalePeerIds, delayMs, timerId };
    }

    function pruneSignalBacklog(now = Date.now()) {
      let total = 0;
      const ttlMs = getSignalTtlMs();
      const perPeerLimit = getSignalBacklogPerPeerLimit();
      signalRegistry.forEachBacklog((entries, peerId) => {
        const filtered = Array.isArray(entries)
          ? entries.filter((entry) => !entry.__queuedAt || now - entry.__queuedAt <= ttlMs)
          : [];
        const trimmed = filtered.slice(-perPeerLimit);
        if (trimmed.length > 0) {
          signalRegistry.setBacklog(peerId, trimmed);
          total += trimmed.length;
        } else {
          signalRegistry.deleteBacklog(peerId);
        }
      });

      const totalLimit = getSignalBacklogTotalLimit();
      while (total > totalLimit && signalRegistry.backlogSize() > 0) {
        let oldestPeerId = null;
        let oldestQueuedAt = Number.POSITIVE_INFINITY;
        signalRegistry.forEachBacklog((entries, peerId) => {
          const queuedAt = Number(entries && entries[0] && entries[0].__queuedAt) || 0;
          if (queuedAt < oldestQueuedAt) {
            oldestQueuedAt = queuedAt;
            oldestPeerId = peerId;
          }
        });
        if (!oldestPeerId) {
          break;
        }
        const entries = signalRegistry.getBacklog(oldestPeerId) || [];
        entries.shift();
        total -= 1;
        if (entries.length > 0) {
          signalRegistry.setBacklog(oldestPeerId, entries);
        } else {
          signalRegistry.deleteBacklog(oldestPeerId);
        }
      }
    }

    function clearSignalState(peerId) {
      signalRegistry.deleteBacklog(peerId);
      signalRegistry.waiterKeys().forEach((key) => {
        if (key === `${peerId}:*` || key.startsWith(`${peerId}:`)) {
          signalRegistry.deleteWaiters(key);
        }
      });
    }

    function enqueueSignal(params) {
      const peerId = getSignalPeerId(params);
      if (!peerId) {
        return;
      }
      pruneSignalBacklog();

      const waiterKey = `${peerId}:${params.type || '*'}`;
      const waiters = signalRegistry.getWaiters(waiterKey);
      if (waiters && waiters.length > 0) {
        const resolve = waiters.shift();
        if (waiters.length === 0) {
          signalRegistry.deleteWaiters(waiterKey);
        }
        resolve(sanitizeSignalPayload(params));
        return;
      }

      if (!signalRegistry.hasBacklog(peerId)) {
        signalRegistry.setBacklog(peerId, []);
      }
      const backlogEntry = { ...params, __queuedAt: Date.now() };
      const backlog = signalRegistry.getBacklog(peerId);
      backlog.push(backlogEntry);
      const perPeerLimit = getSignalBacklogPerPeerLimit();
      if (backlog.length > perPeerLimit) {
        backlog.splice(0, backlog.length - perPeerLimit);
      }
      pruneSignalBacklog();
    }

    function waitForSignal(peerId, type, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        pruneSignalBacklog();
        const key = `${peerId}:${type || '*'}`;
        const backlog = signalRegistry.getBacklog(peerId) || [];
        const backlogIndex = backlog.findIndex((entry) => !type || type === '*' || entry.type === type);
        if (backlogIndex >= 0) {
          const [payload] = backlog.splice(backlogIndex, 1);
          if (backlog.length > 0) {
            signalRegistry.setBacklog(peerId, backlog);
          } else {
            signalRegistry.deleteBacklog(peerId);
          }
          resolve(sanitizeSignalPayload(payload));
          return;
        }

        const timerId = setTimeout(() => {
          const waiters = signalRegistry.getWaiters(key) || [];
          const filtered = waiters.filter((entry) => entry !== resolver);
          if (filtered.length > 0) {
            signalRegistry.setWaiters(key, filtered);
          } else {
            signalRegistry.deleteWaiters(key);
          }
          reject(new Error(`native-peer-signal-timeout:${peerId}:${type || '*'}`));
        }, timeoutMs);

        const resolver = (payload) => {
          clearTimeout(timerId);
          resolve(payload);
        };

        if (!signalRegistry.hasWaiters(key)) {
          signalRegistry.setWaiters(key, []);
        }
        const waitersForKey = signalRegistry.getWaiters(key);
        if (waitersForKey.length >= getSignalWaiterPerKeyLimit()) {
          clearTimeout(timerId);
          reject(new Error(`native-peer-signal-waiter-limit:${peerId}:${type || '*'}`));
          return;
        }
        waitersForKey.push(resolver);
      });
    }

    function dropQueuedSignals(peerId, predicate) {
      if (!peerId || typeof predicate !== 'function') {
        return;
      }

      const backlog = signalRegistry.getBacklog(peerId);
      if (!Array.isArray(backlog) || backlog.length === 0) {
        return;
      }

      const filtered = backlog.filter((entry) => !predicate(entry));
      if (filtered.length > 0) {
        signalRegistry.setBacklog(peerId, filtered);
      } else {
        signalRegistry.deleteBacklog(peerId);
      }
    }

    function updateSignalState(peerId, params) {
      const handle = getPeerHandle(peerId);
      if (!handle || !params) {
        return;
      }
      if (params.sdp && params.type) {
        handle.localDescription = normalizeSessionDescription(params.sdp);
        if (params.type === 'offer') {
          handle.signalingState = 'have-local-offer';
        } else if (params.type === 'answer') {
          handle.signalingState = 'stable';
        }
      }
    }

    async function waitForMediaOffer(peerId, timeoutMs = 15000, signalOptions = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const signal = await waitForSignal(peerId, 'offer', remainingMs);
        if (isMediaOfferSignal(signal, signalOptions)) {
          return signal;
        }
      }
      throw new Error(`native-peer-media-offer-timeout:${peerId}`);
    }

    async function prepareOfferSignal(peerId, handle, signalOptions = {}) {
      if (!isNativePeerHandle(handle)) {
        throw new Error('renderer-peer-path-disabled-for-native-authority');
      }
      dropQueuedSignals(peerId, (entry) => entry && entry.type === 'offer');
      await ensurePeerReady(peerId, handle);
      await attachPeerMediaSources(peerId, handle);
      const allowEncodedDataChannel = Boolean(
        signalOptions.allowEncodedDataChannel !== undefined
          ? signalOptions.allowEncodedDataChannel
          : handle.encodedMediaDataChannel === true
      );

      let signal = null;
      if (
        handle.localDescription &&
        handle.localDescription.type === 'offer' &&
        isMediaOfferSignal(
          { type: 'offer', sdp: handle.localDescription },
          { allowEncodedDataChannel }
        )
      ) {
        signal = {
          peerId,
          targetId: peerId,
          type: 'offer',
          sdp: handle.localDescription
        };
      } else {
        signal = await waitForMediaOffer(
          peerId,
          signalOptions.timeoutMs || 15000,
          { allowEncodedDataChannel }
        );
      }

      updateSignalState(peerId, signal);
      return signal;
    }

    async function prepareOfferMessage(peerId, handle, messageOptions = {}) {
      const signal = await prepareOfferSignal(peerId, handle, messageOptions);
      const message = buildOfferMessage(peerId, signal, messageOptions);
      return { peerId, signal, message, sdp: signal && signal.sdp };
    }

    async function createAndSendOffer(peerId, handle, messageOptions = {}) {
      if (typeof options.setP2pStateForPeer === 'function') {
        options.setP2pStateForPeer(
          peerId,
          messageOptions.reconnect || messageOptions.iceRestart ? 'restart-attempting' : 'gathering'
        );
      }
      const prepared = await prepareOfferMessage(peerId, handle, messageOptions);
      sendSignalMessage(prepared.message);
      return prepared.sdp;
    }

    async function createAndSendPeerOffer(peerId, handle, offerOptions = {}) {
      if (!isNativePeerHandle(handle)) {
        throw new Error('renderer-peer-path-disabled-for-native-authority');
      }
      const encodedDataChannelRequested = handle.encodedMediaDataChannel === true;
      return createAndSendOffer(peerId, handle, {
        roomId: offerOptions.roomId || (typeof options.getCurrentRoomId === 'function' ? options.getCurrentRoomId() : ''),
        timeoutMs: offerOptions.timeoutMs || 15000,
        allowEncodedDataChannel: encodedDataChannelRequested,
        isRelay: offerOptions.isRelay,
        reconnect: offerOptions.reconnect,
        iceRestart: offerOptions.iceRestart
      });
    }

    function getCurrentMediaManifestSnapshot() {
      return typeof options.getCurrentMediaManifest === 'function' ? options.getCurrentMediaManifest() : null;
    }

    function normalizeMediaCodecName(codec) {
      const normalized = String(codec || '').trim().toLowerCase();
      if (!normalized) {
        return '';
      }
      if (normalized === 'hevc') {
        return 'h265';
      }
      if (normalized === 'mp4a.40.2') {
        return 'aac';
      }
      return normalized;
    }

    function normalizeCodecList(codecs) {
      if (!Array.isArray(codecs)) {
        return [];
      }
      return codecs.map(normalizeMediaCodecName).filter(Boolean);
    }

    function normalizePayloadFormat(value, fallback) {
      return String(value || fallback || '').trim().toLowerCase();
    }

    function normalizePayloadFormatList(formats) {
      if (!Array.isArray(formats)) {
        return [];
      }
      return formats.map((format) => normalizePayloadFormat(format, '')).filter(Boolean);
    }

    function getManifestCodecCompatibilityFailure(mediaCapabilities, mediaManifest) {
      if (!mediaManifest || typeof mediaManifest !== 'object') {
        return 'host-media-manifest-missing';
      }
      if (mediaManifest.protocol && mediaManifest.protocol !== 'vds-media-encoded-v1') {
        return 'host-media-manifest-protocol-unsupported';
      }
      const encoded = mediaCapabilities && mediaCapabilities.encodedMediaDataChannel;
      const videoCodec = normalizeMediaCodecName(mediaManifest.video && mediaManifest.video.codec);
      const supportedVideoCodecs = normalizeCodecList(encoded && encoded.supportedVideoCodecs);
      if (supportedVideoCodecs.length === 0) {
        return 'web-video-codec-capability-missing';
      }
      if (supportedVideoCodecs.length > 0 && (!videoCodec || !supportedVideoCodecs.includes(videoCodec))) {
        return `web-video-codec-unsupported:${videoCodec || 'unknown'}`;
      }
      const videoPayloadFormat = normalizePayloadFormat(mediaManifest.video && mediaManifest.video.payloadFormat, 'annexb');
      const supportedVideoPayloadFormats = normalizePayloadFormatList(encoded && encoded.supportedVideoPayloadFormats);
      if (supportedVideoPayloadFormats.length > 0 && !supportedVideoPayloadFormats.includes(videoPayloadFormat)) {
        return `web-video-payload-format-unsupported:${videoPayloadFormat || 'unknown'}`;
      }
      if (videoPayloadFormat !== 'annexb' && videoPayloadFormat !== 'avcc') {
        return `web-video-payload-format-unsupported:${videoPayloadFormat || 'unknown'}`;
      }
      const audioCodec = normalizeMediaCodecName((mediaManifest.audio && mediaManifest.audio.codec) || 'opus');
      const supportedAudioCodecs = normalizeCodecList(encoded && encoded.supportedAudioCodecs);
      if (supportedAudioCodecs.length === 0) {
        return 'web-audio-codec-capability-missing';
      }
      if (supportedAudioCodecs.length > 0 && (!audioCodec || !supportedAudioCodecs.includes(audioCodec))) {
        return `web-audio-codec-unsupported:${audioCodec || 'unknown'}`;
      }
      const audioPayloadFormat = normalizePayloadFormat(
        mediaManifest.audio && mediaManifest.audio.payloadFormat,
        audioCodec === 'aac' ? 'aac-adts' : 'opus-raw'
      );
      const supportedAudioPayloadFormats = normalizePayloadFormatList(encoded && encoded.supportedAudioPayloadFormats);
      if (supportedAudioPayloadFormats.length > 0 && !supportedAudioPayloadFormats.includes(audioPayloadFormat)) {
        return `web-audio-payload-format-unsupported:${audioPayloadFormat || 'unknown'}`;
      }
      if (audioCodec === 'opus' && audioPayloadFormat !== 'opus-raw' && audioPayloadFormat !== 'raw') {
        return `web-audio-payload-format-unsupported:${audioPayloadFormat || 'unknown'}`;
      }
      if (audioCodec === 'aac' && audioPayloadFormat !== 'aac-adts' && audioPayloadFormat !== 'raw') {
        return `web-audio-payload-format-unsupported:${audioPayloadFormat || 'unknown'}`;
      }
      return '';
    }

    function isReusableLocalOfferHandle(handle, force = false) {
      return Boolean(
        handle &&
        !force &&
        handle.localDescription &&
        handle.localDescription.type === 'offer' &&
        ['new', 'connecting', 'connected'].includes(handle.connectionState)
      );
    }

    async function createOfferForPeer(peerId, offerOptions = {}) {
      const existingHandle = getPeerHandle(peerId);
      if (existingHandle && !offerOptions.force && existingHandle.__offerPromise) {
        await existingHandle.__offerPromise;
        return existingHandle;
      }
      if (isReusableLocalOfferHandle(existingHandle, Boolean(offerOptions.force))) {
        return existingHandle;
      }
      if (existingHandle) {
        await closePeerConnection(peerId, {});
      }

      const handle = createPeerConnection(peerId, true, offerOptions.kind || 'host-viewer', {
        encodedMediaDataChannel: offerOptions.encodedMediaDataChannel !== false,
        mediaManifest: offerOptions.mediaManifest || getCurrentMediaManifestSnapshot()
      });
      if (offerOptions.relaySourcePeerId) {
        handle.relaySourcePeerId = offerOptions.relaySourcePeerId;
      }
      handle.__offerPromise = createAndSendPeerOffer(peerId, handle, offerOptions)
        .finally(() => {
          handle.__offerPromise = null;
        });
      await handle.__offerPromise;
      return handle;
    }

    function getDataChannelEncodedMediaUnsupportedReason(mediaCapabilities, mediaManifest) {
      const encoded = mediaCapabilities && mediaCapabilities.encodedMediaDataChannel;
      if (!encoded || encoded.protocol !== 'vds-media-encoded-v1' || Number(encoded.protocolVersion || 0) !== 1) {
        return 'datachannel-protocol-unsupported';
      }
      return getManifestCodecCompatibilityFailure(mediaCapabilities, mediaManifest || getCurrentMediaManifestSnapshot());
    }

    function createNonRetryableRelayError(message) {
      const error = new Error(message);
      error.nonRetryableRelay = true;
      return error;
    }

    async function createHostViewerOffer(viewerId, offerOptions = {}) {
      if (offerOptions.viewerMediaCapabilities) {
        const unsupportedReason = getDataChannelEncodedMediaUnsupportedReason(
          offerOptions.viewerMediaCapabilities,
          offerOptions.mediaManifest || getCurrentMediaManifestSnapshot()
        );
        if (unsupportedReason) {
          throw createNonRetryableRelayError(unsupportedReason);
        }
      }
      return createOfferForPeer(viewerId, {
        ...offerOptions,
        kind: 'host-viewer',
        encodedMediaDataChannel: true,
        mediaManifest: offerOptions.mediaManifest || getCurrentMediaManifestSnapshot()
      });
    }

    async function createRelayViewerOffer(nextViewerId, nextViewerMediaCapabilities) {
      if (!nextViewerId) {
        throw new Error('native-relay-next-viewer-missing');
      }
      if (nextViewerMediaCapabilities) {
        const unsupportedReason = getDataChannelEncodedMediaUnsupportedReason(
          nextViewerMediaCapabilities,
          getCurrentMediaManifestSnapshot()
        );
        if (unsupportedReason) {
          throw createNonRetryableRelayError(unsupportedReason);
        }
      }
      const isCurrentHost = typeof options.isHost === 'function' ? Boolean(options.isHost()) : Boolean(options.isHost);
      const sessionRole = typeof options.getSessionRole === 'function' ? options.getSessionRole() : '';
      if (isCurrentHost || sessionRole !== 'viewer') {
        throw new Error('native-relay-role-invalid');
      }
      const relaySourcePeerId = typeof options.getUpstreamPeerId === 'function' ? options.getUpstreamPeerId() : '';
      if (!relaySourcePeerId) {
        throw new Error('native-relay-upstream-peer-missing');
      }
      const handle = await createOfferForPeer(nextViewerId, {
        kind: 'relay-viewer',
        encodedMediaDataChannel: true,
        mediaManifest: getCurrentMediaManifestSnapshot(),
        relaySourcePeerId,
        isRelay: true
      });
      clearPeerReconnect(nextViewerId);
      return handle;
    }

    async function prepareAnswerSignal(peerId, handle, timeoutMs = 15000) {
      if (!isNativePeerHandle(handle)) {
        throw new Error('renderer-peer-path-disabled-for-native-authority');
      }
      await ensurePeerReady(peerId, handle);
      const signal = await waitForSignal(peerId, 'answer', timeoutMs);
      updateSignalState(peerId, signal);
      return signal;
    }

    async function prepareAnswerMessage(peerId, handle, messageOptions = {}) {
      const signal = await prepareAnswerSignal(peerId, handle, messageOptions.timeoutMs || 15000);
      const message = buildAnswerMessage(peerId, signal, messageOptions);
      return { peerId, signal, message, sdp: signal && signal.sdp };
    }

    async function createAndSendAnswer(peerId, handle, messageOptions = {}) {
      const prepared = await prepareAnswerMessage(peerId, handle, messageOptions);
      sendSignalMessage(prepared.message);
      return prepared.sdp;
    }

    async function flushQueuedAndCreateAnswer(peerId, handle, messageOptions = {}) {
      const flushResult = await flushQueuedRemoteCandidates(peerId, handle);
      const sdp = await createAndSendAnswer(peerId, handle, messageOptions);
      return { peerId, handle, flushResult, sdp };
    }

    return {
      createDefaultPeerMeta,
      ensurePeerMeta,
      applyRemoteOfferAttempt,
      clearPeerConnectTimeout,
      armPeerConnectTimeout,
      armPeerConnectFailfast,
      armPeerNatMappingWait,
      clearPeerDisconnectTimer,
      getPeerReconnectState,
      schedulePeerReconnect,
      clearPeerReconnect,
      clearAllPeerReconnects,
      getCurrentPeerAttemptId,
      getCurrentPeerEdgeAttemptId,
      isCurrentPeerAttempt,
      appendPeerAttempt,
      getPeerEdgeState,
      finalizeP2pFailureWithNatMapping,
      prepareConnectFailfastTimeout,
      prepareNatMappingWaitTimeout,
      preparePeerRecoveryRequest,
      requestPeerRecovery,
      prepareRemoteIceCandidate,
      prepareRemoteAnswer,
      prepareRemoteOffer,
      prepareViewerUpstreamSwitch,
      buildOfferMessage,
      buildAnswerMessage,
      prepareLocalIceCandidateSignal,
      handleLocalSignalEvent,
      handleLocalSignalEventAndSend,
      sendSignalMessage,
      applyPeerStateEvent,
      applyPeerStateEffects,
      handlePeerStateEvent,
      applyRemoteIceCandidateEffects,
      applyQueuedRemoteCandidateFlushResult,
      getPeerHandle,
      createPeerConnection,
      recreatePeerForRemoteOffer,
      isNativePeerHandle,
      ensurePeerReady,
      attachPeerMediaSources,
      setRemoteDescription,
      applyRemoteDescription,
      handleRemoteAnswer,
      finalizeRemoteAnswer,
      handleRemoteOffer,
      applyRecreatedRemoteOffer,
      attachViewerRemoteOfferSurface,
      addRemoteIceCandidate,
      applyRemoteIceCandidate,
      handleRemoteIceCandidate,
      finalizeRemoteIceCandidate,
      buildRemoteIceCandidateEffects,
      flushQueuedRemoteCandidates,
      closePeerConnection,
      closeAllPeers,
      deletePeerHandle,
      getPeerHandleCount,
      getPeerHandleEntries,
      getPeerHandleIds,
      getStalePeerIds,
      scheduleStalePeerCleanup,
      getSignalPeerId,
      pruneSignalBacklog,
      enqueueSignal,
      waitForSignal,
      dropQueuedSignals,
      updateSignalState,
      waitForMediaOffer,
      isMediaOfferSignal,
      getSignalAttemptId,
      normalizeSessionDescription,
      isSameSessionDescription,
      buildRemoteCandidateKey,
      getIceCandidateText,
      isAllowedPureP2pCandidate,
      isStaleNativePeerError,
      hasRemoteCandidate,
      rememberRemoteCandidate,
      queuePendingRemoteCandidate,
      takePendingRemoteCandidates,
      clearPendingRemoteCandidates,
      clearAllPendingRemoteCandidates,
      rememberLocalIceCandidate,
      getLocalHostUdpCandidates,
      getCandidateTypeCounts,
      buildPeerDiagnosticEntries,
      prepareOfferSignal,
      prepareOfferMessage,
      createAndSendOffer,
      createAndSendPeerOffer,
      createOfferForPeer,
      createHostViewerOffer,
      createRelayViewerOffer,
      prepareAnswerSignal,
      prepareAnswerMessage,
      createAndSendAnswer,
      flushQueuedAndCreateAnswer,
      sanitizeSignalPayload
    };
  }

  VDS.nativePeer = { createController, createDefaultPeerMeta, createPeerHandleRegistry, createSignalRegistry };
})();
