import './styles.css';
import { detectCapabilities, detectCapabilitiesAsync, type CapabilityReport } from './capabilities';
import {
  DATA_CHANNEL_HELLO_ACK_TIMEOUT_MS,
  DATA_CHANNEL_OPEN_TIMEOUT_MS,
  ENCODED_MEDIA_CHANNEL_LABEL,
  ENCODED_MEDIA_PROTOCOL,
  ENCODED_MEDIA_PROTOCOL_VERSION,
  encodeFrameMessages,
  helloAckMessage,
  helloMessage,
  parseControlMessage,
  webEncodedMediaCapabilities
} from './datachannel-protocol';
import { DiagnosticsStore } from './diagnostics';
import { fetchPublicRooms, fetchServerConfig, VdsWebSignaling, type SignalMessage } from './signaling';
import { EncodedMediaPlaybackSession } from './playback-session';
import { UpstreamRecovery } from './upstream-recovery';

type SessionState = {
  roomId: string;
  clientId: string;
  sessionToken?: string;
  hostId?: string;
  upstreamPeerId?: string;
  chainPosition: number;
};

const clientId = getClientId();
let capability = detectCapabilities();
let capabilityDetectionComplete = false;
const diagnostics = new DiagnosticsStore(capability, clientId);
const signaling = new VdsWebSignaling();
const upstreamRecovery = new UpstreamRecovery();
let upstreamRecoveryAttempts = 0;

let serverConfig: { iceServers: RTCIceServer[]; version?: string } = { iceServers: [] };
let session: SessionState | null = readStoredSession(clientId);
let restoringStoredSession = Boolean(session);
let joinPending = false;
let pendingJoinRoomId = '';
let joinAttemptSeq = 0;
let joinAckTimer: number | null = null;
let upstreamPc: RTCPeerConnection | null = null;
let downstreamPc: RTCPeerConnection | null = null;
let downstreamDataChannel: RTCDataChannel | null = null;
let upstreamMediaChannel: RTCDataChannel | null = null;
let downstreamDataChannelReady = false;
let downstreamRelayForwarding = false;
let downstreamCloseExpected = false;
let relayHelloAckTimer: number | null = null;
let webEdgeAttemptSeq = 0;
let upstreamEdgeAttemptId: number | null = null;
let downstreamEdgeAttemptId: number | null = null;
let downstreamPeerId = '';
let relaySourceEpoch = '';
let viewerReadySent = false;
type PendingIceCandidate = {
  candidate: RTCIceCandidateInit;
  attemptId: number | null;
  iceUfrag: string;
  pc: RTCPeerConnection | null;
};
const pendingIceCandidates = new Map<string, PendingIceCandidate[]>();
const DATA_CHANNEL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DATA_CHANNEL_BUFFERED_LOW_BYTES = 2 * 1024 * 1024;
let lastVideoKeyframeForRelay: {
  codec: string;
  sourceEpoch?: string;
  timestampUs: number;
  sequence: number;
  payload: ArrayBuffer;
  payloadFormat: 'annexb' | 'avcc' | 'raw' | 'opus-raw' | 'aac-adts' | 'unknown';
} | null = null;
let lastBootstrapFrameId = '';
let lastConsoleDiagnosticsAt = 0;
let lastVideoDropLogAt = -Infinity;
let lastAudioDropLogAt = -Infinity;
let copyDiagnosticsInFlight = false;
let refreshRoomsSeq = 0;
let refreshRoomsInFlight = false;
let fullscreenTransitionPromise: Promise<void> | null = null;
let mobileSuspendTimer: number | null = null;

const statusBadge = getElement<HTMLSpanElement>('statusBadge');
const capabilitySummary = getElement<HTMLParagraphElement>('capabilitySummary');
const statusText = getElement<HTMLParagraphElement>('statusText');
const errorText = getElement<HTMLParagraphElement>('errorText');
const roomIdInput = getElement<HTMLInputElement>('roomIdInput');
const joinButton = getElement<HTMLButtonElement>('joinButton');
const refreshRoomsButton = getElement<HTMLButtonElement>('refreshRoomsButton');
const joinCard = getElement<HTMLElement>('joinCard');
const lobbyTabButton = getElement<HTMLButtonElement>('lobbyTabButton');
const directTabButton = getElement<HTMLButtonElement>('directTabButton');
const lobbyJoinPanel = getElement<HTMLDivElement>('lobbyJoinPanel');
const directJoinPanel = getElement<HTMLDivElement>('directJoinPanel');
const roomListStatus = getElement<HTMLParagraphElement>('roomListStatus');
const roomList = getElement<HTMLDivElement>('roomList');
const playerShell = getElement<HTMLDivElement>('playerShell');
const muteButton = getElement<HTMLButtonElement>('muteButton');
const playerVolumeInput = getElement<HTMLInputElement>('playerVolumeInput');
const playerVolumeValue = getElement<HTMLElement>('playerVolumeValue');
const fullscreenButton = getElement<HTMLButtonElement>('fullscreenButton');
const viewerRoomId = getElement<HTMLElement>('viewerRoomId');
const chainPositionText = getElement<HTMLElement>('chainPositionText');
const decodedVideoText = getElement<HTMLElement>('decodedVideoText');
const decodedAudioText = getElement<HTMLElement>('decodedAudioText');
const waitingMessage = getElement<HTMLParagraphElement>('waitingMessage');
const diagnosticsOutput = getElement<HTMLTextAreaElement>('diagnosticsOutput');
const copyDiagnosticsButton = getElement<HTMLButtonElement>('copyDiagnosticsButton');
const downloadDiagnosticsButton = getElement<HTMLButtonElement>('downloadDiagnosticsButton');
const leaveButton = getElement<HTMLButtonElement>('leaveButton');
const audioDelayInput = getElement<HTMLInputElement>('audioDelayInput');
const audioDelayDecrease = getElement<HTMLButtonElement>('audioDelayDecrease');
const audioDelayIncrease = getElement<HTMLButtonElement>('audioDelayIncrease');
const dataChannelCanvas = getElement<HTMLCanvasElement>('dataChannelCanvas');
const playback = new EncodedMediaPlaybackSession(dataChannelCanvas, {
  onMetrics: (metrics) => diagnostics.update({ webPlaybackMetrics: metrics }),
  onKeyframeNeeded: () => requestUpstreamKeyframe(),
  onSourceChanged: () => handlePlaybackSourceChanged(),
  onState: (state) => {
    diagnostics.update({
      playbackState: state,
      ...(state === 'stopped' || state === 'waiting-media' ? {
        videoDecoderState: undefined,
        audioDecoderState: undefined,
        playbackFailureReason: undefined
      } : {})
    });
    if (state === 'waiting-media') waitingMessage.classList.remove('hidden');
  },
  video: {
    onState: (state) => {
      logVdsWebInfo(`[vds-web][webcodecs-state] ${state}`);
      diagnostics.update({ videoDecoderState: state });
    },
    onDecodedFrame: () => {
      upstreamRecoveryAttempts = 0;
      diagnostics.incrementCounter('webDecodedVideoFrames');
      waitingMessage.classList.add('hidden');
    },
    onDroppedFrame: (reason) => {
      const now = performance.now();
      if (now - lastVideoDropLogAt >= 250) {
        lastVideoDropLogAt = now;
        logVdsWebInfo(`[vds-web][webcodecs-video-drop] ${toConsoleJson({ reason })}`);
      }
      diagnostics.incrementCounter('webDroppedVideoFrames');
      diagnostics.update({ playbackFailureReason: reason });
    },
    onPayloadFormat: (format) => diagnostics.update({ h264PayloadFormat: format }),
    onVideoFrameInfo: (info) => {
      const snapshot = diagnostics.getSnapshot();
      logVdsWebInfo(`[vds-web][video-frame] ${toConsoleJson({
        ...info,
        mediaManifestVideo: (snapshot.mediaManifest as { video?: unknown } | undefined)?.video,
        decodedFrames: snapshot.webDecodedVideoFrames,
        droppedFrames: snapshot.webDroppedVideoFrames,
        encodedFramesReceived: snapshot.encodedFramesReceived,
        relayProtocolState: snapshot.relayProtocolState
      })}`);
    }
  },
  audio: {
    onState: (state) => {
      logVdsWebInfo(`[vds-web][webcodecs-audio-state] ${state}`);
      diagnostics.update({ audioDecoderState: state });
    },
    onDecodedBlock: () => diagnostics.incrementCounter('webDecodedAudioBlocks'),
    onDroppedBlock: (reason) => {
      const now = performance.now();
      if (now - lastAudioDropLogAt >= 250) {
        lastAudioDropLogAt = now;
        logVdsWebInfo(`[vds-web][webcodecs-audio-drop] ${reason}`);
      }
      diagnostics.incrementCounter('webDroppedAudioBlocks');
      diagnostics.update({ playbackFailureReason: reason });
    }
  }
});

