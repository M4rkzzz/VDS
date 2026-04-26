import './styles.css';
import { detectCapabilities, type CapabilityReport } from './capabilities';
import {
  DATA_CHANNEL_HELLO_ACK_TIMEOUT_MS,
  DATA_CHANNEL_OPEN_TIMEOUT_MS,
  ENCODED_MEDIA_CHANNEL_LABEL,
  ENCODED_MEDIA_PROTOCOL,
  ENCODED_MEDIA_PROTOCOL_VERSION,
  EncodedFrameReassembler,
  encodeFrameMessages,
  helloAckMessage,
  helloMessage,
  parseControlMessage,
  webEncodedMediaCapabilities
} from './datachannel-protocol';
import { DiagnosticsStore } from './diagnostics';
import { fetchPublicRooms, fetchServerConfig, VdsWebSignaling, type SignalMessage } from './signaling';
import { WebCodecsAudioPlayer } from './webcodecs-audio-player';
import { WebCodecsVideoPlayer } from './webcodecs-player';

type SessionState = {
  roomId: string;
  clientId: string;
  sessionToken?: string;
  hostId?: string;
  upstreamPeerId?: string;
  chainPosition: number;
};

const clientId = getClientId();
const capability = detectCapabilities();
const diagnostics = new DiagnosticsStore(capability, clientId);
const signaling = new VdsWebSignaling();

let serverConfig: { iceServers: RTCIceServer[]; version?: string } = { iceServers: [] };
let session: SessionState | null = null;
let upstreamPc: RTCPeerConnection | null = null;
let downstreamPc: RTCPeerConnection | null = null;
let downstreamDataChannel: RTCDataChannel | null = null;
let downstreamDataChannelReady = false;
let downstreamCloseExpected = false;
let relayHelloAckTimer: number | null = null;
let downstreamPeerId = '';
let viewerReadySent = false;
const pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
const inboundFrameReassembler = new EncodedFrameReassembler();
const DATA_CHANNEL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
let lastVideoKeyframeForRelay: {
  timestampUs: number;
  sequence: number;
  payload: ArrayBuffer;
  payloadFormat: 'annexb' | 'avcc' | 'raw' | 'unknown';
  capturedAt: number;
} | null = null;
let lastBootstrapFrameId = '';
let lastConsoleDiagnosticsAt = 0;

const statusBadge = getElement<HTMLSpanElement>('statusBadge');
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
const leaveButton = getElement<HTMLButtonElement>('leaveButton');
const audioDelayInput = getElement<HTMLInputElement>('audioDelayInput');
const audioDelayDecrease = getElement<HTMLButtonElement>('audioDelayDecrease');
const audioDelayIncrease = getElement<HTMLButtonElement>('audioDelayIncrease');
const dataChannelCanvas = getElement<HTMLCanvasElement>('dataChannelCanvas');
const dataChannelVideoPlayer = new WebCodecsVideoPlayer(dataChannelCanvas, {
  onState: (state) => {
    console.info(`[vds-web][webcodecs-state] ${state}`);
    diagnostics.update({ relayProtocolState: state });
  },
  onDecodedFrame: () => {
    diagnostics.incrementCounter('webDecodedVideoFrames');
    waitingMessage.classList.add('hidden');
  },
  onDroppedFrame: (reason) => {
    console.info(`[vds-web][webcodecs-video-drop] ${toConsoleJson({
      reason,
      snapshot: diagnostics.getSnapshot()
    })}`);
    diagnostics.incrementCounter('webDroppedVideoFrames');
    diagnostics.update({ relayFailureReason: reason });
  },
  onPayloadFormat: (format) => diagnostics.update({ h264PayloadFormat: format }),
  onVideoFrameInfo: (info) => {
    const snapshot = diagnostics.getSnapshot();
    console.info(`[vds-web][video-frame] ${toConsoleJson({
      ...info,
      mediaManifestVideo: (snapshot.mediaManifest as { video?: unknown } | undefined)?.video,
      decodedFrames: snapshot.webDecodedVideoFrames,
      droppedFrames: snapshot.webDroppedVideoFrames,
      encodedFramesReceived: snapshot.encodedFramesReceived,
      relayProtocolState: snapshot.relayProtocolState
    })}`);
  }
});
const dataChannelAudioPlayer = new WebCodecsAudioPlayer({
  onState: (state) => {
    console.info(`[vds-web][webcodecs-audio-state] ${state}`);
    diagnostics.update({ relayProtocolState: state });
  },
  onDecodedBlock: () => diagnostics.incrementCounter('webDecodedAudioBlocks'),
  onDroppedBlock: (reason) => {
    console.info(`[vds-web][webcodecs-audio-drop] ${reason}`);
    diagnostics.incrementCounter('webDroppedAudioBlocks');
    diagnostics.update({ relayFailureReason: reason });
  }
});