diagnostics.subscribe(renderDiagnostics);
signaling.onMessage((message) => {
  void handleSignal(message).catch((error) => setError(errorToMessage(error)));
});
signaling.onStatus((status) => {
  if (status === 'closed') {
    if (session) {
      resetLocalViewerSession();
    }
    setStatus('连接已断开');
  } else if (status === 'error') {
    setError('WebSocket 连接失败。');
  }
});

joinButton.addEventListener('click', () => void joinRoom(roomIdInput.value.trim()));
refreshRoomsButton.addEventListener('click', () => void refreshRooms(true));
copyDiagnosticsButton.addEventListener('click', () => void copyDiagnosticsReport());
downloadDiagnosticsButton.addEventListener('click', () => downloadDiagnosticsReport());
lobbyTabButton.addEventListener('click', () => setJoinMode('lobby'));
directTabButton.addEventListener('click', () => setJoinMode('direct'));
leaveButton.addEventListener('click', () => {
  leaveCurrentRoom();
  setStatus('等待加入');
});
fullscreenButton.addEventListener('click', () => void toggleFullscreen());
muteButton.addEventListener('click', toggleMute);
playerVolumeInput.addEventListener('input', () => setPlayerVolume(Number(playerVolumeInput.value)));
document.addEventListener('fullscreenchange', syncFullscreenButton);
document.addEventListener('visibilitychange', handleVisibilityChange);
document.addEventListener('pointerdown', unlockAudioFromUserGesture, { passive: true });
document.addEventListener('touchend', unlockAudioFromUserGesture, { passive: true });
document.addEventListener('keydown', unlockAudioFromUserGesture);
window.addEventListener('pagehide', () => handleMobilePageSuspended('pagehide', true));
audioDelayInput.addEventListener('change', () => setAudioDelay(Number(audioDelayInput.value)));
audioDelayDecrease.addEventListener('click', () => setAudioDelay(Number(audioDelayInput.value) - 10));
audioDelayIncrease.addEventListener('click', () => setAudioDelay(Number(audioDelayInput.value) + 10));
setJoinPending(false);
void bootstrap();

async function bootstrap(): Promise<void> {
  renderCapability(capability);
  renderDiagnostics();

  try {
    capability = await detectCapabilitiesAsync();
    capabilityDetectionComplete = true;
    renderCapability(capability);
  } catch (error) {
    capability = { ...capability, ok: false, reasons: [...capability.reasons, errorToMessage(error)] };
    capabilityDetectionComplete = true;
    renderCapability(capability);
  }

  if (!capability.ok) {
    if (session) {
      resetLocalViewerSession();
    } else {
      clearStoredSession();
    }
    joinButton.disabled = true;
    setError(capability.reasons.join(' '));
    return;
  }
  syncFullscreenAvailability();
  setJoinPending(false);

  try {
    serverConfig = await fetchServerConfig();
    await refreshRooms(false);
    if (session?.roomId && session.sessionToken) {
      const restoreRoomId = session.roomId;
      roomIdInput.value = restoreRoomId;
      setStatus('恢复连接中');
      await joinRoom(restoreRoomId);
      return;
    }
    setStatus('等待加入');
  } catch (error) {
    restoringStoredSession = false;
    setError(errorToMessage(error));
  }
}

async function joinRoom(roomId: string): Promise<void> {
  roomId = roomId.trim().toUpperCase();
  if (!capabilityDetectionComplete) {
    setError('浏览器能力检测尚未完成。');
    return;
  }
  if (!capability.ok) {
    setError(capability.reasons.join(' '));
    return;
  }
  if (joinPending) {
    return;
  }
  if (session && !restoringStoredSession) {
    setStatus('已在房间中');
    return;
  }
  if (!roomId) {
    setError('请输入房间码。');
    return;
  }

  setJoinPending(true);
  pendingJoinRoomId = roomId;
  const joinSeq = ++joinAttemptSeq;
  startJoinAckTimer(joinSeq);
  try {
    setStatus('连接信令中');
    await playback.resumeAudio();
    if (joinSeq !== joinAttemptSeq || !joinPending) {
      return;
    }
    await signaling.connect();
    if (joinSeq !== joinAttemptSeq || !joinPending) {
      return;
    }
    signaling.send({
      type: 'join-room',
      roomId,
      clientId,
      sessionToken: session?.roomId === roomId ? session.sessionToken : undefined,
      needsMediaReconnect: true,
      webViewer: true,
      encodedRelayRequired: true,
      mediaCapabilities: {
        webViewer: true,
        maxDirectDownstreams: capability.maxDirectDownstreams,
        mobile: capability.mobile,
        platform: capability.platform,
        browser: capability.browser,
        browserFamily: capability.browserFamily,
        androidChrome: capability.androidChrome,
        audioOutput: capability.audioOutput,
        relayCapable: capability.relayCapable,
        relayEligibilityReason: capability.relayEligibilityReason,
        encodedMediaDataChannel: getWebEncodedMediaCapabilities()
      }
    });
    setStatus('等待上游');
  } catch (error) {
    if (joinSeq !== joinAttemptSeq) {
      return;
    }
    clearJoinAckTimer();
    setJoinPending(false);
    restoringStoredSession = false;
    setError(errorToMessage(error));
  }
}

async function handleSignal(message: SignalMessage): Promise<void> {
  if (!isSignalForCurrentSession(message)) {
    diagnostics.update({ relayFailureReason: 'stale-room-signal-ignored' });
    return;
  }
  switch (message.type) {
    case 'room-joined':
    case 'session-resumed':
      handleJoined(message);
      break;
    case 'offer':
      await handleOffer(message);
      break;
    case 'answer':
      await handleAnswer(message);
      break;
    case 'ice-candidate':
    case 'candidate':
      await handleIceCandidate(message);
      break;
    case 'connect-to-next':
      await handleConnectToNext(message);
      break;
    case 'chain-reconnect':
      await handleChainReconnect(message);
      break;
    case 'viewer-left':
      handleViewerLeft(message);
      setStatus('下游观看端已离开');
      break;
    case 'host-disconnected':
      resetLocalViewerSession();
      setError('主持端已断开。');
      break;
    case 'error':
      if (message.code === 'session-token-invalid') {
        clearStoredSession();
        session = null;
      }
      setJoinPending(false);
      restoringStoredSession = false;
      setError(`${String(message.code || 'error')}: ${String(message.message || '')}`);
      break;
  }
}

function isSignalForCurrentSession(message: SignalMessage): boolean {
  if (!session) {
    if (message.type === 'room-joined' || message.type === 'session-resumed' || message.type === 'error') {
      return true;
    }
    const signalRoomId = typeof message.roomId === 'string' ? message.roomId.trim() : '';
    return !signalRoomId;
  }
  const signalRoomId = typeof message.roomId === 'string' ? message.roomId.trim().toUpperCase() : '';
  if (!signalRoomId) {
    return true;
  }
  return signalRoomId === session.roomId.trim().toUpperCase();
}

function handleJoined(message: SignalMessage): void {
  if (!joinPending && !restoringStoredSession) {
    diagnostics.update({ relayFailureReason: 'stale-join-ack-ignored' });
    return;
  }
  const ackRoomId = typeof message.roomId === 'string' ? message.roomId.trim().toUpperCase() : '';
  if (pendingJoinRoomId && ackRoomId && ackRoomId !== pendingJoinRoomId) {
    diagnostics.update({ relayFailureReason: 'stale-join-room-ack-ignored' });
    return;
  }
  clearJoinAckTimer();
  const manifestFailure = getManifestCompatibilityFailure(message.mediaManifest);
  if (manifestFailure) {
    setJoinPending(false);
    setError(manifestFailure);
    return;
  }
  session = {
    roomId: String(message.roomId || roomIdInput.value.trim()),
    clientId,
    sessionToken: typeof message.sessionToken === 'string' ? message.sessionToken : undefined,
    hostId: typeof message.hostId === 'string' ? message.hostId : undefined,
    upstreamPeerId: typeof message.upstreamPeerId === 'string' ? message.upstreamPeerId : undefined,
    chainPosition: Number(message.chainPosition || 0)
  };
  sessionStorage.setItem('vds-web-session', JSON.stringify(session));
  setJoinPending(false);
  restoringStoredSession = false;
  viewerReadySent = false;
  upstreamRecoveryAttempts = 0;
  const joinedSession = session;
  upstreamRecovery.start((reason) => {
    if (session === joinedSession) requestUpstreamRecovery(null, joinedSession.upstreamPeerId || joinedSession.hostId || '', reason);
  });
  joinCard.classList.add('hidden');
  leaveButton.classList.remove('hidden');
  viewerRoomId.textContent = session.roomId || '-';
  chainPositionText.textContent = formatChainPosition(session.chainPosition);
  diagnostics.update({
    status: '等待上游',
    roomId: session.roomId,
    sessionToken: session.sessionToken,
    hostId: session.hostId,
    upstreamPeerId: session.upstreamPeerId,
    chainPosition: session.chainPosition,
    mediaManifest: message.mediaManifest,
    serverMediaCapabilities: message.mediaCapabilities
  });
  setStatus('等待上游');
}

async function handleOffer(message: SignalMessage): Promise<void> {
  if (!session) {
    setError('收到 offer，但尚未加入房间。');
    return;
  }

  const sourceId = String(message.fromClientId || message.sourceId || message.targetId || session.upstreamPeerId || session.hostId || 'host');
  const sdp = normalizeDescription(message);
  if (!sdp) {
    setError('收到无效 offer。');
    return;
  }
  if (!isEncodedDataChannelOffer(sdp.sdp || '')) {
    markRelayUnsupported('web-media-track-offer-disabled');
    return;
  }
  const manifestFailure = getManifestCompatibilityFailure(message.mediaManifest);
  if (manifestFailure) {
    markRelayUnsupported(manifestFailure);
    return;
  }
  const remoteAttemptId = getSignalAttemptId(message);
  if (remoteAttemptId && upstreamEdgeAttemptId && remoteAttemptId < upstreamEdgeAttemptId) {
    diagnostics.update({ relayFailureReason: 'stale-upstream-offer-ignored' });
    return;
  }
  if (remoteAttemptId) {
    upstreamEdgeAttemptId = remoteAttemptId;
  }
  diagnostics.update({ mediaManifest: message.mediaManifest });

  const pc = ensureUpstreamPeer(sourceId);
  const currentSession = session;
  const attemptId = upstreamEdgeAttemptId;
  const isCurrent = () => session === currentSession && upstreamPc === pc && upstreamEdgeAttemptId === attemptId;
  await pc.setRemoteDescription(sdp);
  if (!isCurrent()) return;
  const answer = await pc.createAnswer();
  if (!isCurrent()) return;
  await pc.setLocalDescription(answer);
  if (!isCurrent()) return;
  await flushPendingIceCandidates(sourceId, pc);
  if (!isCurrent()) return;
  signaling.send({
    type: 'answer',
    roomId: session.roomId,
    targetId: sourceId,
    sdp: pc.localDescription || answer,
    attemptId: upstreamEdgeAttemptId || undefined
  });
  clearError();
  diagnostics.update({
    relayFailureReason: undefined,
    lastError: undefined
  });
  setStatus('观看中');
}

async function handleAnswer(message: SignalMessage): Promise<void> {
  const sdp = normalizeDescription(message);
  if (!downstreamPc || !sdp) {
    return;
  }
  const remoteAttemptId = getSignalAttemptId(message);
  if (downstreamEdgeAttemptId && remoteAttemptId && remoteAttemptId !== downstreamEdgeAttemptId) {
    diagnostics.update({ relayFailureReason: 'stale-downstream-answer-ignored' });
    return;
  }
  const pc = downstreamPc;
  const peerId = downstreamPeerId;
  await pc.setRemoteDescription(sdp);
  if (pc !== downstreamPc || peerId !== downstreamPeerId) return;
  await flushPendingIceCandidates(peerId, pc);
}

async function handleIceCandidate(message: SignalMessage): Promise<void> {
  const candidate = message.candidate;
  if (!candidate) {
    return;
  }

  const peerId = String(message.fromClientId || message.sourceId || message.targetId || '');
  const isDownstream = Boolean(peerId && peerId === downstreamPeerId);
  if (!isDownstream && !isCurrentUpstreamPeer(peerId)) {
    return;
  }
  const pc = isDownstream ? downstreamPc : upstreamPc;
  const remoteAttemptId = getSignalAttemptId(message);
  const expectedAttemptId = peerId && peerId === downstreamPeerId ? downstreamEdgeAttemptId : upstreamEdgeAttemptId;
  if (expectedAttemptId && remoteAttemptId && remoteAttemptId !== expectedAttemptId) {
    diagnostics.update({ relayFailureReason: 'stale-ice-candidate-ignored' });
    return;
  }

  diagnostics.incrementCandidate(peerId || 'unknown', 'remote');
  if (!pc || !pc.remoteDescription) {
    queuePendingIceCandidate(peerId, candidate, remoteAttemptId, pc);
    return;
  }
  if (!isCandidateForRemoteDescription(candidate, pc.remoteDescription)) {
    diagnostics.update({ relayFailureReason: 'stale-ice-ufrag-ignored' });
    return;
  }
  await pc.addIceCandidate(candidate).catch((error) => {
    if (isCurrentIceCandidatePeer(peerId, pc)) {
      diagnostics.update({ relayFailureReason: `ice-candidate-failed:${errorToMessage(error)}` });
    }
  });
}

async function handleConnectToNext(message: SignalMessage): Promise<void> {
  if (!session) {
    return;
  }
  if (!capability.relayCapable) {
    diagnostics.update({
      relayProtocolState: 'relay-disabled-for-mobile-browser',
      relayFailureReason: 'web-mobile-relay-disabled',
      reencodePathUsed: false
    });
    return;
  }
  const manifestFailure = getManifestCompatibilityFailure(message.mediaManifest);
  if (manifestFailure) {
    markRelayUnsupported(manifestFailure);
    return;
  }

  downstreamPeerId = String(message.nextViewerId || message.targetId || '');
  if (!downstreamPeerId) {
    setError('收到无效下游连接请求。');
    return;
  }

  diagnostics.update({ downstreamPeerId, status: 'relay 检测中', mediaManifest: message.mediaManifest });
  setStatus('relay 检测中');

  downstreamPc?.close();
  downstreamDataChannel?.close();
  downstreamDataChannelReady = false;
  downstreamRelayForwarding = false;
  lastBootstrapFrameId = '';
  downstreamCloseExpected = false;
  clearRelayHelloAckTimer();
  downstreamEdgeAttemptId = ++webEdgeAttemptSeq;
  downstreamPc = new RTCPeerConnection({ iceServers: serverConfig.iceServers });
  const pc = downstreamPc;
  const peerId = downstreamPeerId;
  const currentSession = session;
  wirePeerEvents(pc, peerId);
  downstreamDataChannel = pc.createDataChannel(ENCODED_MEDIA_CHANNEL_LABEL, {
    ordered: false
  });
  attachOutboundDataChannel(downstreamDataChannel, downstreamPeerId);

  const offer = await pc.createOffer();
  if (pc !== downstreamPc || session !== currentSession) return;
  await pc.setLocalDescription(offer);
  if (pc !== downstreamPc || session !== currentSession) return;
  signaling.send({
    type: 'offer',
    roomId: session.roomId,
    targetId: downstreamPeerId,
    sdp: downstreamPc.localDescription || offer,
    attemptId: downstreamEdgeAttemptId || undefined,
    mediaCapabilities: {
      encodedMediaDataChannel: getWebEncodedMediaCapabilities()
    }
  });
}

async function handleChainReconnect(message: SignalMessage): Promise<void> {
  if (!session) {
    return;
  }

  const manifestFailure = getManifestCompatibilityFailure(message.mediaManifest);
  if (manifestFailure) {
    markRelayUnsupported(manifestFailure);
    return;
  }

  const nextChainPosition = Number(message.newChainPosition ?? message.chainPosition ?? session.chainPosition);
  const nextUpstreamPeerId = String(message.upstreamPeerId || '');
  if (!Number.isInteger(nextChainPosition) || nextChainPosition < 0 || !nextUpstreamPeerId) {
    markRelayUnsupported('chain-reconnect-invalid');
    return;
  }

  const previousUpstreamPeerId = session.upstreamPeerId || '';
  upstreamRecovery.stop();
  playback.resetMedia();
  upstreamPc?.close();
  upstreamPc = null;
  if (previousUpstreamPeerId) {
    pendingIceCandidates.delete(previousUpstreamPeerId);
    removePeerDiagnostics(previousUpstreamPeerId);
  }
  pendingIceCandidates.delete(nextUpstreamPeerId);
  viewerReadySent = false;
  lastBootstrapFrameId = '';
  lastVideoKeyframeForRelay = null;
  upstreamEdgeAttemptId = null;
  clearError();

  session = {
    ...session,
    upstreamPeerId: nextUpstreamPeerId,
    chainPosition: nextChainPosition
  };
  sessionStorage.setItem('vds-web-session', JSON.stringify(session));
  chainPositionText.textContent = formatChainPosition(nextChainPosition);
  diagnostics.update({
    status: '等待上游重连',
    upstreamPeerId: nextUpstreamPeerId,
    chainPosition: nextChainPosition,
    mediaManifest: message.mediaManifest,
    relayFailureReason: undefined,
    lastError: undefined
  });
  setStatus('等待上游重连');

  signaling.send({
    type: 'viewer-reconnect-ready',
    roomId: session.roomId,
    clientId,
    sessionToken: session.sessionToken,
    chainPosition: nextChainPosition
  });
}