diagnostics.subscribe(renderDiagnostics);
signaling.onMessage((message) => void handleSignal(message));
signaling.onStatus((status) => {
  if (status === 'closed') {
    setStatus('连接已断开');
  } else if (status === 'error') {
    setError('WebSocket 连接失败。');
  }
});

joinButton.addEventListener('click', () => void joinRoom(roomIdInput.value.trim()));
refreshRoomsButton.addEventListener('click', () => void refreshRooms(true));
copyDiagnosticsButton.addEventListener('click', () => void navigator.clipboard.writeText(diagnostics.format()));
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
audioDelayInput.addEventListener('change', () => setAudioDelay(Number(audioDelayInput.value)));
audioDelayDecrease.addEventListener('click', () => setAudioDelay(Number(audioDelayInput.value) - 10));
audioDelayIncrease.addEventListener('click', () => setAudioDelay(Number(audioDelayInput.value) + 10));
window.addEventListener('pagehide', () => leaveCurrentRoom());
window.addEventListener('beforeunload', () => leaveCurrentRoom());

void bootstrap();

async function bootstrap(): Promise<void> {
  renderCapability(capability);
  renderDiagnostics();

  if (!capability.ok) {
    joinButton.disabled = true;
    setError(capability.reasons.join(' '));
    return;
  }

  try {
    serverConfig = await fetchServerConfig();
    await refreshRooms(false);
    setStatus('等待加入');
  } catch (error) {
    setError(errorToMessage(error));
  }
}

async function joinRoom(roomId: string): Promise<void> {
  if (!capability.ok) {
    setError(capability.reasons.join(' '));
    return;
  }
  if (!roomId) {
    setError('请输入房间码。');
    return;
  }

  try {
    setStatus('连接信令中');
    await dataChannelAudioPlayer.resume();
    await signaling.connect();
    signaling.send({
      type: 'join-room',
      roomId,
      clientId,
      sessionToken: session?.roomId === roomId ? session.sessionToken : undefined,
      webViewer: true,
      encodedRelayRequired: true,
      mediaCapabilities: {
        webViewer: true,
        encodedMediaDataChannel: webEncodedMediaCapabilities()
      }
    });
    setStatus('等待上游');
  } catch (error) {
    setError(errorToMessage(error));
  }
}

async function handleSignal(message: SignalMessage): Promise<void> {
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
      setError('主持端已断开。');
      break;
    case 'error':
      setError(`${String(message.code || 'error')}: ${String(message.message || '')}`);
      break;
  }
}