function ensureUpstreamPeer(peerId: string): RTCPeerConnection {
  if (upstreamPc) {
    return upstreamPc;
  }

  upstreamMediaChannel = null;
  if (downstreamDataChannel) rotateRelaySourceEpoch();
  upstreamPc = new RTCPeerConnection({ iceServers: serverConfig.iceServers });
  playback.start();
  const pc = upstreamPc;
  upstreamRecovery.start((reason) => requestUpstreamRecovery(pc, peerId, reason));
  wirePeerEvents(pc, peerId);
  pc.ondatachannel = (event) => {
    if (pc === upstreamPc) attachInboundDataChannel(event.channel, peerId);
  };
  upstreamPc.ontrack = () => {
    if (pc !== upstreamPc) return;
    markRelayUnsupported('web-media-track-received-disabled');
  };

  return upstreamPc;
}

function wirePeerEvents(pc: RTCPeerConnection, peerId: string): void {
  pc.onicecandidate = (event) => {
    if (!session || !event.candidate || (pc !== upstreamPc && pc !== downstreamPc)) {
      return;
    }
    diagnostics.incrementCandidate(peerId, 'local');
    signaling.send({
      type: 'ice-candidate',
      roomId: session.roomId,
      targetId: peerId,
      candidate: event.candidate.toJSON(),
      attemptId: peerId === downstreamPeerId ? downstreamEdgeAttemptId || undefined : upstreamEdgeAttemptId || undefined
    });
  };
  pc.oniceconnectionstatechange = () => {
    if (pc !== upstreamPc && pc !== downstreamPc) return;
    diagnostics.updateIce(peerId, pc.iceConnectionState);
    if (pc === upstreamPc) upstreamRecovery.stateChanged(pc.iceConnectionState);
  };
  pc.onconnectionstatechange = () => {
    if (pc !== upstreamPc && pc !== downstreamPc) return;
    diagnostics.updateIce(`${peerId}:connection`, pc.connectionState);
    if (pc === upstreamPc) upstreamRecovery.stateChanged(pc.connectionState);
  };
}

function requestUpstreamRecovery(pc: RTCPeerConnection | null, peerId: string, reason: string): void {
  if (!session || pc !== upstreamPc || !isCurrentUpstreamPeer(peerId)) return;
  upstreamRecovery.stop();
  upstreamPc = null;
  pc?.close();
  upstreamEdgeAttemptId = null;
  pendingIceCandidates.delete(peerId);
  viewerReadySent = false;
  playback.resetMedia();
  lastVideoKeyframeForRelay = null;
  lastBootstrapFrameId = '';
  if (++upstreamRecoveryAttempts > 3) {
    setError('上游连接恢复失败，请重新加入房间。');
    return;
  }
  diagnostics.update({ relayProtocolState: 'upstream-reconnecting', relayFailureReason: reason });
  setStatus('上游连接中断，正在重连');
  try {
    signaling.send({
      type: 'viewer-reconnect-ready',
      roomId: session.roomId,
      clientId,
      sessionToken: session.sessionToken,
      chainPosition: session.chainPosition,
      failedUpstreamPeerId: peerId === session.hostId ? undefined : peerId
    });
  } catch (error) {
    setError(errorToMessage(error));
  }
}

function maybeSendViewerReady(): void {
  if (!session || viewerReadySent) {
    return;
  }
  viewerReadySent = true;
  signaling.send({
    type: 'viewer-ready',
    roomId: session.roomId,
    clientId,
    sessionToken: session.sessionToken,
    chainPosition: session.chainPosition
  });
}

function markRelayUnsupported(reason: string): void {
  downstreamRelayForwarding = false;
  diagnostics.update({
    status: 'relay 失败',
    relayProtocolState: 'failed',
    relayFailureReason: reason,
    reencodePathUsed: false
  });
  setError(`DataChannel encoded relay failfast: ${reason}`);
}

function attachOutboundDataChannel(channel: RTCDataChannel, peerId: string): void {
  rotateRelaySourceEpoch();
  downstreamCloseExpected = false;
  diagnostics.update({ relayProtocolState: 'datachannel-opening' });
  const openTimer = window.setTimeout(() => {
    if (!isCurrentDownstreamChannel(channel, peerId)) {
      return;
    }
    if (channel.readyState !== 'open') {
      markRelayUnsupported('datachannel-open-timeout');
      channel.close();
    }
  }, DATA_CHANNEL_OPEN_TIMEOUT_MS);

  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    if (!isCurrentDownstreamChannel(channel, peerId)) {
      window.clearTimeout(openTimer);
      return;
    }
    window.clearTimeout(openTimer);
    diagnostics.update({ relayProtocolState: 'datachannel-hello-sent' });
    channel.send(JSON.stringify(helloMessage('relay', getCurrentManifest(), getWebEncodedMediaCapabilities())));
    relayHelloAckTimer = window.setTimeout(() => {
      if (!isCurrentDownstreamChannel(channel, peerId)) {
        return;
      }
      markRelayUnsupported('datachannel-hello-ack-timeout');
      channel.close();
    }, DATA_CHANNEL_HELLO_ACK_TIMEOUT_MS);
  };
  channel.onmessage = (event) => {
    if (!isCurrentDownstreamChannel(channel, peerId)) {
      return;
    }
    if (typeof event.data === 'string') {
      const control = parseControlMessage(event.data);
      if (control?.type === 'hello-ack') {
        if (control.protocolVersion !== ENCODED_MEDIA_PROTOCOL_VERSION) {
          markRelayUnsupported('datachannel-version-mismatch');
          channel.close();
          return;
        }
        const sessionFailure = getControlManifestFailure(control);
        if (sessionFailure) {
          markRelayUnsupported(sessionFailure);
          channel.close();
          return;
        }
        clearRelayHelloAckTimer();
        downstreamDataChannelReady = true;
        markDownstreamRelayReady();
        sendRelayBootstrapKeyframe();
      } else if (control?.type === 'error') {
        markRelayUnsupported(control.reason || 'datachannel-remote-error');
      } else if (control?.type === 'keyframe-request') {
        lastBootstrapFrameId = '';
        sendRelayBootstrapKeyframe();
        requestUpstreamKeyframe();
      }
      return;
    }
    handleInboundEncodedFrame(event.data, peerId);
  };
  channel.onerror = () => {
    if (!isCurrentDownstreamChannel(channel, peerId)) {
      return;
    }
    window.clearTimeout(openTimer);
    if (downstreamCloseExpected || downstreamDataChannelReady || channel.readyState === 'closing' || channel.readyState === 'closed') {
      handleDownstreamChannelClosed();
      return;
    }
    markRelayUnsupported('datachannel-error');
  };
  channel.onclose = () => {
    if (!isCurrentDownstreamChannel(channel, peerId)) {
      return;
    }
    window.clearTimeout(openTimer);
    clearRelayHelloAckTimer();
    handleDownstreamChannelClosed();
  };
}

function attachInboundDataChannel(channel: RTCDataChannel, peerId: string): void {
  if (channel.label !== ENCODED_MEDIA_CHANNEL_LABEL) {
    return;
  }

  channel.binaryType = 'arraybuffer';
  upstreamMediaChannel = channel;
  const pc = upstreamPc;
  diagnostics.update({ relayProtocolState: 'datachannel-inbound-attached' });
  channel.onmessage = (event) => {
    if (pc !== upstreamPc || !isCurrentUpstreamPeer(peerId)) {
      return;
    }
    if (typeof event.data === 'string') {
      const control = parseControlMessage(event.data);
      if (control?.type === 'hello') {
        if (control.protocolVersion !== ENCODED_MEDIA_PROTOCOL_VERSION) {
          channel.send(JSON.stringify({
            protocol: ENCODED_MEDIA_PROTOCOL,
            type: 'error',
            protocolVersion: ENCODED_MEDIA_PROTOCOL_VERSION,
            reason: 'datachannel-version-mismatch'
          }));
          channel.close();
          return;
        }
        const sessionFailure = getControlManifestFailure(control);
        if (sessionFailure) {
          channel.send(JSON.stringify({
            protocol: ENCODED_MEDIA_PROTOCOL,
            type: 'error',
            protocolVersion: ENCODED_MEDIA_PROTOCOL_VERSION,
            reason: sessionFailure
          }));
          channel.close();
          return;
        }
        channel.send(JSON.stringify(helloAckMessage(getCurrentManifest())));
        upstreamRecovery.mediaReady();
        diagnostics.update({ relayProtocolState: 'datachannel-ready' });
        maybeSendViewerReady();
      }
      return;
    }

    handleInboundEncodedFrame(event.data, peerId);
  };
  channel.onerror = () => {
    if (pc !== upstreamPc || !isCurrentUpstreamPeer(peerId)) {
      return;
    }
    markRelayUnsupported('datachannel-error');
    upstreamRecovery.stateChanged('failed');
  };
  channel.onclose = () => {
    if (pc !== upstreamPc || !isCurrentUpstreamPeer(peerId)) {
      return;
    }
    diagnostics.update({ relayProtocolState: 'datachannel-closed' });
    if (upstreamMediaChannel === channel) upstreamMediaChannel = null;
    upstreamRecovery.stateChanged('closed');
  };
}

let lastUpstreamKeyframeRequestMs = -Infinity;
function requestUpstreamKeyframe(): void {
  const channel = upstreamMediaChannel;
  const now = performance.now();
  if (!upstreamPc || !channel || channel.readyState !== 'open' || now - lastUpstreamKeyframeRequestMs < 500) return;
  const manifest = getCurrentManifest();
  if (!manifest || typeof manifest.mediaSessionId !== 'string' || !manifest.mediaSessionId ||
    typeof manifest.manifestVersion !== 'number' || !Number.isSafeInteger(manifest.manifestVersion) || manifest.manifestVersion < 1) return;
  lastUpstreamKeyframeRequestMs = now;
  channel.send(JSON.stringify({ protocol: ENCODED_MEDIA_PROTOCOL, protocolVersion: ENCODED_MEDIA_PROTOCOL_VERSION,
    type: 'keyframe-request', mediaSessionId: manifest.mediaSessionId, manifestVersion: manifest.manifestVersion }));
}

function rotateRelaySourceEpoch(): void {
  const nonce = crypto.getRandomValues(new Uint32Array(4));
  relaySourceEpoch = `web-${Array.from(nonce, (value) => value.toString(16).padStart(8, '0')).join('')}`;
  lastBootstrapFrameId = '';
}

function handlePlaybackSourceChanged(): void {
  lastVideoKeyframeForRelay = null;
  rotateRelaySourceEpoch();
}

function sendRelayBootstrapKeyframe(): void {
  if (
    !downstreamDataChannel ||
    downstreamDataChannel.readyState !== 'open' ||
    !lastVideoKeyframeForRelay ||
    !isDataChannelRelayReady()
  ) {
    return;
  }
  const bootstrapFrameId = JSON.stringify([relaySourceEpoch, lastVideoKeyframeForRelay.timestampUs,
    lastVideoKeyframeForRelay.sequence, lastVideoKeyframeForRelay.payload.byteLength]);
  if (bootstrapFrameId === lastBootstrapFrameId) {
    return;
  }
  if (downstreamDataChannel.bufferedAmount > DATA_CHANNEL_MAX_BUFFERED_BYTES) {
    diagnostics.update({ relayFailureReason: 'relay-bootstrap-buffered-amount-high' });
    return;
  }
  try {
    const messages = encodeFrameMessages({
      protocol: ENCODED_MEDIA_PROTOCOL,
      type: 'frame',
      streamType: 'video',
      codec: lastVideoKeyframeForRelay.codec,
      sourceEpoch: relaySourceEpoch,
      payloadFormat: lastVideoKeyframeForRelay.payloadFormat,
      timestampUs: lastVideoKeyframeForRelay.timestampUs,
      sequence: lastVideoKeyframeForRelay.sequence,
      keyframe: true,
      config: true
    }, lastVideoKeyframeForRelay.payload);
    for (const message of messages) {
      if (!canSendDataChannelMessage('relay-bootstrap-buffered-amount-high')) {
        return;
      }
      downstreamDataChannel.send(message);
    }
    lastBootstrapFrameId = bootstrapFrameId;
    markDownstreamRelayForwarding('datachannel-bootstrap-sent');
    diagnostics.incrementCounter('dataChannelBootstrapFramesSent');
  } catch (error) {
    markRelayUnsupported(errorToMessage(error));
  }
}

function isDataChannelRelayReady(): boolean {
  return downstreamDataChannelReady;
}

function isCurrentDownstreamChannel(channel: RTCDataChannel, peerId: string): boolean {
  return channel === downstreamDataChannel && peerId === downstreamPeerId;
}

function handleViewerLeft(message: SignalMessage): void {
  const viewerId = String(message.viewerId || message.clientId || '');
  if (!viewerId || viewerId !== downstreamPeerId) {
    return;
  }
  downstreamCloseExpected = true;
  downstreamDataChannelReady = false;
  downstreamRelayForwarding = false;
  clearRelayHelloAckTimer();
  downstreamDataChannel?.close();
  downstreamPc?.close();
  downstreamDataChannel = null;
  relaySourceEpoch = '';
  downstreamPc = null;
  downstreamEdgeAttemptId = null;
  downstreamPeerId = '';
  errorText.textContent = '';
  diagnostics.update({
    relayProtocolState: 'downstream-left',
    relayFailureReason: undefined,
    lastError: undefined
  });
  restoreWatchingStatusAfterRelay();
}

function handleDownstreamChannelClosed(): void {
  const wasReady = downstreamDataChannelReady;
  if (wasReady) {
    downstreamCloseExpected = true;
  }
  downstreamDataChannelReady = false;
  downstreamRelayForwarding = false;
  clearRelayHelloAckTimer();
  diagnostics.update({
    relayProtocolState: wasReady || downstreamCloseExpected ? 'downstream-closed' : 'datachannel-closed'
  });
  if (wasReady || downstreamCloseExpected) {
    restoreWatchingStatusAfterRelay();
  }
}

function getCandidateIceUfrag(candidate: RTCIceCandidateInit): string {
  const extensions = String(candidate.candidate || '').trim().split(/\s+/).slice(8).join(' ');
  const textUfrags = Array.from(extensions.matchAll(/\bufrag\s+([^\s]+)/gi), (match) => match[1]);
  const objectUfrag = String(candidate.usernameFragment || '');
  if (new Set([...textUfrags, ...(objectUfrag ? [objectUfrag] : [])]).size > 1) return '!conflicting-ufrag';
  return objectUfrag || textUfrags[0] || '';
}

function isCandidateForRemoteDescription(
  candidate: RTCIceCandidateInit,
  description: RTCSessionDescriptionInit | null,
  iceUfrag = getCandidateIceUfrag(candidate)
): boolean {
  const extensions = String(candidate.candidate || '').trim().split(/\s+/).slice(8).join(' ');
  const predicted = /\bvds-predicted\s+1\b/i.test(extensions);
  if (!iceUfrag) return !predicted;
  const sdp = String(description?.sdp || '');
  const ufrags = Array.from(sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)\s*$/gm), (match) => match[1].trim());
  return ufrags.includes(iceUfrag);
}

function isCurrentIceCandidatePeer(peerId: string, pc: RTCPeerConnection): boolean {
  return Boolean(pc === downstreamPc && peerId === downstreamPeerId || pc === upstreamPc && isCurrentUpstreamPeer(peerId));
}

function queuePendingIceCandidate(
  peerId: string,
  candidate: RTCIceCandidateInit,
  attemptId: number | null = null,
  pc: RTCPeerConnection | null = null
): void {
  const existing = pendingIceCandidates.get(peerId) || [];
  const iceUfrag = getCandidateIceUfrag(candidate);
  if (existing.some((entry) => entry.attemptId === attemptId && entry.iceUfrag === iceUfrag &&
      entry.candidate.candidate === candidate.candidate)) return;
  existing.push({ candidate, attemptId, iceUfrag, pc });
  pendingIceCandidates.set(peerId, existing.slice(-128));
}

function isCurrentUpstreamPeer(peerId: string): boolean {
  return Boolean(session && peerId && session.upstreamPeerId === peerId);
}

function removePeerDiagnostics(peerId: string): void {
  if (!peerId) {
    return;
  }
  const snapshot = diagnostics.getSnapshot();
  const iceState = { ...snapshot.iceState };
  const candidateCounts = { ...snapshot.candidateCounts };
  delete iceState[peerId];
  delete iceState[`${peerId}:connection`];
  delete candidateCounts[peerId];
  diagnostics.update({ iceState, candidateCounts });
}