function handleJoined(message: SignalMessage): void {
  const manifestFailure = getManifestCompatibilityFailure(message.mediaManifest);
  if (manifestFailure) {
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
  viewerReadySent = false;
  joinCard.classList.add('hidden');
  leaveButton.classList.remove('hidden');
  viewerRoomId.textContent = session.roomId || '-';
  chainPositionText.textContent = String(session.chainPosition);
  diagnostics.update({
    status: '等待上游',
    roomId: session.roomId,
    sessionToken: session.sessionToken,
    hostId: session.hostId,
    upstreamPeerId: session.upstreamPeerId,
    chainPosition: session.chainPosition,
    mediaManifest: message.mediaManifest
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
  diagnostics.update({ mediaManifest: message.mediaManifest });

  const pc = ensureUpstreamPeer(sourceId);
  pc.ondatachannel = (event) => attachInboundDataChannel(event.channel, sourceId);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await flushPendingIceCandidates(sourceId, pc);
  signaling.send({
    type: 'answer',
    roomId: session.roomId,
    targetId: sourceId,
    sdp: pc.localDescription || answer
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
  await downstreamPc.setRemoteDescription(sdp);
  await flushPendingIceCandidates(downstreamPeerId, downstreamPc);
}

async function handleIceCandidate(message: SignalMessage): Promise<void> {
  const candidate = message.candidate;
  if (!candidate) {
    return;
  }

  const peerId = String(message.fromClientId || message.sourceId || message.targetId || '');
  const pc = peerId && peerId === downstreamPeerId ? downstreamPc : upstreamPc;
  if (!pc) {
    return;
  }

  diagnostics.incrementCandidate(peerId || 'unknown', 'remote');
  if (!pc.remoteDescription) {
    queuePendingIceCandidate(peerId || 'unknown', candidate);
    return;
  }
  await pc.addIceCandidate(candidate).catch((error) => {
    diagnostics.update({ relayFailureReason: `ice-candidate-failed:${errorToMessage(error)}` });
  });
}

async function handleConnectToNext(message: SignalMessage): Promise<void> {
  if (!session) {
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
  downstreamCloseExpected = false;
  clearRelayHelloAckTimer();
  downstreamPc = new RTCPeerConnection({ iceServers: serverConfig.iceServers });
  wirePeerEvents(downstreamPc, downstreamPeerId);
  downstreamDataChannel = downstreamPc.createDataChannel(ENCODED_MEDIA_CHANNEL_LABEL, {
    ordered: true
  });
  attachOutboundDataChannel(downstreamDataChannel, downstreamPeerId);

  const offer = await downstreamPc.createOffer();
  await downstreamPc.setLocalDescription(offer);
  signaling.send({
    type: 'offer',
    roomId: session.roomId,
    targetId: downstreamPeerId,
    sdp: downstreamPc.localDescription || offer,
    mediaCapabilities: {
      encodedMediaDataChannel: webEncodedMediaCapabilities()
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
  upstreamPc?.close();
  upstreamPc = null;
  if (previousUpstreamPeerId) {
    pendingIceCandidates.delete(previousUpstreamPeerId);
    removePeerDiagnostics(previousUpstreamPeerId);
  }
  pendingIceCandidates.delete(nextUpstreamPeerId);
  viewerReadySent = false;
  lastBootstrapFrameId = '';
  clearError();

  session = {
    ...session,
    upstreamPeerId: nextUpstreamPeerId,
    chainPosition: nextChainPosition
  };
  sessionStorage.setItem('vds-web-session', JSON.stringify(session));
  chainPositionText.textContent = String(nextChainPosition);
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

  upstreamPc = new RTCPeerConnection({ iceServers: serverConfig.iceServers });
  wirePeerEvents(upstreamPc, peerId);
  upstreamPc.ondatachannel = (event) => attachInboundDataChannel(event.channel, peerId);
  upstreamPc.ontrack = () => {
    markRelayUnsupported('web-media-track-received-disabled');
  };

  return upstreamPc;
}

function wirePeerEvents(pc: RTCPeerConnection, peerId: string): void {
  pc.onicecandidate = (event) => {
    if (!session || !event.candidate) {
      return;
    }
    diagnostics.incrementCandidate(peerId, 'local');
    signaling.send({
      type: 'ice-candidate',
      roomId: session.roomId,
      targetId: peerId,
      candidate: event.candidate.toJSON()
    });
  };
  pc.oniceconnectionstatechange = () => {
    diagnostics.updateIce(peerId, pc.iceConnectionState);
  };
  pc.onconnectionstatechange = () => {
    diagnostics.updateIce(`${peerId}:connection`, pc.connectionState);
  };
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
    chainPosition: session.chainPosition
  });
}

function markRelayUnsupported(reason: string): void {
  diagnostics.update({
    status: 'relay 失败',
    relayProtocolState: 'failed',
    relayFailureReason: reason,
    reencodePathUsed: false
  });
  setError(`DataChannel encoded relay failfast: ${reason}`);
}

function attachOutboundDataChannel(channel: RTCDataChannel, peerId: string): void {
  downstreamCloseExpected = false;
  diagnostics.update({ relayProtocolState: 'datachannel-opening' });
  const openTimer = window.setTimeout(() => {
    if (channel.readyState !== 'open') {
      markRelayUnsupported('datachannel-open-timeout');
      channel.close();
    }
  }, DATA_CHANNEL_OPEN_TIMEOUT_MS);

  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    window.clearTimeout(openTimer);
    diagnostics.update({ relayProtocolState: 'datachannel-hello-sent' });
    channel.send(JSON.stringify(helloMessage('relay', getCurrentManifest())));
    relayHelloAckTimer = window.setTimeout(() => {
      markRelayUnsupported('datachannel-hello-ack-timeout');
      channel.close();
    }, DATA_CHANNEL_HELLO_ACK_TIMEOUT_MS);
  };
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const control = parseControlMessage(event.data);
      if (control?.type === 'hello-ack') {
        const sessionFailure = getControlManifestFailure(control);
        if (sessionFailure) {
          markRelayUnsupported(sessionFailure);
          channel.close();
          return;
        }
        clearRelayHelloAckTimer();
        downstreamDataChannelReady = true;
        diagnostics.update({ relayProtocolState: 'datachannel-ready' });
        sendRelayBootstrapKeyframe();
      } else if (control?.type === 'error') {
        markRelayUnsupported(control.reason || 'datachannel-remote-error');
      }
      return;
    }
    handleInboundEncodedFrame(event.data, peerId);
  };
  channel.onerror = () => {
    if (downstreamCloseExpected || downstreamDataChannelReady || channel.readyState === 'closing' || channel.readyState === 'closed') {
      handleDownstreamChannelClosed();
      return;
    }
    markRelayUnsupported('datachannel-error');
  };
  channel.onclose = () => {
    clearRelayHelloAckTimer();
    handleDownstreamChannelClosed();
  };
}

function attachInboundDataChannel(channel: RTCDataChannel, peerId: string): void {
  if (channel.label !== ENCODED_MEDIA_CHANNEL_LABEL) {
    return;
  }

  channel.binaryType = 'arraybuffer';
  diagnostics.update({ relayProtocolState: 'datachannel-inbound-attached' });
  channel.onmessage = (event) => {
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
        diagnostics.update({ relayProtocolState: 'datachannel-ready' });
        maybeSendViewerReady();
      }
      return;
    }

    handleInboundEncodedFrame(event.data, peerId);
  };
  channel.onerror = () => {
    if (!isCurrentUpstreamPeer(peerId)) {
      return;
    }
    markRelayUnsupported('datachannel-error');
  };
  channel.onclose = () => {
    if (!isCurrentUpstreamPeer(peerId)) {
      return;
    }
    diagnostics.update({ relayProtocolState: 'datachannel-closed' });
  };
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
  const bootstrapFrameId = `${lastVideoKeyframeForRelay.timestampUs}:${lastVideoKeyframeForRelay.sequence}:${lastVideoKeyframeForRelay.payload.byteLength}`;
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
      codec: getManifestVideoCodec() || 'h264',
      payloadFormat: lastVideoKeyframeForRelay.payloadFormat,
      timestampUs: lastVideoKeyframeForRelay.timestampUs,
      sequence: lastVideoKeyframeForRelay.sequence,
      keyframe: true,
      config: true
    }, lastVideoKeyframeForRelay.payload);
    for (const message of messages) {
      downstreamDataChannel.send(message);
    }
    lastBootstrapFrameId = bootstrapFrameId;
    diagnostics.update({ relayProtocolState: 'datachannel-bootstrap-sent' });
    diagnostics.incrementCounter('dataChannelBootstrapFramesSent');
  } catch (error) {
    markRelayUnsupported(errorToMessage(error));
  }
}