async function flushPendingIceCandidates(peerId: string, pc: RTCPeerConnection): Promise<void> {
  const pending = pendingIceCandidates.get(peerId);
  if (!pending || !pending.length || !pc.remoteDescription) {
    return;
  }
  pendingIceCandidates.delete(peerId);
  for (const entry of pending) {
    if (!isCurrentIceCandidatePeer(peerId, pc)) return;
    const expectedAttemptId = peerId === downstreamPeerId ? downstreamEdgeAttemptId : upstreamEdgeAttemptId;
    if (entry.pc && entry.pc !== pc || entry.attemptId && expectedAttemptId && entry.attemptId !== expectedAttemptId ||
        !isCandidateForRemoteDescription(entry.candidate, pc.remoteDescription, entry.iceUfrag)) continue;
    await pc.addIceCandidate(entry.candidate).catch((error) => {
      if (isCurrentIceCandidatePeer(peerId, pc)) {
        diagnostics.update({ relayFailureReason: `ice-candidate-failed:${errorToMessage(error)}` });
      }
    });
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    handleMobilePageSuspended('visibility-hidden', false);
    return;
  }
  clearMobileSuspendTimer();
}

function handleMobilePageSuspended(reason: string, immediate: boolean): void {
  if (!capability.mobile || !session) {
    return;
  }
  clearMobileSuspendTimer();
  const leave = () => {
    if (!session) {
      return;
    }
    diagnostics.update({
      relayProtocolState: reason,
      relayFailureReason: capability.relayCapable ? 'mobile-relay-suspended' : undefined
    });
    leaveCurrentRoom();
  };
  if (immediate) {
    leave();
    return;
  }
  mobileSuspendTimer = window.setTimeout(leave, 1500);
}

function clearMobileSuspendTimer(): void {
  if (mobileSuspendTimer !== null) {
    window.clearTimeout(mobileSuspendTimer);
    mobileSuspendTimer = null;
  }
}

function leaveCurrentRoom(): void {
  joinAttemptSeq += 1;
  clearJoinAckTimer();
  setJoinPending(false);
  if (!session) {
    return;
  }
  try {
    signaling.send({
      type: 'leave-room',
      roomId: session.roomId,
      clientId,
      sessionToken: session.sessionToken
    });
  } catch {
    // The server also has a disconnect grace path; this only accelerates normal tab closes.
  }
  resetLocalViewerSession();
}

function resetLocalViewerSession(): void {
  upstreamRecovery.stop();
  joinAttemptSeq += 1;
  clearJoinAckTimer();
  clearMobileSuspendTimer();
  setJoinPending(false);
  downstreamDataChannelReady = false;
  downstreamRelayForwarding = false;
  downstreamCloseExpected = true;
  clearRelayHelloAckTimer();
  playback.close();
  pendingIceCandidates.clear();
  downstreamDataChannel?.close();
  downstreamPc?.close();
  upstreamPc?.close();
  signaling.close();
  downstreamDataChannel = null;
  relaySourceEpoch = '';
  downstreamPc = null;
  upstreamPc = null;
  downstreamPeerId = '';
  upstreamEdgeAttemptId = null;
  downstreamEdgeAttemptId = null;
  lastBootstrapFrameId = '';
  lastVideoKeyframeForRelay = null;
  session = null;
  clearStoredSession();
  downstreamCloseExpected = false;
  joinCard.classList.remove('hidden');
  leaveButton.classList.add('hidden');
  viewerRoomId.textContent = '-';
  chainPositionText.textContent = '-';
  waitingMessage.classList.remove('hidden');
}

function handleInboundEncodedFrame(data: unknown, peerId: string): void {
  if (!(data instanceof ArrayBuffer)) {
    markRelayUnsupported('datachannel-frame-invalid');
    return;
  }

  try {
    const decoded = playback.acceptMessage(data);
    if (!decoded) {
      diagnostics.incrementCounter('dataChannelChunksReceived');
      return;
    }
    diagnostics.incrementCounter('dataChannelFramesReceived');
    if (decoded.header.streamType === 'video') {
      diagnostics.incrementCounter('encodedFramesReceived');
      diagnostics.update({ h264PayloadFormat: decoded.header.payloadFormat || 'unknown' });
      if (decoded.header.keyframe) {
        logVdsWebInfo(`[vds-web][video-keyframe] ${toConsoleJson({
          codec: decoded.header.codec,
          payloadFormat: decoded.header.payloadFormat,
          timestampUs: decoded.header.timestampUs,
          sequence: decoded.header.sequence,
          payloadBytes: decoded.payload.byteLength,
          mediaManifestVideo: (diagnostics.getSnapshot().mediaManifest as { video?: unknown } | undefined)?.video
        })}`);
        diagnostics.incrementCounter('encodedKeyframesReceived');
        lastVideoKeyframeForRelay = {
          codec: decoded.header.codec,
          sourceEpoch: decoded.header.sourceEpoch,
          timestampUs: decoded.header.timestampUs,
          sequence: decoded.header.sequence,
          payload: decoded.payload.slice(0),
          payloadFormat: decoded.header.payloadFormat || 'unknown'
        };
        sendRelayBootstrapKeyframe();
      }
      const received = diagnostics.getSnapshot().encodedFramesReceived;
      if (received === 1 || received % 120 === 0) {
        logVdsWebInfo(`[vds-web][video-frame-received] ${toConsoleJson({
          codec: decoded.header.codec,
          keyframe: decoded.header.keyframe,
          payloadFormat: decoded.header.payloadFormat,
          timestampUs: decoded.header.timestampUs,
          sequence: decoded.header.sequence,
          payloadBytes: decoded.payload.byteLength,
          encodedFramesReceived: received
        })}`);
      }
    }
    diagnostics.update({
      upstreamPeerId: peerId || diagnostics.getSnapshot().upstreamPeerId,
      relayProtocolState: `received-${decoded.header.streamType}-${decoded.header.codec}`
    });
    maybeSendViewerReady();
    // Forward the encoded frame independently of local decoding success.
    forwardEncodedFrame(decoded.header, decoded.payload);
  } catch (error) {
    markRelayUnsupported(errorToMessage(error));
  }
}

function forwardEncodedFrame(header: {
  streamType: 'video' | 'audio';
  codec: string;
  sourceEpoch?: string;
  payloadFormat?: 'annexb' | 'avcc' | 'raw' | 'opus-raw' | 'aac-adts' | 'unknown';
  timestampUs: number;
  sequence: number;
  keyframe: boolean;
  config: boolean;
}, payload: ArrayBuffer): void {
  if (!downstreamDataChannel || downstreamDataChannel.readyState !== 'open' || !isDataChannelRelayReady()) {
    return;
  }
  if (downstreamDataChannel.bufferedAmount > DATA_CHANNEL_MAX_BUFFERED_BYTES) {
    diagnostics.incrementCounter('dataChannelFramesDropped');
    return;
  }
  try {
    const messages = encodeFrameMessages({
      protocol: ENCODED_MEDIA_PROTOCOL,
      type: 'frame',
      streamType: header.streamType,
      codec: header.codec,
      sourceEpoch: relaySourceEpoch,
      payloadFormat: header.payloadFormat || 'unknown',
      timestampUs: header.timestampUs,
      sequence: header.sequence,
      keyframe: header.keyframe,
      config: header.config
    }, payload);
    for (const message of messages) {
      if (!canSendDataChannelMessage('relay-buffered-amount-high')) {
        diagnostics.incrementCounter('dataChannelFramesDropped');
        return;
      }
      downstreamDataChannel.send(message);
    }
    if (header.streamType === 'video') {
      diagnostics.incrementCounter('encodedFramesForwarded');
    } else if (header.streamType === 'audio') {
      diagnostics.incrementCounter('encodedAudioFramesForwarded');
    }
    diagnostics.incrementCounter('dataChannelFramesForwarded');
    markDownstreamRelayForwarding(`forwarding-${header.streamType}-${header.codec}`);
  } catch (error) {
    markRelayUnsupported(errorToMessage(error));
  }
}

function markDownstreamRelayReady(): void {
  diagnostics.update({
    status: 'relay 已连接',
    relayProtocolState: 'datachannel-ready',
    relayFailureReason: undefined,
    lastError: undefined
  });
  setStatus('relay 已连接');
}

function markDownstreamRelayForwarding(relayProtocolState: string): void {
  if (downstreamRelayForwarding && diagnostics.getSnapshot().status === 'relay 转发中') {
    return;
  }
  downstreamRelayForwarding = true;
  diagnostics.update({
    status: 'relay 转发中',
    relayProtocolState,
    relayFailureReason: undefined,
    lastError: undefined
  });
  setStatus('relay 转发中');
}

function restoreWatchingStatusAfterRelay(): void {
  if (!session) {
    return;
  }
  const snapshot = diagnostics.getSnapshot();
  if (!snapshot.lastError) {
    setStatus(snapshot.encodedFramesReceived > 0 || snapshot.webDecodedVideoFrames > 0 ? '观看中' : '等待上游');
  }
}

function canSendDataChannelMessage(dropReason: string): boolean {
  if (!downstreamDataChannel || downstreamDataChannel.readyState !== 'open') {
    return false;
  }
  downstreamDataChannel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFERED_LOW_BYTES;
  if (downstreamDataChannel.bufferedAmount <= DATA_CHANNEL_MAX_BUFFERED_BYTES) {
    return true;
  }
  diagnostics.update({ relayFailureReason: dropReason });
  return false;
}

function clearRelayHelloAckTimer(): void {
  if (relayHelloAckTimer !== null) {
    window.clearTimeout(relayHelloAckTimer);
    relayHelloAckTimer = null;
  }
}

async function refreshRooms(manual: boolean): Promise<void> {
  const refreshSeq = refreshRoomsSeq + 1;
  refreshRoomsSeq = refreshSeq;
  refreshRoomsInFlight = true;
  refreshRoomsButton.disabled = true;
  try {
    const rooms = await fetchPublicRooms();
    if (refreshSeq !== refreshRoomsSeq) {
      return;
    }
    roomList.replaceChildren(...rooms.map((room) => {
      const item = document.createElement('button');
      item.className = 'room-item';
      item.type = 'button';
      item.disabled = joinPending || Boolean(session && !restoringStoredSession);
      item.addEventListener('click', () => void joinRoom(room.roomId));
      const roomCode = document.createElement('span');
      roomCode.className = 'room-code';
      roomCode.textContent = String(room.roomId).toUpperCase();
      const roomMeta = document.createElement('span');
      roomMeta.className = 'room-meta';
      roomMeta.textContent = `人数${Math.max(0, Number(room.viewerCount) || 0)}`;
      item.append(roomCode, roomMeta);
      return item;
    }));
    roomListStatus.textContent = rooms.length ? `发现 ${rooms.length} 个公开房间` : '暂无公开房间。';
    if (manual) {
      setStatus('大厅已刷新');
    }
  } catch (error) {
    if (refreshSeq !== refreshRoomsSeq) {
      return;
    }
    roomListStatus.textContent = '大厅刷新失败。';
    if (manual) {
      setError(errorToMessage(error));
    }
  } finally {
    if (refreshSeq === refreshRoomsSeq) {
      refreshRoomsInFlight = false;
      setJoinPending(joinPending);
    }
  }
}

function getWebEncodedMediaCapabilities() {
  return webEncodedMediaCapabilities({
    supportedVideoCodecs: capability.supportedVideoCodecs,
    supportedAudioCodecs: capability.supportedAudioCodecs
  });
}

function renderCapability(report: CapabilityReport): void {
  const relayText = report.relayCapable ? `relay x${report.maxDirectDownstreams}` : 'leaf only';
  const browserText = report.browser || report.browserFamily;
  const platformText = `${report.platform}/${browserText}`;
  const videoText = report.supportedVideoCodecs.length ? report.supportedVideoCodecs.join('/') : 'no video';
  const audioText = report.supportedAudioCodecs.length ? report.supportedAudioCodecs.join('/') : 'no audio';
  const outputText = report.audioOutput ? 'audio out' : 'no audio out';
  capabilitySummary.textContent = `${platformText} · ${relayText} · ${report.relayEligibilityReason} · ${videoText} · ${audioText} · ${outputText}`;
  const status = !capabilityDetectionComplete ? '能力检测中' : report.ok ? '等待加入' : '能力不足';
  diagnostics.update({ capability: report, status });
}

function unlockAudioFromUserGesture(): void {
  void playback.resumeAudio().catch(() => {});
}

function setJoinPending(pending: boolean): void {
  if (!pending) {
    clearJoinAckTimer();
    pendingJoinRoomId = '';
  }
  joinPending = pending;
  const disabled = pending || !capabilityDetectionComplete || !capability.ok;
  joinButton.disabled = disabled;
  roomIdInput.disabled = disabled;
  refreshRoomsButton.disabled = disabled || refreshRoomsInFlight;
  lobbyTabButton.disabled = pending;
  directTabButton.disabled = pending;
  roomList.querySelectorAll<HTMLButtonElement>('button.room-item').forEach((button) => {
    button.disabled = disabled || Boolean(session && !restoringStoredSession);
  });
}

function startJoinAckTimer(joinSeq: number): void {
  clearJoinAckTimer();
  joinAckTimer = window.setTimeout(() => {
    joinAckTimer = null;
    if (joinSeq !== joinAttemptSeq || !joinPending) {
      return;
    }
    joinAttemptSeq += 1;
    setJoinPending(false);
    restoringStoredSession = false;
    signaling.close();
    setError('加入房间超时，请重试。');
  }, 10000);
}

function clearJoinAckTimer(): void {
  if (joinAckTimer !== null) {
    window.clearTimeout(joinAckTimer);
    joinAckTimer = null;
  }
}

function renderDiagnostics(): void {
  const snapshot = diagnostics.getSnapshot();
  applyVideoManifestDisplaySize(snapshot.mediaManifest);
  applyAudioManifestFormat(snapshot.mediaManifest);
  const now = Date.now();
  if (
    snapshot.mediaManifest &&
    snapshot.webDecodedVideoFrames === 0 &&
    snapshot.dataChannelFramesReceived === 0 &&
    now - lastConsoleDiagnosticsAt > 1000
  ) {
    lastConsoleDiagnosticsAt = now;
    logVdsWebInfo(`[vds-web][diagnostics] ${toConsoleJson(snapshot)}`);
  }
  const formattedDiagnostics = diagnostics.format();
  diagnosticsOutput.value = formattedDiagnostics;
  syncDiagnosticsDownloadHint(formattedDiagnostics);
  viewerRoomId.textContent = snapshot.roomId || '-';
  chainPositionText.textContent = formatChainPosition(snapshot.chainPosition);
  decodedVideoText.textContent = String(snapshot.webDecodedVideoFrames || 0);
  decodedAudioText.textContent = String(snapshot.webDecodedAudioBlocks || 0);
}

function setStatus(text: string): void {
  statusBadge.textContent = text.startsWith('P2P：') ? text : `P2P：${text}`;
  statusText.textContent = text;
  diagnostics.update({ status: text });
}

function setError(text: string): void {
  errorText.textContent = text;
  statusBadge.textContent = 'P2P：连接失败';
  diagnostics.update({ status: '连接失败', lastError: text });
}

function clearError(): void {
  errorText.textContent = '';
}

async function writeTextToClipboard(text: string): Promise<void> {
  const value = String(text || '');
  if (!value) {
    throw new Error('clipboard-text-empty');
  }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand('copy')) {
      throw new Error('clipboard-write-failed');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyDiagnosticsReport(): Promise<void> {
  if (copyDiagnosticsInFlight) {
    return;
  }
  copyDiagnosticsInFlight = true;
  const previousDisabled = copyDiagnosticsButton.disabled;
  copyDiagnosticsButton.disabled = true;
  try {
    await writeTextToClipboard(diagnostics.format());
    setStatus('诊断已复制');
  } catch (error) {
    setError(errorToMessage(error));
  } finally {
    copyDiagnosticsInFlight = false;
    copyDiagnosticsButton.disabled = previousDisabled;
  }
}

function diagnosticsFixtureFilename(content: string): string {
  try {
    const parsed = JSON.parse(content) as { recommendedFixtureFilename?: unknown };
    const filename = String(parsed.recommendedFixtureFilename || '').trim();
    if (/^[a-z0-9-]+\.json$/i.test(filename)) {
      return filename;
    }
  } catch {
    // Fall through to a generic name if the report cannot be parsed.
  }
  return 'vds-web-diagnostics.json';
}

function syncDiagnosticsDownloadHint(content: string): void {
  const filename = diagnosticsFixtureFilename(content);
  downloadDiagnosticsButton.title = `保存为 ${filename}`;
  downloadDiagnosticsButton.setAttribute('aria-label', `保存诊断为 ${filename}`);
}

function downloadDiagnosticsReport(): void {
  const content = diagnostics.format();
  if (!content) {
    setError('诊断内容为空。');
    return;
  }
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = diagnosticsFixtureFilename(content);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`诊断已保存为 ${link.download}`);
}

async function toggleFullscreen(): Promise<void> {
  if (fullscreenTransitionPromise) {
    return fullscreenTransitionPromise;
  }
  if (!isFullscreenSupported()) {
    setError('当前浏览器不支持网页全屏。');
    return;
  }
  fullscreenTransitionPromise = (async () => {
    try {
      if (document.fullscreenElement === playerShell) {
        await document.exitFullscreen();
        return;
      }
      await playerShell.requestFullscreen();
    } catch (error) {
      setError(errorToMessage(error));
    } finally {
      fullscreenTransitionPromise = null;
    }
  })();
  return fullscreenTransitionPromise;
}

function syncFullscreenButton(): void {
  const active = document.fullscreenElement === playerShell;
  fullscreenButton.setAttribute('aria-label', active ? '退出全屏' : '全屏');
  fullscreenButton.setAttribute('title', active ? '退出全屏' : '全屏');
}