function isDataChannelRelayReady(): boolean {
  return downstreamDataChannelReady;
}

function handleViewerLeft(message: SignalMessage): void {
  const viewerId = String(message.viewerId || message.clientId || '');
  if (!viewerId || viewerId !== downstreamPeerId) {
    return;
  }
  downstreamCloseExpected = true;
  downstreamDataChannelReady = false;
  clearRelayHelloAckTimer();
  downstreamDataChannel?.close();
  downstreamPc?.close();
  downstreamDataChannel = null;
  downstreamPc = null;
  downstreamPeerId = '';
  errorText.textContent = '';
  diagnostics.update({
    relayProtocolState: 'downstream-left',
    relayFailureReason: undefined,
    lastError: undefined
  });
}

function handleDownstreamChannelClosed(): void {
  const wasReady = downstreamDataChannelReady;
  if (wasReady) {
    downstreamCloseExpected = true;
  }
  downstreamDataChannelReady = false;
  clearRelayHelloAckTimer();
  diagnostics.update({
    relayProtocolState: wasReady || downstreamCloseExpected ? 'downstream-closed' : 'datachannel-closed'
  });
}

function queuePendingIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
  const existing = pendingIceCandidates.get(peerId) || [];
  existing.push(candidate);
  pendingIceCandidates.set(peerId, existing.slice(-32));
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
  for (const candidate of pending) {
    await pc.addIceCandidate(candidate).catch((error) => {
      diagnostics.update({ relayFailureReason: `ice-candidate-failed:${errorToMessage(error)}` });
    });
  }
}