function isFullscreenSupported(): boolean {
  return document.fullscreenEnabled !== false && typeof playerShell.requestFullscreen === 'function';
}

function syncFullscreenAvailability(): void {
  fullscreenButton.classList.toggle('hidden', !isFullscreenSupported());
}

function setPlayerVolume(value: number): void {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 100));
  playerVolumeInput.value = String(normalized);
  playerVolumeValue.textContent = `${normalized}%`;
  playback.setVolume(normalized / 100);
  muteButton.setAttribute('aria-label', normalized <= 0 ? '取消静音' : '静音');
  muteButton.setAttribute('title', normalized <= 0 ? '取消静音' : '静音');
}

function toggleMute(): void {
  const current = Number(playerVolumeInput.value);
  setPlayerVolume(current > 0 ? 0 : 100);
}

function setJoinMode(mode: 'lobby' | 'direct'): void {
  const lobby = mode === 'lobby';
  lobbyTabButton.classList.toggle('active', lobby);
  directTabButton.classList.toggle('active', !lobby);
  lobbyJoinPanel.classList.toggle('hidden', !lobby);
  directJoinPanel.classList.toggle('hidden', lobby);
}

function setAudioDelay(value: number): void {
  const normalized = Number.isFinite(value) ? value : 0;
  const delayMs = Math.max(0, Math.min(300, Math.round(normalized / 10) * 10));
  audioDelayInput.value = String(delayMs);
  playback.setDelayMs(delayMs);
}

function normalizeDescription(message: SignalMessage): RTCSessionDescriptionInit | null {
  const description = message.sdp || message.offer || message.answer;
  if (!description || typeof description !== 'object') {
    return null;
  }
  if (typeof description.type !== 'string' || typeof description.sdp !== 'string') {
    return null;
  }
  return {
    type: description.type as RTCSdpType,
    sdp: description.sdp
  };
}

function getSignalAttemptId(message: SignalMessage): number | null {
  const attemptId = Number(message.attemptId);
  return Number.isInteger(attemptId) && attemptId > 0 ? attemptId : null;
}

function isEncodedDataChannelOffer(sdp: string): boolean {
  return sdp.includes('m=application') && sdp.includes('webrtc-datachannel');
}

function getManifestCompatibilityFailure(mediaManifest: unknown): string {
  if (!mediaManifest || typeof mediaManifest !== 'object') {
    return 'host-media-manifest-missing';
  }
  const manifest = mediaManifest as {
    protocol?: unknown;
    video?: { codec?: unknown; payloadFormat?: unknown };
    audio?: { codec?: unknown; payloadFormat?: unknown };
  };
  if (manifest.protocol !== ENCODED_MEDIA_PROTOCOL) {
    return 'host-media-manifest-protocol-unsupported';
  }
  const normalizedVideoCodec = normalizeManifestCodecName(manifest.video?.codec);
  if (!capability.supportedVideoCodecs.includes(normalizedVideoCodec)) {
    return `web-video-codec-unsupported:${normalizedVideoCodec || 'unknown'}`;
  }
  const videoPayloadFormat = String(manifest.video?.payloadFormat || 'annexb').toLowerCase();
  if (videoPayloadFormat !== 'annexb' && videoPayloadFormat !== 'avcc') {
    return `web-video-payload-format-unsupported:${videoPayloadFormat || 'unknown'}`;
  }
  const normalizedAudioCodec = normalizeManifestCodecName(manifest.audio?.codec || 'opus');
  if (!capability.supportedAudioCodecs.includes(normalizedAudioCodec)) {
    return `web-audio-codec-unsupported:${normalizedAudioCodec || 'unknown'}`;
  }
  const audioPayloadFormat = String(manifest.audio?.payloadFormat || (normalizedAudioCodec === 'aac' ? 'aac-adts' : 'opus-raw')).toLowerCase();
  if (normalizedAudioCodec === 'opus' && audioPayloadFormat !== 'opus-raw' && audioPayloadFormat !== 'raw') {
    return `web-audio-payload-format-unsupported:${audioPayloadFormat || 'unknown'}`;
  }
  if (normalizedAudioCodec === 'aac' && audioPayloadFormat !== 'aac-adts' && audioPayloadFormat !== 'raw') {
    return `web-audio-payload-format-unsupported:${audioPayloadFormat || 'unknown'}`;
  }
  return '';
}

function normalizeManifestCodecName(value: unknown): string {
  const raw = String(value || '').toLowerCase().trim();
  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (raw.startsWith('avc1') || raw.startsWith('avc3') || compact.startsWith('avc1') || compact.startsWith('avc3')) {
    return 'h264';
  }
  if (raw.startsWith('hvc1') || raw.startsWith('hev1') || compact.startsWith('hvc1') || compact.startsWith('hev1') || compact === 'hevc') {
    return 'h265';
  }
  if (compact === 'mp4a402') {
    return 'aac';
  }
  if (raw === 'opus' || raw === 'aac' || raw === 'h264' || raw === 'h265') {
    return raw;
  }
  return raw;
}

function getCurrentManifest(): { mediaSessionId?: unknown; manifestVersion?: unknown } | undefined {
  const manifest = diagnostics.getSnapshot().mediaManifest;
  return manifest && typeof manifest === 'object'
    ? manifest as { mediaSessionId?: unknown; manifestVersion?: unknown }
    : undefined;
}

function getControlManifestFailure(control: { mediaSessionId?: unknown; manifestVersion?: unknown }): string {
  const manifest = getCurrentManifest();
  if (!manifest) {
    return '';
  }
  const expectedSessionId = typeof manifest.mediaSessionId === 'string' ? manifest.mediaSessionId : '';
  const actualSessionId = typeof control.mediaSessionId === 'string' ? control.mediaSessionId : '';
  if (expectedSessionId && actualSessionId && expectedSessionId !== actualSessionId) {
    return 'datachannel-media-session-mismatch';
  }
  const expectedVersion = typeof manifest.manifestVersion === 'number' ? manifest.manifestVersion : 0;
  const actualVersion = typeof control.manifestVersion === 'number' ? control.manifestVersion : 0;
  if (expectedVersion > 0 && actualVersion > 0 && expectedVersion !== actualVersion) {
    return 'datachannel-media-manifest-version-mismatch';
  }
  return '';
}

function getManifestVideoCodec(): string {
  const manifest = diagnostics.getSnapshot().mediaManifest as { video?: { codec?: unknown } } | undefined;
  return normalizeManifestCodecName(manifest?.video?.codec);
}

function applyAudioManifestFormat(mediaManifest: unknown): void {
  if (!mediaManifest || typeof mediaManifest !== 'object') {
    return;
  }
  const audio = (mediaManifest as { audio?: { sampleRate?: unknown; channels?: unknown } }).audio;
  playback.setAudioFormat(Number(audio?.sampleRate || 48000), Number(audio?.channels || 2));
}

function applyVideoManifestDisplaySize(mediaManifest: unknown): void {
  if (!mediaManifest || typeof mediaManifest !== 'object') {
    return;
  }
  const video = (mediaManifest as { video?: { width?: unknown; height?: unknown; frameRate?: unknown; fps?: unknown } }).video;
  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);
  playback.setVideoDisplaySize(width, height, Number(video?.frameRate || video?.fps || 0));
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

function getClientId(): string {
  const existing = sessionStorage.getItem('vds-web-client-id');
  if (existing) {
    return existing;
  }
  const value = `web-${createClientUuid()}`;
  sessionStorage.setItem('vds-web-client-id', value);
  return value;
}

function createClientUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readStoredSession(expectedClientId: string): SessionState | null {
  try {
    const raw = sessionStorage.getItem('vds-web-session');
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (
      typeof parsed.roomId !== 'string' ||
      parsed.roomId.trim() === '' ||
      parsed.clientId !== expectedClientId ||
      typeof parsed.sessionToken !== 'string' ||
      parsed.sessionToken.trim() === ''
    ) {
      clearStoredSession();
      return null;
    }
    const chainPosition = Number(parsed.chainPosition);
    return {
      roomId: parsed.roomId,
      clientId: expectedClientId,
      sessionToken: parsed.sessionToken,
      hostId: typeof parsed.hostId === 'string' ? parsed.hostId : undefined,
      upstreamPeerId: typeof parsed.upstreamPeerId === 'string' ? parsed.upstreamPeerId : undefined,
      chainPosition: Number.isFinite(chainPosition) ? chainPosition : 0
    };
  } catch {
    clearStoredSession();
    return null;
  }
}

function clearStoredSession(): void {
  sessionStorage.removeItem('vds-web-session');
  restoringStoredSession = false;
}

function formatChainPosition(value: unknown): string {
  const position = Number(value);
  return Number.isFinite(position) ? String(position + 1) : '-';
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toConsoleJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function logVdsWebInfo(message: string): void {
  console.info(message);
}