function leaveCurrentRoom(): void {
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
  downstreamDataChannelReady = false;
  downstreamCloseExpected = true;
  clearRelayHelloAckTimer();
  downstreamDataChannel?.close();
  downstreamPc?.close();
  upstreamPc?.close();
  signaling.close();
  downstreamDataChannel = null;
  downstreamPc = null;
  upstreamPc = null;
  session = null;
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
    const decoded = inboundFrameReassembler.push(data);
    if (!decoded) {
      diagnostics.incrementCounter('dataChannelChunksReceived');
      return;
    }
    diagnostics.incrementCounter('dataChannelFramesReceived');
    if (decoded.header.streamType === 'video') {
      diagnostics.incrementCounter('encodedFramesReceived');
      diagnostics.update({ h264PayloadFormat: decoded.header.payloadFormat || 'unknown' });
      if (decoded.header.keyframe) {
        console.info(`[vds-web][video-keyframe] ${toConsoleJson({
          codec: decoded.header.codec,
          payloadFormat: decoded.header.payloadFormat,
          timestampUs: decoded.header.timestampUs,
          sequence: decoded.header.sequence,
          payloadBytes: decoded.payload.byteLength,
          mediaManifestVideo: (diagnostics.getSnapshot().mediaManifest as { video?: unknown } | undefined)?.video
        })}`);
        diagnostics.incrementCounter('encodedKeyframesReceived');
        lastVideoKeyframeForRelay = {
          timestampUs: decoded.header.timestampUs,
          sequence: decoded.header.sequence,
          payload: decoded.payload.slice(0),
          payloadFormat: decoded.header.payloadFormat || 'unknown',
          capturedAt: Date.now()
        };
        sendRelayBootstrapKeyframe();
      }
      const received = diagnostics.getSnapshot().encodedFramesReceived;
      if (received === 1 || received % 120 === 0) {
        console.info(`[vds-web][video-frame-received] ${toConsoleJson({
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
    if (decoded.header.streamType === 'audio') {
      void dataChannelAudioPlayer.pushFrame(decoded.header, decoded.payload);
    } else {
      void dataChannelVideoPlayer.pushFrame(decoded.header, decoded.payload);
    }
    forwardDecodedDataChannelFrame(decoded.header, decoded.payload);
  } catch (error) {
    markRelayUnsupported(errorToMessage(error));
  }
}

function forwardDecodedDataChannelFrame(header: {
  streamType: 'video' | 'audio';
  codec: string;
  payloadFormat?: 'annexb' | 'avcc' | 'raw' | 'unknown';
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
      payloadFormat: header.payloadFormat || 'unknown',
      timestampUs: header.timestampUs,
      sequence: header.sequence,
      keyframe: header.keyframe,
      config: header.config
    }, payload);
    for (const message of messages) {
      downstreamDataChannel.send(message);
    }
    if (header.streamType === 'video') {
      diagnostics.incrementCounter('encodedFramesForwarded');
    }
    diagnostics.incrementCounter('dataChannelFramesForwarded');
  } catch (error) {
    markRelayUnsupported(errorToMessage(error));
  }
}

function clearRelayHelloAckTimer(): void {
  if (relayHelloAckTimer !== null) {
    window.clearTimeout(relayHelloAckTimer);
    relayHelloAckTimer = null;
  }
}

async function refreshRooms(manual: boolean): Promise<void> {
  try {
    const rooms = await fetchPublicRooms();
    roomList.replaceChildren(...rooms.map((room) => {
      const item = document.createElement('button');
      item.className = 'room-item';
      item.type = 'button';
      item.disabled = Boolean(session);
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
    roomListStatus.textContent = '大厅刷新失败。';
    if (manual) {
      setError(errorToMessage(error));
    }
  }
}

function renderCapability(report: CapabilityReport): void {
  diagnostics.update({ capability: report, status: report.ok ? '等待加入' : '能力不足' });
}

function renderDiagnostics(): void {
  const snapshot = diagnostics.getSnapshot();
  applyVideoManifestDisplaySize(snapshot.mediaManifest);
  const now = Date.now();
  if (
    snapshot.mediaManifest &&
    snapshot.webDecodedVideoFrames === 0 &&
    snapshot.dataChannelFramesReceived === 0 &&
    now - lastConsoleDiagnosticsAt > 1000
  ) {
    lastConsoleDiagnosticsAt = now;
    console.info(`[vds-web][diagnostics] ${toConsoleJson(snapshot)}`);
  }
  diagnosticsOutput.value = diagnostics.format();
  viewerRoomId.textContent = snapshot.roomId || '-';
  chainPositionText.textContent = Number.isFinite(snapshot.chainPosition) ? String(snapshot.chainPosition) : '-';
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

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement === playerShell) {
      await document.exitFullscreen();
      return;
    }
    await playerShell.requestFullscreen();
  } catch (error) {
    setError(errorToMessage(error));
  }
}

function syncFullscreenButton(): void {
  const active = document.fullscreenElement === playerShell;
  fullscreenButton.setAttribute('aria-label', active ? '退出全屏' : '全屏');
  fullscreenButton.setAttribute('title', active ? '退出全屏' : '全屏');
}

function setPlayerVolume(value: number): void {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 100));
  playerVolumeInput.value = String(normalized);
  playerVolumeValue.textContent = `${normalized}%`;
  dataChannelAudioPlayer.setVolume(normalized / 100);
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
  dataChannelAudioPlayer.setDelayMs(delayMs);
  diagnostics.update({ relayProtocolState: `audio-delay-${delayMs}ms` });
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

function isEncodedDataChannelOffer(sdp: string): boolean {
  return sdp.includes('m=application') && sdp.includes('webrtc-datachannel');
}

function getManifestCompatibilityFailure(mediaManifest: unknown): string {
  if (!mediaManifest || typeof mediaManifest !== 'object') {
    return 'host-media-manifest-missing';
  }
  const manifest = mediaManifest as {
    protocol?: unknown;
    video?: { codec?: unknown };
    audio?: { codec?: unknown };
  };
  if (manifest.protocol !== ENCODED_MEDIA_PROTOCOL) {
    return 'host-media-manifest-protocol-unsupported';
  }
  const videoCodec = String(manifest.video?.codec || '').toLowerCase();
  if (videoCodec !== 'h264' && videoCodec !== 'h265' && videoCodec !== 'hevc') {
    return `web-video-codec-unsupported:${videoCodec || 'unknown'}`;
  }
  const audioCodec = String(manifest.audio?.codec || 'opus').toLowerCase();
  if (audioCodec !== 'opus' && audioCodec !== 'aac') {
    return `web-audio-codec-unsupported:${audioCodec || 'unknown'}`;
  }
  return '';
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
  const codec = String(manifest?.video?.codec || '').toLowerCase();
  return codec === 'hevc' ? 'h265' : codec;
}

function applyVideoManifestDisplaySize(mediaManifest: unknown): void {
  if (!mediaManifest || typeof mediaManifest !== 'object') {
    return;
  }
  const video = (mediaManifest as { video?: { width?: unknown; height?: unknown } }).video;
  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);
  dataChannelVideoPlayer.setExpectedDisplaySize(width, height);
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
  const value = `web-${crypto.randomUUID()}`;
  sessionStorage.setItem('vds-web-client-id', value);
  return value;
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
