// 生成客户端ID
const DEFAULT_SERVER_URL = 'https://boshan.s.3q.hair';
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.linphone.org:3478' },
  { urls: 'stun:stun.freeswitch.org:3478' },
  { urls: 'stun:stun.pjsip.org:3478' },
  { urls: 'stun:stun.sip.us:3478' },
  { urls: 'stun:stun.ippi.fr:3478' },
  { urls: 'stun:stun.easyvoip.com:3478' },
  { urls: 'stun:stun.ekiga.net:3478' }
];

const runtimeConfig = getRuntimeConfig();
const serverBaseUrl = runtimeConfig.serverUrl;
const wsBaseUrl = toWebSocketUrl(serverBaseUrl);
const clientId = runtimeConfig.clientId || ('client_' + Math.random().toString(36).substring(2, 11));

// WebSocket连接
let ws = null;
let wsConnected = false;
let wsConnectPromise = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let pendingReconnect = false;
let resumeOnNextConnect = false;
const pendingMessages = [];
const pendingRemoteCandidates = new Map();
let wsManualClose = false; // 标记是否为手动关闭

// Session state
let isHost = false;
let sessionRole = null;
let currentRoomId = null;
let localStream = null;
let myChainPosition = -1; // 观众在链中的位置
let hostId = null; // Host的clientId

// 音频捕获全局变量（用于资源清理）
let audioContext = null;
let audioDataHandler = null;
let audioMediaStreamDest = null;
let audioQueue = [];
let isAudioPlaying = false;
let audioTimer = null;

// 画质设置
let qualitySettings = {
  width: 1920,
  height: 1080,
  bitrate: 10000, // kbps
  frameRate: 60,
  codecPreference: 'none' // 'none' | 'h264' | 'av1'
};

const AUDIO_SYNC_PROFILES = {
  default: {
    name: 'default',
    targetLeadMs: 90,
    scheduleAheadMs: 120,
    checkIntervalMs: 750,
    toleranceMs: 20
  },
  av1: {
    name: 'av1',
    targetLeadMs: 180,
    scheduleAheadMs: 180,
    checkIntervalMs: 500,
    toleranceMs: 15
  }
};

function getAudioSyncProfile() {
  return qualitySettings.codecPreference === 'av1'
    ? AUDIO_SYNC_PROFILES.av1
    : AUDIO_SYNC_PROFILES.default;
}

function getAudioChunkDurationSeconds(audioData) {
  if (!audioData || !audioData.buffer || !audioData.channels || !audioData.sampleRate) {
    return 0;
  }

  return audioData.buffer.length / audioData.channels / audioData.sampleRate;
}

// WebRTC连接管理
// Host侧: viewerId -> RTCPeerConnection
// Viewer侧: 最多2个连接 - 前一个(prev)和下一个(next)
const peerConnections = new Map();
let relayPc = null;
let relayStream = null;
let viewerReadySent = false;
let videoStarted = false;
let upstreamConnected = false;
let runtimeConnectionConfigPromise = null;
let updateStatusUnsubscribe = null;
let updateLogUnsubscribe = null;
let updateCheckStarted = false;
let updateModalAutoHideTimer = null;
let updateLogPath = '';
const updateLogEntries = [];
const UPDATE_LOG_ENTRY_LIMIT = 40;
let upstreamPeerId = null;
const peerConnectionMeta = new Map();
const peerReconnectState = new Map();
const PEER_RECONNECT_BASE_DELAY_MS = 1000;
const PEER_RECONNECT_MAX_DELAY_MS = 8000;
const PEER_CONNECT_TIMEOUT_MS = 15000;
const PEER_DISCONNECT_GRACE_MS = 4000;
const INITIAL_ICE_GATHER_MIN_WAIT_MS = 1500;
const INITIAL_ICE_GATHER_MAX_WAIT_MS = 4500;
const INITIAL_ICE_CANDIDATE_TARGET = 2;
const ICE_RESTART_LIMIT = 1;
/* Legacy declarations kept below for context.
let relayPc = null; // 转发给下一个观众的PC
let relayStream = null; // 收到的视频流，用于转发
let viewerReadySent = false; // 防止重复发送viewer-ready
let videoStarted = false; // 防止重复播放
let upstreamConnected = false; // 是否已连接到上游（主机或上一个观众）

// ICE服务器配置 - STUN服务器
const iceServers = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.linphone.org:3478' },
  { urls: 'stun:stun.freeswitch.org:3478' },
  { urls: 'stun:stun.pjsip.org:3478' },
  { urls: 'stun:stun.sip.us:3478' },
  { urls: 'stun:stun.aa.net.uk:3478' },
  { urls: 'stun:stun.acrobits.cz:3478' },
  { urls: 'stun:stun.actionvoip.com:3478' },
  { urls: 'stun:stun.annatel.net:3478' },
  { urls: 'stun:stun.antisip.com:3478' },
  { urls: 'stun:stun.cablenet-as.net:3478' },
  { urls: 'stun:stun.cheapvoip.com:3478' },
  { urls: 'stun:stun.commpeak.com:3478' },
  { urls: 'stun:stun.cope.es:3478' },
  { urls: 'stun:stun.dcalling.de:3478' },
  { urls: 'stun:stun.dus.net:3478' },
  { urls: 'stun:stun.easyvoip.com:3478' },
  { urls: 'stun:stun.epygi.com:3478' },
  { urls: 'stun:stun.freecall.com:3478' },
  { urls: 'stun:stun.freevoipdeal.com:3478' },
  { urls: 'stun:stun.halonet.pl:3478' },
  { urls: 'stun:stun.hoiio.com:3478' },
  { urls: 'stun:stun.infra.net:3478' },
  { urls: 'stun:stun.internetcalls.com:3478' },
  { urls: 'stun:stun.intervoip.com:3478' },
  { urls: 'stun:stun.ipfire.org:3478' },
  { urls: 'stun:stun.ippi.fr:3478' },
  { urls: 'stun:stun.it1.hr:3478' },
  { urls: 'stun:stun.jumblo.com:3478' },
  { urls: 'stun:stun.justvoip.com:3478' },
  { urls: 'stun:stun.liveo.fr:3478' },
  { urls: 'stun:stun.lowratevoip.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.myvoiptraffic.com:3478' },
  { urls: 'stun:stun.mywatson.it:3478' },
  { urls: 'stun:stun.netappel.com:3478' },
  { urls: 'stun:stun.netgsm.com.tr:3478' },
  { urls: 'stun:stun.nfon.net:3478' },
  { urls: 'stun:stun.nonoh.net:3478' },
  { urls: 'stun:stun.ooma.com:3478' },
  { urls: 'stun:stun.poivy.com:3478' },
  { urls: 'stun:stun.powervoip.com:3478' },
  { urls: 'stun:stun.ppdi.com:3478' },
  { urls: 'stun:stun.rockenstein.de:3478' },
  { urls: 'stun:stun.rolmail.net:3478' },
  { urls: 'stun:stun.rynga.com:3478' },
  { urls: 'stun:stun.sipdiscount.com:3478' },
  { urls: 'stun:stun.siplogin.de:3478' },
  { urls: 'stun:stun.sipnet.net:3478' },
  { urls: 'stun:stun.sipnet.ru:3478' },
  { urls: 'stun:stun.siptraffic.com:3478' },
  { urls: 'stun:stun.smartvoip.com:3478' },
  { urls: 'stun:stun.smsdiscount.com:3478' },
  { urls: 'stun:stun.solcon.nl:3478' },
  { urls: 'stun:stun.solnet.ch:3478' },
  { urls: 'stun:stun.sonetel.com:3478' },
  { urls: 'stun:stun.sonetel.net:3478' },
  { urls: 'stun:stun.srce.hr:3478' },
  { urls: 'stun:stun.tel.lu:3478' },
  { urls: 'stun:stun.telbo.com:3478' },
  { urls: 'stun:stun.t-online.de:3478' },
  { urls: 'stun:stun.twt.it:3478' },
  { urls: 'stun:stun.uls.co.za:3478' },
  { urls: 'stun:stun.usfamily.net:3478' },
  { urls: 'stun:stun.vo.lu:3478' },
  { urls: 'stun:stun.voicetrading.com:3478' },
  { urls: 'stun:stun.voip.aebc.com:3478' },
  { urls: 'stun:stun.voip.blackberry.com:3478' },
  { urls: 'stun:stun.voip.eutelia.it:3478' },
  { urls: 'stun:stun.voipblast.com:3478' },
  { urls: 'stun:stun.voipbuster.com:3478' },
  { urls: 'stun:stun.voipbusterpro.com:3478' },
  { urls: 'stun:stun.voipcheap.com:3478' },
  { urls: 'stun:stun.voipfibre.com:3478' },
  { urls: 'stun:stun.voipgain.com:3478' },
  { urls: 'stun:stun.voipinfocenter.com:3478' },
  { urls: 'stun:stun.voipplanet.nl:3478' },
  { urls: 'stun:stun.voippro.com:3478' },
  { urls: 'stun:stun.voipraider.com:3478' },
  { urls: 'stun:stun.voipstunt.com:3478' },
  { urls: 'stun:stun.voipwise.com:3478' },
  { urls: 'stun:stun.voipzoom.com:3478' },
  { urls: 'stun:stun.voys.nl:3478' },
  { urls: 'stun:stun.voztele.com:3478' },
  { urls: 'stun:stun.webcalldirect.com:3478' },
  { urls: 'stun:stun.zadarma.com:3478' }
];

*/
const iceServers = sanitizeIceServers(DEFAULT_ICE_SERVERS);

const config = {
  iceServers: iceServers,
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle'
};

function getRuntimeConfig() {
  if (window.isElectron && window.electronAPI && typeof window.electronAPI.getRuntimeConfig === 'function') {
    const electronConfig = window.electronAPI.getRuntimeConfig() || {};
    return {
      clientId: electronConfig.clientId || null,
      serverUrl: normalizeBaseUrl(electronConfig.serverUrl || DEFAULT_SERVER_URL),
      disconnectGraceMs: Number(electronConfig.disconnectGraceMs || 30000)
    };
  }

  return {
    clientId: null,
    serverUrl: normalizeBaseUrl(window.location.origin || DEFAULT_SERVER_URL),
    disconnectGraceMs: 30000
  };
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

function normalizeIceUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

  // `?transport=` is valid for turn/turns URLs but not for stun URLs.
  if (value.startsWith('stun:')) {
    return value.replace(/\?.*$/, '');
  }

  return value;
}

function sanitizeIceServers(servers) {
  if (!Array.isArray(servers)) {
    return [];
  }

  return servers
    .map((server) => {
      if (!server || !server.urls) {
        return null;
      }

      const urls = Array.isArray(server.urls)
        ? server.urls.map(normalizeIceUrl).filter(Boolean)
        : normalizeIceUrl(server.urls);

      if ((Array.isArray(urls) && urls.length === 0) || (!Array.isArray(urls) && !urls)) {
        return null;
      }

      return {
        ...server,
        urls
      };
    })
    .filter(Boolean);
}

function toWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function ensureRuntimeConnectionConfig() {
  if (runtimeConnectionConfigPromise) {
    return runtimeConnectionConfigPromise;
  }

  runtimeConnectionConfigPromise = (async () => {
    try {
      const response = await fetch(`${serverBaseUrl}/api/config`, {
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        config.iceServers = sanitizeIceServers(data.iceServers);
      }
    } catch (error) {
      console.log('Using bundled ICE configuration:', error.message);
    }

    return config;
  })();

  return runtimeConnectionConfigPromise;
}

function queueRemoteCandidate(peerId, candidate) {
  if (!pendingRemoteCandidates.has(peerId)) {
    pendingRemoteCandidates.set(peerId, []);
  }
  pendingRemoteCandidates.get(peerId).push(candidate);
}

async function flushRemoteCandidates(peerId, pc) {
  const queued = pendingRemoteCandidates.get(peerId);
  if (!queued || !queued.length) {
    return;
  }

  pendingRemoteCandidates.delete(peerId);

  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Failed to apply queued ICE candidate:', error);
    }
  }
}

function clearPeerReconnect(peerId) {
  const state = peerReconnectState.get(peerId);
  if (state && state.timerId) {
    clearTimeout(state.timerId);
  }
  peerReconnectState.delete(peerId);
}

function clearAllPeerReconnects() {
  peerReconnectState.forEach((state) => {
    if (state && state.timerId) {
      clearTimeout(state.timerId);
    }
  });
  peerReconnectState.clear();
}

function clearPeerConnectionTimeout(peerId) {
  const meta = peerConnectionMeta.get(peerId);
  if (meta && meta.connectTimeoutId) {
    clearTimeout(meta.connectTimeoutId);
    meta.connectTimeoutId = null;
  }
}

function clearPeerDisconnectTimer(peerId) {
  const meta = peerConnectionMeta.get(peerId);
  if (meta && meta.disconnectTimerId) {
    clearTimeout(meta.disconnectTimerId);
    meta.disconnectTimerId = null;
  }
}

function armPeerConnectionTimeout(peerId, pc, meta, message = '连接超时，正在重试...') {
  clearPeerConnectionTimeout(peerId);
  if (!meta || !meta.isInitiator) {
    return;
  }

  meta.connectTimeoutId = setTimeout(() => {
    if (peerConnections.get(peerId) !== pc) {
      return;
    }

    if (!meta.restartInProgress && meta.hasConnected) {
      return;
    }

    console.warn('Peer connection timed out:', peerId);
    handlePeerConnectionFailure(peerId, meta, message);
  }, PEER_CONNECT_TIMEOUT_MS);
}

function describeIceCandidate(candidate) {
  const candidateLine = typeof candidate === 'string' ? candidate : candidate && candidate.candidate;
  if (!candidateLine) {
    return {
      type: 'unknown',
      protocol: 'unknown'
    };
  }

  const typeMatch = candidateLine.match(/\btyp\s+([a-z0-9]+)/i);
  const protocolMatch = candidateLine.match(/^candidate:\S+\s+\d+\s+(\S+)/i);

  return {
    type: typeMatch ? typeMatch[1].toLowerCase() : 'unknown',
    protocol: protocolMatch ? protocolMatch[1].toLowerCase() : 'unknown'
  };
}

function prepareLocalDescription(meta) {
  if (!meta) {
    return;
  }

  meta.localCandidateCount = 0;
  meta.localCandidateTypes.clear();
  meta.selectedCandidatePairLogged = false;
}

function waitForLocalIceWarmup(pc, meta, peerId, label) {
  if (!pc || !meta) {
    return Promise.resolve();
  }

  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let intervalId = null;

    const finish = (reason) => {
      if (settled) {
        return;
      }

      settled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }

      pc.removeEventListener('icecandidate', onIceCandidate);
      pc.removeEventListener('icegatheringstatechange', onGatheringStateChange);

      const candidateTypes = Array.from(meta.localCandidateTypes);
      console.log(
        `ICE warmup [${label}] ${peerId}: ${meta.localCandidateCount} candidates, types=${
          candidateTypes.join(',') || 'none'
        }, reason=${reason}, state=${pc.iceGatheringState}`
      );
      resolve();
    };

    const maybeFinish = () => {
      if (peerConnections.get(peerId) !== pc || pc.signalingState === 'closed') {
        finish('aborted');
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const reachedMinWait = elapsedMs >= INITIAL_ICE_GATHER_MIN_WAIT_MS;
      const enoughCandidates = meta.localCandidateCount >= INITIAL_ICE_CANDIDATE_TARGET;
      const gatheringComplete = pc.iceGatheringState === 'complete';

      if (reachedMinWait && (enoughCandidates || gatheringComplete)) {
        finish(enoughCandidates ? 'candidate-target' : 'gather-complete');
        return;
      }

      if (elapsedMs >= INITIAL_ICE_GATHER_MAX_WAIT_MS) {
        finish(gatheringComplete ? 'gather-complete' : 'timeout');
      }
    };

    const onIceCandidate = () => {
      maybeFinish();
    };

    const onGatheringStateChange = () => {
      maybeFinish();
    };

    intervalId = setInterval(maybeFinish, 100);
    pc.addEventListener('icecandidate', onIceCandidate);
    pc.addEventListener('icegatheringstatechange', onGatheringStateChange);
    maybeFinish();
  });
}

function assertActivePeerConnection(peerId, pc) {
  if (peerConnections.get(peerId) !== pc || pc.signalingState === 'closed') {
    throw new Error('peer-connection-replaced');
  }
}

function getPeerStatsLabel(peerId, kind) {
  if (kind === 'host-viewer') {
    return `Host->Viewer(${peerId.substring(0, 8)})`;
  }

  if (kind === 'relay-viewer') {
    return `Viewer->NextViewer(${peerId.substring(0, 8)})`;
  }

  if (peerId === upstreamPeerId) {
    return 'Viewer->Upstream';
  }

  return null;
}

async function logSelectedCandidatePair(pc, label) {
  if (!pc || pc.connectionState !== 'connected') {
    return;
  }

  try {
    const stats = await pc.getStats();
    let selectedPair = null;

    stats.forEach((report) => {
      if (!selectedPair && report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPair = stats.get(report.selectedCandidatePairId) || null;
      }
    });

    if (!selectedPair) {
      stats.forEach((report) => {
        if (!selectedPair && report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) {
          selectedPair = report;
        }
      });
    }

    if (!selectedPair) {
      console.log(`[ICE Pair] ${label}: no selected pair available yet`);
      return;
    }

    const localCandidate = stats.get(selectedPair.localCandidateId);
    const remoteCandidate = stats.get(selectedPair.remoteCandidateId);
    const localSummary = localCandidate ? `${localCandidate.candidateType}/${localCandidate.protocol || 'unknown'}` : 'unknown';
    const remoteSummary = remoteCandidate ? `${remoteCandidate.candidateType}/${remoteCandidate.protocol || 'unknown'}` : 'unknown';
    const rttMs = selectedPair.currentRoundTripTime ? Math.round(selectedPair.currentRoundTripTime * 1000) : 0;

    console.log(`[ICE Pair] ${label}: local=${localSummary} remote=${remoteSummary} rtt=${rttMs}ms`);
  } catch (error) {
    console.log('Failed to inspect selected ICE pair:', error.message);
  }
}

function closePeerConnection(peerId, options = {}) {
  const { clearRetryState = false } = options;
  const pc = peerConnections.get(peerId);
  if (pc) {
    peerConnections.delete(peerId);
    if (relayPc === pc) {
      relayPc = null;
    }

    pc.onicecandidate = null;
    pc.onicecandidateerror = null;
    pc.onicegatheringstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;

    try {
      pc.close();
    } catch (_error) {
      // Ignore close errors from already-closed peer connections.
    }
  }

  clearPeerConnectionTimeout(peerId);
  clearPeerDisconnectTimer(peerId);
  peerConnectionMeta.delete(peerId);
  pendingRemoteCandidates.delete(peerId);

  if (clearRetryState) {
    clearPeerReconnect(peerId);
  }
}

function clearAllPeerConnections(options = {}) {
  const peerIds = Array.from(peerConnections.keys());
  peerIds.forEach((peerId) => closePeerConnection(peerId, options));

  if (options.clearRetryState) {
    clearAllPeerReconnects();
  }
}

function setViewerConnectionState(message) {
  elements.waitingMessage.classList.remove('hidden');
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.classList.remove('connected');
}

function resetViewerMediaPipeline(message = '等待重新连接...') {
  upstreamConnected = false;
  viewerReadySent = false;
  videoStarted = false;
  relayStream = null;
  relayPc = null;
  clearAllPeerConnections();
  elements.remoteVideo.srcObject = null;
  setViewerConnectionState(message);
}

function shouldReconnectPeer(kind) {
  if (!currentRoomId) {
    return false;
  }

  if (kind === 'host-viewer') {
    return sessionRole === 'host' && Boolean(localStream);
  }

  if (kind === 'relay-viewer') {
    return sessionRole === 'viewer' && Boolean(relayStream);
  }

  return false;
}

function schedulePeerReconnect(peerId, kind) {
  if (!shouldReconnectPeer(kind)) {
    return;
  }

  const existingState = peerReconnectState.get(peerId);
  if (existingState && existingState.timerId) {
    return;
  }

  const attempts = existingState ? existingState.attempts : 0;
  const delay = Math.min(
    PEER_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts),
    PEER_RECONNECT_MAX_DELAY_MS
  );

  console.log(`Scheduling peer reconnect for ${peerId} in ${delay}ms`);

  const timerId = setTimeout(async () => {
    const state = peerReconnectState.get(peerId);
    peerReconnectState.set(peerId, {
      attempts: state ? state.attempts : attempts + 1,
      timerId: null
    });

    if (!shouldReconnectPeer(kind)) {
      clearPeerReconnect(peerId);
      return;
    }

    try {
      if (kind === 'host-viewer') {
        await createOffer(peerId, { force: true });
      } else if (kind === 'relay-viewer') {
        await createOfferToNextViewer(peerId, { force: true });
      }
    } catch (error) {
      console.error('Peer reconnect attempt failed:', peerId, error);
    }
  }, delay);

  peerReconnectState.set(peerId, {
    attempts: attempts + 1,
    timerId
  });
}

// DOM元素
const elements = {
  modeSelect: document.getElementById('mode-select'),
  hostPanel: document.getElementById('host-panel'),
  viewerPanel: document.getElementById('viewer-panel'),
  btnHost: document.getElementById('btn-host'),
  btnViewer: document.getElementById('btn-viewer'),
  btnStartShare: document.getElementById('btn-start-share'),
  btnStopShare: document.getElementById('btn-stop-share'),
  btnJoin: document.getElementById('btn-join'),
  btnLeave: document.getElementById('btn-leave'),
  btnBack: document.getElementById('btn-back'),
  btnBackViewer: document.getElementById('btn-back-viewer'),
  btnCopyRoom: document.getElementById('btn-copy-room'),
  roomInfo: document.getElementById('room-info'),
  roomIdDisplay: document.getElementById('room-id-display'),
  roomIdInput: document.getElementById('room-id-input'),
  viewerCount: document.getElementById('viewer-count'),
  viewerRoomId: document.getElementById('viewer-room-id'),
  viewerStatus: document.getElementById('viewer-status'),
  connectionStatus: document.getElementById('connection-status'),
  chainPosition: document.getElementById('chain-position'),
  hostStatus: document.getElementById('host-status'),
  localVideo: document.getElementById('local-video'),
  remoteVideo: document.getElementById('remote-video'),
  remoteVideoContainer: document.getElementById('remote-video-container'),
  waitingMessage: document.getElementById('waiting-message'),
  errorToast: document.getElementById('error-toast'),
  joinForm: document.getElementById('join-form'),
  sourceModal: document.getElementById('source-modal'),
  sourceList: document.getElementById('source-list'),
  btnConfirmSource: document.getElementById('btn-confirm-source'),
  btnCancelSource: document.getElementById('btn-cancel-source'),
  btnRefreshSources: document.getElementById('btn-refresh-sources'),
  audioModal: document.getElementById('audio-modal'),
  audioProcessList: document.getElementById('audio-process-list'),
  btnConfirmAudio: document.getElementById('btn-confirm-audio'),
  btnCancelAudio: document.getElementById('btn-cancel-audio'),
  // 画质设置弹窗
  qualityModal: document.getElementById('quality-modal'),
  qualityResolution: document.getElementById('quality-resolution'),
  qualityBitrate: document.getElementById('quality-bitrate'),
  qualityFramerate: document.getElementById('quality-framerate'),
  qualityCodec: document.getElementById('quality-codec'),
  btnConfirmQuality: document.getElementById('btn-confirm-quality'),
  btnCancelQuality: document.getElementById('btn-cancel-quality'),
  // 更新进度弹窗
  updateModal: document.getElementById('update-modal'),
  updateTitle: document.getElementById('update-title'),
  updateStep: document.getElementById('update-step'),
  updateDetail: document.getElementById('update-detail'),
  updateProgressContainer: document.getElementById('update-progress-container'),
  updateProgress: document.getElementById('update-progress'),
  updatePercent: document.getElementById('update-percent'),
  updateSpeed: document.getElementById('update-speed'),
  updateTransferred: document.getElementById('update-transferred'),
  updateTime: document.getElementById('update-time'),
  updateActions: document.getElementById('update-actions'),
  btnCloseUpdate: document.getElementById('btn-close-update'),
  btnInstallUpdate: document.getElementById('btn-install-update'),
  // 标题栏按钮
  btnMinimize: document.getElementById('btn-minimize'),
  btnMaximize: document.getElementById('btn-maximize'),
  btnClose: document.getElementById('btn-close'),
  // 关闭确认弹窗
  closeModal: document.getElementById('close-modal'),
  btnMinimizeToTray: document.getElementById('btn-minimize-to-tray'),
  btnExitApp: document.getElementById('btn-exit-app'),
  // 标题栏元素
  titleBar: document.querySelector('.title-bar')
};

// 根据运行环境显示/隐藏标题栏
if (!window.isElectron) {
  elements.titleBar.style.display = 'none';
}

// 事件绑定
elements.btnHost.addEventListener('click', () => showHostPanel());
elements.btnViewer.addEventListener('click', () => showViewerPanel());
elements.btnStartShare.addEventListener('click', startScreenShare);
elements.btnStopShare.addEventListener('click', stopScreenShare);
elements.btnJoin.addEventListener('click', joinRoom);
elements.btnLeave.addEventListener('click', leaveRoom);
elements.btnBack.addEventListener('click', goBack);
elements.btnBackViewer.addEventListener('click', goBackViewer);
elements.btnCopyRoom.addEventListener('click', copyRoomId);

// 屏幕源选择弹窗事件
elements.btnConfirmSource.addEventListener('click', confirmSourceAndShare);
elements.btnCancelSource.addEventListener('click', cancelSourceSelection);
elements.btnRefreshSources.addEventListener('click', refreshSources);

// 音频进程选择弹窗事件
elements.btnConfirmAudio.addEventListener('click', confirmAudioProcess);
elements.btnCancelAudio.addEventListener('click', skipAudioCapture);

// 画质设置弹窗事件
elements.btnConfirmQuality.addEventListener('click', () => {
  // 获取画质设置
  const resolution = elements.qualityResolution.value.split('x');
  qualitySettings.width = parseInt(resolution[0]);
  qualitySettings.height = parseInt(resolution[1]);
  qualitySettings.bitrate = parseInt(elements.qualityBitrate.value);
  qualitySettings.frameRate = parseInt(elements.qualityFramerate.value);
  qualitySettings.codecPreference = elements.qualityCodec.value;

  // 隐藏画质设置弹窗，显示源选择
  elements.qualityModal.classList.add('hidden');
  showSourceSelection();
});

elements.btnCancelQuality.addEventListener('click', () => {
  elements.qualityModal.classList.add('hidden');
  // 取消则返回模式选择页面
  elements.hostPanel.classList.add('hidden');
  elements.modeSelect.classList.remove('hidden');
});

// 标题栏按钮事件
elements.btnCloseUpdate.addEventListener('click', hideUpdateModal);
elements.btnInstallUpdate.addEventListener('click', () => {
  hideUpdateModal();
  if (window.electronAPI && window.electronAPI.quitAndInstall) {
    window.electronAPI.quitAndInstall();
  }
});

elements.btnMinimize.addEventListener('click', () => {
  window.electronAPI.minimize();
});

elements.btnMaximize.addEventListener('click', async () => {
  window.electronAPI.maximize();
  // 切换最大化图标
  const isMax = await window.electronAPI.isMaximized();
  updateMaximizeButton(isMax);
});

elements.btnClose.addEventListener('click', () => {
  elements.closeModal.classList.remove('hidden');
});

// 关闭确认弹窗事件
elements.btnMinimizeToTray.addEventListener('click', () => {
  elements.closeModal.classList.add('hidden');
  window.electronAPI.minimizeToTray();
});

elements.btnExitApp.addEventListener('click', () => {
  elements.closeModal.classList.add('hidden');
  // 关闭WebRTC连接
  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();
  if (ws) ws.close();
  window.electronAPI.close();
});

// 更新最大化按钮图标
function updateMaximizeButton(isMaximized) {
  const btn = elements.btnMaximize;
  if (isMaximized) {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="3" y="0" width="9" height="9" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="0" y="3" width="9" height="9" stroke="currentColor" stroke-width="1.5" fill="rgba(255,255,255,0.1)"/></svg>';
  } else {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
  }
}

// 监听窗口最大化状态变化（双击标题栏等情况）
if (window.electronAPI && window.electronAPI.onMaximizedChange) {
  window.electronAPI.onMaximizedChange((isMaximized) => {
    updateMaximizeButton(isMaximized);
  });
}

// 页面导航
initializeStartupTasks().catch((error) => {
  console.log('Startup initialization failed:', error.message);
});

async function showHostPanel() {
  elements.modeSelect.classList.add('hidden');
  elements.hostPanel.classList.remove('hidden');
  isHost = true;
  elements.hostStatus.textContent = '正在连接...';
  elements.hostStatus.classList.add('waiting');
  try {
    await ensureRuntimeConnectionConfig();
    await waitForWsConnected();
  } catch (_error) {
    showError('无法连接到信令服务器');
  }
}

async function showViewerPanel() {
  elements.modeSelect.classList.add('hidden');
  elements.viewerPanel.classList.remove('hidden');
  isHost = false;
  elements.connectionStatus.textContent = '正在连接...';
  try {
    await ensureRuntimeConnectionConfig();
    await waitForWsConnected();
  } catch (_error) {
    showError('无法连接到信令服务器');
  }
}

function goBack() {
  stopScreenShare();
  disconnectWebSocket();
  elements.hostPanel.classList.add('hidden');
  elements.modeSelect.classList.remove('hidden');
}

function goBackViewer() {
  leaveRoom();
  elements.viewerPanel.classList.add('hidden');
  elements.modeSelect.classList.remove('hidden');
}

// WebSocket连接
function legacyConnectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  // 重置重连状态
  wsManualClose = false;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    wsConnected = true;
    wsReconnectAttempts = 0; // 重置重连计数

    // 初始化版本号（仅在 Electron 环境中）
    if (window.electronAPI && window.electronAPI.getAppVersion) {
      await initVersion();
    }

    // 检查更新（仅在 Electron 环境中）
    if (window.electronAPI && window.electronAPI.checkForUpdates) {
      checkForUpdates();
    }
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    await handleMessage(data);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    wsConnected = false;

    // 如果是手动关闭，不重连
    if (wsManualClose) {
      console.log('Manual close, skipping reconnect');
      return;
    }

    // 指数退避重连：1s, 2s, 4s, 8s, 16s, 最大 30s
    const maxDelay = 30000;
    const baseDelay = 1000;
    const delay = Math.min(baseDelay * Math.pow(2, wsReconnectAttempts), maxDelay);

    console.log(`Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts + 1})...`);

    // 显示重连状态
    if (isHost && elements.hostStatus) {
      elements.hostStatus.textContent = '正在重连...';
      elements.hostStatus.classList.add('waiting');
    } else if (!isHost && elements.connectionStatus) {
      elements.connectionStatus.textContent = '正在重连...';
    }

    wsReconnectTimer = setTimeout(() => {
      wsReconnectAttempts++;
      connectWebSocket();
    }, delay);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showError('连接失败，请刷新页面重试');
  };
}

function legacyDisconnectWebSocket() {
  // 标记为手动关闭，不再重连
  wsManualClose = true;

  // 清除重连定时器
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectAttempts = 0;

  if (ws) {
    ws.close();
    ws = null;
  }
  wsConnected = false;
}

// 等待WebSocket连接
function legacyWaitForWsConnected() {
  return new Promise((resolve) => {
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    // 等待连接
    const checkInterval = setInterval(() => {
      if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);

    // 超时5秒后仍然继续
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, 5000);
  });
}

// 发送消息
function legacySendMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (wsConnectPromise) {
    return wsConnectPromise;
  }

  wsManualClose = false;
  pendingReconnect = false;

  wsConnectPromise = new Promise((resolve, reject) => {
    let settled = false;

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    ws = new WebSocket(wsBaseUrl);

    ws.onopen = async () => {
      console.log('WebSocket connected');
      wsConnected = true;
      wsReconnectAttempts = 0;
      wsConnectPromise = null;

      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
      if (resumeOnNextConnect && currentRoomId && sessionRole) {
        sendRawMessage({
          type: 'resume-session',
          roomId: currentRoomId,
          clientId: clientId,
          role: sessionRole,
          needsMediaReconnect: sessionRole === 'viewer' && !upstreamConnected
        });
        resumeOnNextConnect = false;
      }

      flushPendingMessages();
      settle(resolve);
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      await handleMessage(data);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      wsConnected = false;
      wsConnectPromise = null;

      if (wsManualClose) {
        console.log('Manual close, skipping reconnect');
        return;
      }

      resumeOnNextConnect = Boolean(currentRoomId && sessionRole);
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);

      if (!settled) {
        wsConnectPromise = null;
        settle(reject, new Error('websocket-connect-failed'));
      }
    };
  });

  return wsConnectPromise;
}

function scheduleReconnect() {
  if (pendingReconnect) {
    return;
  }

  pendingReconnect = true;
  const maxDelay = 30000;
  const baseDelay = 1000;
  const delay = Math.min(baseDelay * Math.pow(2, wsReconnectAttempts), maxDelay);

  console.log(`Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts + 1})...`);

  if (isHost && elements.hostStatus) {
    elements.hostStatus.textContent = '正在重连...';
    elements.hostStatus.classList.add('waiting');
  } else if (!isHost && elements.connectionStatus) {
    elements.connectionStatus.textContent = '正在重连...';
  }

  wsReconnectTimer = setTimeout(() => {
    pendingReconnect = false;
    wsReconnectAttempts++;
    connectWebSocket().catch(() => {});
  }, delay);
}

function disconnectWebSocket() {
  wsManualClose = true;
  pendingReconnect = false;
  resumeOnNextConnect = false;
  wsConnectPromise = null;

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectAttempts = 0;

  if (ws) {
    ws.close();
    ws = null;
  }

  wsConnected = false;
}

async function waitForWsConnected(timeoutMs = 10000) {
  if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  await Promise.race([
    connectWebSocket(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('websocket-timeout')), timeoutMs);
    })
  ]);
}

function sendRawMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function flushPendingMessages() {
  while (pendingMessages.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    sendRawMessage(pendingMessages.shift());
  }
}

function sendMessage(data, options = {}) {
  const { queueIfDisconnected = true } = options;

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendRawMessage(data);
    return true;
  }

  if (!queueIfDisconnected) {
    return false;
  }

  pendingMessages.push(data);
  connectWebSocket().catch(() => {});
  return false;
}

function registerUpdateStatusListener() {
  if (updateStatusUnsubscribe || !window.electronAPI || !window.electronAPI.onUpdateStatus) {
    return;
  }

  updateStatusUnsubscribe = window.electronAPI.onUpdateStatus((status) => {
    console.log('Update status:', status);
    applyUpdateStatus(status);
  });
}

async function registerUpdateLogListener() {
  if (!window.electronAPI) {
    return;
  }

  if (typeof window.electronAPI.getUpdateLogSnapshot === 'function') {
    try {
      const snapshot = await window.electronAPI.getUpdateLogSnapshot();
      updateLogPath = snapshot && snapshot.path ? snapshot.path : updateLogPath;

      if (snapshot && Array.isArray(snapshot.entries)) {
        snapshot.entries.forEach(rememberUpdateLogEntry);
      }
    } catch (error) {
      console.log('Unable to load updater log snapshot:', error.message);
    }
  }

  if (updateLogUnsubscribe || !window.electronAPI.onUpdateLog) {
    return;
  }

  updateLogUnsubscribe = window.electronAPI.onUpdateLog((entry) => {
    rememberUpdateLogEntry(entry);
  });
}

function initializeStartupTasks() {
  if (!window.electronAPI) {
    return Promise.resolve();
  }

  return (async () => {
    await registerUpdateLogListener();
    registerUpdateStatusListener();

    if (window.electronAPI.getAppVersion) {
      await initVersion();
    }

    if (!updateCheckStarted && window.electronAPI.checkForUpdates) {
      updateCheckStarted = true;
      await checkForUpdates();
    }
  })();
}

function getUpdateManifestUrl() {
  return `${serverBaseUrl}/updates/latest.yml`;
}

function clearUpdateModalAutoHide() {
  if (updateModalAutoHideTimer) {
    clearTimeout(updateModalAutoHideTimer);
    updateModalAutoHideTimer = null;
  }
}

function scheduleUpdateModalAutoHide(delayMs = 1800) {
  clearUpdateModalAutoHide();
  updateModalAutoHideTimer = setTimeout(() => {
    elements.updateModal.classList.add('hidden');
    updateModalAutoHideTimer = null;
  }, delayMs);
}

function hideUpdateModal() {
  clearUpdateModalAutoHide();
  elements.updateModal.classList.add('hidden');
}

function rememberUpdateLogEntry(entry) {
  if (!entry) {
    return;
  }

  if (entry.path) {
    updateLogPath = entry.path;
  }

  updateLogEntries.push(entry);
  if (updateLogEntries.length > UPDATE_LOG_ENTRY_LIMIT) {
    updateLogEntries.shift();
  }

  const level = entry.level ? String(entry.level).toUpperCase() : 'INFO';
  console.log(`[Updater:${level}]`, entry.message || entry.line || '');
}

function getRecentUpdateLogTail(limit = 5) {
  if (!updateLogEntries.length) {
    return '';
  }

  return updateLogEntries
    .slice(-limit)
    .map((entry) => entry.line || `[${entry.level || 'info'}] ${entry.message || ''}`)
    .join('\n');
}

function buildUpdateDiagnosticDetail(baseDetail, includeTail = false) {
  const sections = [];

  if (baseDetail) {
    sections.push(baseDetail);
  }

  if (updateLogPath) {
    sections.push(`日志文件：${updateLogPath}`);
  }

  if (includeTail) {
    const tail = getRecentUpdateLogTail();
    if (tail) {
      sections.push(`最近更新日志：\n${tail}`);
    }
  }

  return sections.join('\n\n');
}

function renderUpdateModal(options = {}) {
  const {
    title = '正在检查更新',
    step = '',
    detail = '',
    showProgress = true,
    indeterminate = false,
    progressPercent = 0,
    speedText = '0 MB/秒',
    transferredText = '0 / 0 MB',
    timeText = '剩余时间：计算中...',
    showCloseButton = false,
    closeLabel = '关闭',
    showInstallButton = false,
    installLabel = '立即安装'
  } = options;

  const normalizedPercent = Math.max(0, Math.min(100, Number(progressPercent) || 0));

  elements.updateModal.classList.remove('hidden');
  elements.updateTitle.textContent = title;
  elements.updateStep.textContent = step;
  elements.updateDetail.textContent = detail;
  elements.updateProgressContainer.classList.toggle('hidden', !showProgress);
  elements.updateActions.classList.toggle('hidden', !showCloseButton && !showInstallButton);
  elements.btnCloseUpdate.classList.toggle('hidden', !showCloseButton);
  elements.btnCloseUpdate.textContent = closeLabel;
  elements.btnInstallUpdate.classList.toggle('hidden', !showInstallButton);
  elements.btnInstallUpdate.textContent = installLabel;
  elements.updateProgress.classList.toggle('indeterminate', indeterminate);
  elements.updateProgress.style.width = indeterminate ? '35%' : normalizedPercent + '%';
  elements.updatePercent.textContent = indeterminate ? '检查中' : normalizedPercent.toFixed(1) + '%';
  elements.updateSpeed.textContent = speedText;
  elements.updateTransferred.textContent = transferredText;
  elements.updateTime.textContent = timeText;
}

function applyUpdateStatus(status) {
  clearUpdateModalAutoHide();

  const activeVersion = status.currentVersion || currentVersion;
  const targetVersion = status.version || activeVersion;
  const feedUrl = status.feedUrl || getUpdateManifestUrl();

  if (status.status === 'checking') {
    renderUpdateModal({
      title: '正在检查更新',
      step: '第 1 步 / 共 3 步：连接更新源并比较版本',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}`),
      showProgress: true,
      indeterminate: true,
      speedText: '等待响应',
      transferredText: '清单文件：latest.yml',
      timeText: '正在请求更新元数据'
    });
    return;
  }

  if (status.status === 'available') {
    renderUpdateModal({
      title: `发现新版本：v${targetVersion}`,
      step: '第 2 步 / 共 3 步：已发现更新，开始下载',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n最新版本：v${targetVersion}\n更新源：${feedUrl}`),
      showProgress: true,
      progressPercent: 0,
      speedText: '正在准备下载',
      transferredText: '0 / 待下载',
      timeText: '正在初始化下载'
    });

    if (window.electronAPI && window.electronAPI.downloadUpdate) {
      window.electronAPI.downloadUpdate();
    }
    return;
  }

  if (status.status === 'downloading') {
    const percent = Number.isFinite(status.percent) ? status.percent : 0;
    const speed = formatBytes(status.bytesPerSecond);
    const transferred = formatBytes(status.transferred);
    const total = formatBytes(status.total);
    const remaining = status.remaining > 0 ? formatTime(status.remaining) : '计算中...';

    renderUpdateModal({
      title: '正在下载更新',
      step: `第 3 步 / 共 3 步：已下载 ${percent.toFixed(1)}%`,
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}`),
      showProgress: true,
      progressPercent: percent,
      speedText: speed + '/秒',
      transferredText: `${transferred} / ${total}`,
      timeText: '剩余时间：' + remaining
    });
    return;
  }

  if (status.status === 'downloaded') {
    renderUpdateModal({
      title: `更新已下载：v${targetVersion}`,
      step: '下载完成，可以开始安装。',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n待安装版本：v${targetVersion}`),
      showProgress: true,
      progressPercent: 100,
      speedText: '下载完成',
      transferredText: '100%',
      timeText: '点击“立即安装”后将重启并应用更新',
      showCloseButton: true,
      closeLabel: '稍后',
      showInstallButton: true
    });
    return;
  }

  if (status.status === 'not-available') {
    renderUpdateModal({
      title: '当前已是最新版本',
      step: '版本比较完成',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源版本：v${targetVersion}\n未发现更高版本，此窗口将自动关闭。`),
      showProgress: false,
      showCloseButton: true
    });
    scheduleUpdateModalAutoHide(2000);
    return;
  }

  if (status.status === 'error') {
    renderUpdateModal({
      title: '检查更新失败',
      step: '无法完成本次更新检查',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}\n错误信息：${status.error || '未知错误'}`, true),
      showProgress: false,
      showCloseButton: true
    });
  }
}
async function handleMessage(data) {
  console.log('Received:', data.type);

  switch (data.type) {
    case 'room-created':
      currentRoomId = data.roomId;
      sessionRole = 'host';
      elements.roomIdDisplay.textContent = data.roomId;
      elements.roomInfo.classList.remove('hidden');
      elements.btnStartShare.classList.remove('hidden');
      elements.hostStatus.textContent = '等待开始共享';
      break;

    case 'room-joined':
      currentRoomId = data.roomId;
      sessionRole = 'viewer';
      myChainPosition = data.chainPosition;
      hostId = data.hostId; // 保存Host的ID
      viewerReadySent = false; // 重置标志
      videoStarted = false;
      console.log('Host ID:', hostId);
      elements.joinForm.classList.add('hidden');
      elements.viewerStatus.classList.remove('hidden');
      elements.viewerRoomId.textContent = data.roomId;
      elements.btnLeave.classList.remove('hidden');
      elements.chainPosition.textContent = (data.chainPosition + 1);
      elements.connectionStatus.textContent = '等待连接...';
      break;

    case 'session-resumed':
      currentRoomId = data.roomId;
      sessionRole = data.role;
      if (data.role === 'host') {
        isHost = true;
        elements.roomIdDisplay.textContent = data.roomId;
        elements.roomInfo.classList.remove('hidden');
        elements.viewerCount.textContent = String(data.viewerCount || 0);
        elements.hostStatus.textContent = '已恢复连接';
      } else {
        isHost = false;
        hostId = data.hostId || hostId;
        myChainPosition = data.chainPosition;
        elements.joinForm.classList.add('hidden');
        elements.viewerStatus.classList.remove('hidden');
        elements.viewerRoomId.textContent = data.roomId;
        elements.btnLeave.classList.remove('hidden');
        elements.chainPosition.textContent = (myChainPosition + 1);
        elements.connectionStatus.textContent = '已恢复连接';
      }
      break;

    case 'error':
      showError(data.message);
      break;

    case 'viewer-joined':
      console.log('Host: viewer-joined, viewerId =', data.viewerId);
      // 防止重复创建连接
      if (peerConnections.has(data.viewerId)) {
        console.log('Already connected to', data.viewerId);
        return;
      }
      if (!data.reconnect) {
        updateViewerCount(data.viewerId);
      }
      // 创建WebRTC连接给观众
      if (localStream) {
        await createOffer(data.viewerId);
      }
      break;

    case 'connect-to-next':
      // 服务器通知我作为Relay连接到下一个观众
      console.log('Connecting to next viewer:', data.nextViewerId);
      await createOfferToNextViewer(data.nextViewerId);
      break;

    case 'offer':
      await handleOffer(data);
      break;

    case 'answer':
      await handleAnswer(data);
      break;

    case 'ice-candidate':
      await handleIceCandidate(data);
      break;

    case 'host-disconnected':
      showError('分享者已断开连接');
      resetViewerState();
      break;

    case 'viewer-left':
      updateViewerCount(null, data.leftPosition);
      // 关闭到离开观众的连接
      const leftPc = peerConnections.get(data.viewerId);
      if (leftPc) {
        leftPc.close();
        peerConnections.delete(data.viewerId);
      }
      break;

    case 'chain-reconnect':
      // 链重新调整
      myChainPosition = data.newChainPosition;
      elements.chainPosition.textContent = (myChainPosition + 1);
      break;
  }
}

// Host: 显示屏幕源选择弹窗
async function showSourceSelection() {
  try {
    // 等待WebSocket连接
    await waitForWsConnected();

    let sources = [];

    // 检测是否在Electron环境中
    if (window.isElectron) {
      // Electron环境：通过IPC获取桌面源
      console.log('Getting desktop sources for selection...');
      sources = await window.electronAPI.getDesktopSources();
    } else {
      // 浏览器环境：使用getDisplayMedia（会弹出系统选择器）
      // 浏览器环境下直接调用getDisplayMedia，不需要选择界面
      await startScreenShareWithSource(null);
      return;
    }

    if (!sources || sources.length === 0) {
      throw new Error('没有找到可用的屏幕源');
    }

    // 显示选择弹窗
    showSourceModal(sources);

  } catch (error) {
    console.error('Error loading sources:', error);
    showError('无法获取屏幕列表: ' + error.message);
  }
}

// 刷新屏幕源列表
async function refreshSources() {
  try {
    console.log('Refreshing source list...');
    const btn = elements.btnRefreshSources;
    btn.style.animation = 'spin 1s linear infinite';

    let sources = [];

    // 检测是否在Electron环境中
    if (window.isElectron) {
      sources = await window.electronAPI.getDesktopSources();
    }

    if (!sources || sources.length === 0) {
      showError('没有找到可用的屏幕源');
    } else {
      showSourceModal(sources);
    }

    btn.style.animation = '';
  } catch (error) {
    console.error('Error refreshing sources:', error);
    showError('刷新失败: ' + error.message);
    elements.btnRefreshSources.style.animation = '';
  }
}

// 显示源选择弹窗
function showSourceModal(sources) {
  const modal = document.getElementById('source-modal');
  const sourceList = document.getElementById('source-list');

  // 清空并生成源选项
  sourceList.innerHTML = '';

  sources.forEach((source, index) => {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.dataset.id = source.id;
    item.dataset.name = source.name;
    item.dataset.synthetic = source.isSynthetic ? 'true' : 'false';

    // 缩略图
    if (source.thumbnail) {
      const img = document.createElement('img');
      img.src = source.thumbnail;
      item.appendChild(img);
    }

    // 名称
    const name = document.createElement('p');
    name.textContent = source.name;
    item.appendChild(name);
    if (source.isSynthetic) {
      const badge = document.createElement('div');
      badge.className = 'source-badge';
      badge.textContent = getSourceBadgeLabel(source);
      item.appendChild(badge);
    }
    if (source.fallbackReason) {
      const note = document.createElement('div');
      note.className = 'source-note';
      note.textContent = source.fallbackReason;
      item.appendChild(note);
    }

    // 点击选择
    item.addEventListener('click', () => {
      // 移除其他选中状态
      document.querySelectorAll('.source-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
    });

    sourceList.appendChild(item);

    // 默认选中第一个
    if (index === 0) {
      item.classList.add('selected');
    }
  });

  // 显示弹窗
  modal.classList.remove('hidden');
}

function getSourceBadgeLabel(source) {
  if (!source || !source.captureMode) {
    return '回退源';
  }

  if (source.captureMode === 'fullscreen-display-fallback') {
    return '全屏回退';
  }

  if (source.captureMode === 'minimized-window-fallback') {
    return '最小化窗口';
  }

  return '回退源';
}

// 确认选择并开始共享
// 保存当前选择的屏幕源
let currentScreenSourceId = null;

async function confirmSourceAndShare() {
  const selectedItem = document.querySelector('.source-item.selected');

  if (!selectedItem) {
    showError('请选择一个要分享的屏幕或窗口');
    return;
  }

  currentScreenSourceId = selectedItem.dataset.id;
  const sourceName = selectedItem.dataset.name;

  // 关闭屏幕源弹窗
  document.getElementById('source-modal').classList.add('hidden');

  // 如果是Electron环境，显示音频进程选择
  if (window.isElectron && window.electronAPI && window.electronAPI.audioCapture) {
    try {
      // 检查平台支持
      const isSupported = await window.electronAPI.audioCapture.isPlatformSupported();
      if (isSupported) {
        // 检查权限
        let permission = await window.electronAPI.audioCapture.checkPermission();
        if (permission.status !== 'authorized') {
          permission = await window.electronAPI.audioCapture.requestPermission();
        }

        if (permission.status === 'authorized') {
          // 获取进程列表并显示
          await showAudioProcessSelection(sourceName);
          return;
        }
      }
    } catch (e) {
      console.log('Audio selection error:', e);
    }
  }

  // 直接开始共享（无音频）
  await startScreenShareWithSource(currentScreenSourceId);
}

// 显示音频进程选择弹窗
async function showAudioProcessSelection() {
  try {
    const processes = await window.electronAPI.audioCapture.getProcessList();
    const audioList = elements.audioProcessList;

    audioList.innerHTML = '';

    processes.forEach((proc, index) => {
      const item = document.createElement('div');
      item.className = 'source-item';
      item.dataset.pid = proc.pid;
      item.dataset.name = proc.name;
      item.textContent = `${proc.name} (PID: ${proc.pid})`;

      item.addEventListener('click', () => {
        document.querySelectorAll('#audio-process-list .source-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
      });

      audioList.appendChild(item);

      // 默认选中第一个
      if (index === 0) {
        item.classList.add('selected');
      }
    });

    elements.audioModal.classList.remove('hidden');

  } catch (err) {
    console.error('Error loading audio processes:', err);
    // 直接开始共享
    await startScreenShareWithSource(currentScreenSourceId);
  }
}

// 确认音频进程选择
async function confirmAudioProcess() {
  const selectedItem = document.querySelector('#audio-process-list .source-item.selected');

  elements.audioModal.classList.add('hidden');

  if (selectedItem) {
    const pid = parseInt(selectedItem.dataset.pid);
    const name = selectedItem.dataset.name;
    console.log('Selected audio process:', name, 'PID:', pid);
    await startScreenShareWithAudio(currentScreenSourceId, pid);
  } else {
    // 跳过音频
    await startScreenShareWithSource(currentScreenSourceId);
  }
}

// 跳过音频捕获
async function skipAudioCapture() {
  elements.audioModal.classList.add('hidden');
  await startScreenShareWithSource(currentScreenSourceId);
}

// 取消选择
function cancelSourceSelection() {
  document.getElementById('source-modal').classList.add('hidden');
}

// 捕获窗口音频（自动选择进程）
async function captureWindowAudio(sourceId) {
  if (!window.electronAPI || !window.electronAPI.audioCapture) {
    console.log('Audio capture API not available');
    return null;
  }

  try {
    // 检查平台支持
    const isSupported = await window.electronAPI.audioCapture.isPlatformSupported();
    console.log('Audio platform supported:', isSupported);
    if (!isSupported) return null;

    // 检查权限
    let permission = await window.electronAPI.audioCapture.checkPermission();
    console.log('Audio permission status:', permission.status);

    if (permission.status !== 'authorized') {
      permission = await window.electronAPI.audioCapture.requestPermission();
      console.log('Audio permission after request:', permission.status);
    }

    if (permission.status !== 'authorized') {
      console.log('Audio permission denied');
      return null;
    }

    // 获取进程列表
    const processes = await window.electronAPI.audioCapture.getProcessList();
    console.log('Found audio processes:', processes.length);

    // 从sourceId提取窗口标题来匹配进程
    // sourceId格式: window:PID:index
    const match = sourceId.match(/window:(\d+):/);
    const windowPid = match ? parseInt(match[1]) : null;

    // 查找匹配的进程
    let targetProcess = processes.find(p => p.pid === windowPid);

    if (!targetProcess) {
      console.log('No matching audio process for PID:', windowPid, '- trying first available');
      // 尝试使用第一个可用的音频进程
      if (processes.length > 0) {
        targetProcess = processes[0];
      } else {
        console.log('No audio processes available');
        return null;
      }
    }

    console.log('Auto-selected audio process:', targetProcess.name, 'PID:', targetProcess.pid);

    // 直接调用带PID的版本
    return captureWindowAudioWithPid(sourceId, targetProcess.pid);

  } catch (err) {
    console.error('Error in audio capture:', err);
    return null;
  }
}

// 根据sourceId开始屏幕共享
async function startScreenShareWithSource(sourceId) {
  try {
    let stream;

    if (window.isElectron && sourceId) {
      // Electron环境：使用选中的sourceId
      console.log('Starting share with source:', sourceId);

      // 获取视频流 - 使用画质设置
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            width: qualitySettings.width,
            height: qualitySettings.height,
            frameRate: qualitySettings.frameRate,
            // 尝试设置最大码率 (kbps)
            maxWidth: qualitySettings.width,
            maxHeight: qualitySettings.height,
            maxFrameRate: qualitySettings.frameRate
          }
        }
      });

      // 尝试添加音频捕获
      try {
        const audioStream = await captureWindowAudio(sourceId);
        if (audioStream && audioStream.getAudioTracks().length > 0) {
          // 合并音视频流
          audioStream.getAudioTracks().forEach(track => {
            stream.addTrack(track);
          });
          console.log('Audio track added to stream');
        }
      } catch (audioErr) {
        console.log('Audio capture failed (non-fatal):', audioErr.message);
      }

    } else if (!window.isElectron) {
      // 浏览器环境：直接使用getDisplayMedia
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'window',
          width: { ideal: qualitySettings.width },
          height: { ideal: qualitySettings.height },
          frameRate: { ideal: qualitySettings.frameRate }
        },
        audio: true,
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
        preferCurrentTab: false
      });
    } else {
      throw new Error('无效的屏幕源');
    }

    localStream = stream;

    // 检查实际视频轨道参数
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const settings = videoTrack.getSettings();
      console.log('=== Video Track Settings ===');
      console.log('width:', settings.width);
      console.log('height:', settings.height);
      console.log('frameRate:', settings.frameRate);
    }

    elements.localVideo.srcObject = stream;
    elements.localVideo.classList.remove('hidden');
    elements.btnStartShare.classList.add('hidden');
    elements.btnStopShare.classList.remove('hidden');
    elements.hostStatus.textContent = '共享中';
    elements.hostStatus.classList.remove('waiting');

    // 检查是否有音频轨道
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      console.log('Audio track available:', audioTracks[0].label);
    } else {
      console.log('No audio track - window may not support system audio');
    }

    stream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

    // 创建房间
    sendMessage({
      type: 'create-room',
      clientId: clientId
    });

  } catch (error) {
    console.error('Error starting screen share:', error);
    if (error.name === 'AbortError') {
      // 用户取消选择，忽略
    } else if (error.name === 'NotAllowedError') {
      showError('请允许屏幕捕获');
    } else {
      showError('无法获取屏幕: ' + error.message);
    }
  }
}

// 使用指定PID启动屏幕共享（带音频）
async function startScreenShareWithAudio(sourceId, audioPid) {
  try {
    let stream;

    if (window.isElectron && sourceId) {
      console.log('Starting share with source:', sourceId, 'audio PID:', audioPid);

      // 获取视频流 - 使用画质设置
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            width: qualitySettings.width,
            height: qualitySettings.height,
            frameRate: qualitySettings.frameRate,
            maxWidth: qualitySettings.width,
            maxHeight: qualitySettings.height,
            maxFrameRate: qualitySettings.frameRate
          }
        }
      });

      // 使用用户选择的PID捕获音频
      if (audioPid) {
        try {
          const audioStream = await captureWindowAudioWithPid(sourceId, audioPid);
          if (audioStream && audioStream.getAudioTracks().length > 0) {
            // 合并音视频流
            audioStream.getAudioTracks().forEach(track => {
              stream.addTrack(track);
            });
            console.log('Audio track added to stream from selected PID:', audioPid);
          }
        } catch (audioErr) {
          console.log('Audio capture failed (non-fatal):', audioErr.message);
        }
      }

    } else {
      throw new Error('无效的屏幕源');
    }

    localStream = stream;

    // 检查实际视频轨道参数
    const videoTrack2 = stream.getVideoTracks()[0];
    if (videoTrack2) {
      const settings = videoTrack2.getSettings();
      console.log('=== Video Track Settings ===');
      console.log('width:', settings.width);
      console.log('height:', settings.height);
      console.log('frameRate:', settings.frameRate);
    }

    elements.localVideo.srcObject = stream;
    elements.localVideo.classList.remove('hidden');
    elements.btnStartShare.classList.add('hidden');
    elements.btnStopShare.classList.remove('hidden');
    elements.hostStatus.textContent = '共享中';
    elements.hostStatus.classList.remove('waiting');

    // 检查是否有音频轨道
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      console.log('Audio track available:', audioTracks[0].label);
    } else {
      console.log('No audio track');
    }

    stream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

    // 创建房间
    sendMessage({
      type: 'create-room',
      clientId: clientId
    });

  } catch (error) {
    console.error('Error starting screen share with audio:', error);
    if (error.name === 'AbortError') {
      // 用户取消选择，忽略
    } else if (error.name === 'NotAllowedError') {
      showError('请允许屏幕捕获');
    } else {
      showError('无法获取屏幕: ' + error.message);
    }
  }
}

// 使用指定PID捕获窗口音频
async function captureWindowAudioWithPid(_sourceId, pid) {
  if (!window.electronAPI || !window.electronAPI.audioCapture) {
    console.log('Audio capture API not available');
    return null;
  }

  // 清理之前的音频资源
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  // 调用返回的取消函数
  if (typeof audioDataHandler === 'function') {
    audioDataHandler();
  }
  audioDataHandler = null;
  audioQueue = [];
  isAudioPlaying = false;
  if (audioTimer) {
    clearTimeout(audioTimer);
    audioTimer = null;
  }

  try {
    // 检查平台支持
    const isSupported = await window.electronAPI.audioCapture.isPlatformSupported();
    console.log('Audio platform supported:', isSupported);
    if (!isSupported) return null;

    // 检查权限
    let permission = await window.electronAPI.audioCapture.checkPermission();
    console.log('Audio permission status:', permission.status);

    if (permission.status !== 'authorized') {
      permission = await window.electronAPI.audioCapture.requestPermission();
      console.log('Audio permission after request:', permission.status);
    }

    if (permission.status !== 'authorized') {
      console.log('Audio permission denied');
      return null;
    }

    // 获取进程列表验证PID有效
    const processes = await window.electronAPI.audioCapture.getProcessList();
    const targetProcess = processes.find(p => p.pid === pid);

    if (!targetProcess) {
      console.log('No audio process found for PID:', pid);
      return null;
    }

    console.log('Starting audio capture for:', targetProcess.name, 'PID:', targetProcess.pid);

    // 使用全局 AudioContext
    audioContext = new AudioContext();
    console.log('AudioContext state:', audioContext.state);

    // 确保AudioContext处于运行状态
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
      console.log('AudioContext resumed');
    }

    audioMediaStreamDest = audioContext.createMediaStreamDestination();
    const audioSyncProfile = getAudioSyncProfile();
    const targetLeadSec = audioSyncProfile.targetLeadMs / 1000;
    const scheduleAheadSec = audioSyncProfile.scheduleAheadMs / 1000;
    const syncToleranceSec = audioSyncProfile.toleranceMs / 1000;
    let queuedDurationSec = 0;
    let lastSyncCheckAt = 0;
    let lastSyncLogAt = 0;

    console.log(
      'Audio sync profile:',
      audioSyncProfile.name,
      'targetLeadMs:',
      audioSyncProfile.targetLeadMs,
      'scheduleAheadMs:',
      audioSyncProfile.scheduleAheadMs
    );

    const logAudioSync = (message, force = false) => {
      const now = Date.now();
      if (!force && now - lastSyncLogAt < 1500) {
        return;
      }
      lastSyncLogAt = now;
      console.log(message);
    };

    const ensureAudioLead = (reason) => {
      const currentTime = audioContext.currentTime;
      const desiredStartTime = currentTime + targetLeadSec;
      const currentLeadSec = nextPlayTime - currentTime;
      const scheduledLeadSec = Math.max(0, currentLeadSec);
      const effectiveLeadSec = scheduledLeadSec + queuedDurationSec;

      if (!Number.isFinite(nextPlayTime) || nextPlayTime <= 0) {
        nextPlayTime = desiredStartTime;
        logAudioSync(`[Audio Sync] initialized lead=${audioSyncProfile.targetLeadMs}ms reason=${reason}`, true);
        return;
      }

      if (effectiveLeadSec < targetLeadSec - syncToleranceSec) {
        nextPlayTime = desiredStartTime;
        logAudioSync(
          `[Audio Sync] corrected reason=${reason} lead=${Math.round(scheduledLeadSec * 1000)}ms effective=${Math.round(effectiveLeadSec * 1000)}ms target=${audioSyncProfile.targetLeadMs}ms queue=${Math.round(queuedDurationSec * 1000)}ms`,
          true
        );
      }
    };

    // 方案：使用队列平滑播放音频
    let nextPlayTime = 0;
    const SCHEDULE_AHEAD_TIME = 0.1; // 提前100ms调度

    const processAudioQueue = () => {
      if (!isAudioPlaying) return;

      const currentTime = audioContext.currentTime;
      const now = Date.now();

      if (!lastSyncCheckAt || now - lastSyncCheckAt >= audioSyncProfile.checkIntervalMs) {
        lastSyncCheckAt = now;
        ensureAudioLead('periodic');
      }

      // 如果没有下一个播放时间，设置当前时间
      if (nextPlayTime < currentTime) {
        nextPlayTime = currentTime + targetLeadSec;
        logAudioSync(`[Audio Sync] underrun recovered with ${audioSyncProfile.targetLeadMs}ms lead`);
      }

      // 处理队列中的音频数据
      while (audioQueue.length > 0 && nextPlayTime < currentTime + scheduleAheadSec) {
        const audioData = audioQueue.shift();
        const chunkDurationSec = getAudioChunkDurationSeconds(audioData);
        queuedDurationSec = Math.max(0, queuedDurationSec - chunkDurationSec);

        try {
          // 创建 AudioBuffer
          const sampleCount = audioData.buffer.length / audioData.channels;
          const audioBuffer = audioContext.createBuffer(audioData.channels, sampleCount, audioData.sampleRate);

          // 复制数据到每个通道
          for (let channel = 0; channel < audioData.channels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < sampleCount; i++) {
              channelData[i] = audioData.buffer[i * audioData.channels + channel] || 0;
            }
          }

          // 创建音频源，只连接到 MediaStreamDestination 用于传输
          const source = audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioMediaStreamDest);
          // 不连接到 audioContext.destination，避免本地播放

          // 在正确的时间播放
          source.start(nextPlayTime);

          // 更新下次播放时间
          nextPlayTime += chunkDurationSec;
        } catch (e) {
          console.log('Play error:', e);
        }
      }

      // 继续调度
      if (isAudioPlaying) {
        audioTimer = setTimeout(processAudioQueue, 25);
      }
    };

    // 保存监听器到全局变量（on 返回取消监听函数）
    audioDataHandler = window.electronAPI.audioCapture.on('audio-data', (audioData) => {
      if (audioData && audioData.buffer) {
        audioQueue.push(audioData);
        queuedDurationSec += getAudioChunkDurationSeconds(audioData);
      }
    });

    // 开始捕获
    await window.electronAPI.audioCapture.startCapture(targetProcess.pid);
    console.log('Audio capture started');

    // 开始播放
    isAudioPlaying = true;
    nextPlayTime = audioContext.currentTime + targetLeadSec;
    lastSyncCheckAt = Date.now();
    processAudioQueue();

    // 检查生成的音频轨道
    const audioTracks = audioMediaStreamDest.stream.getAudioTracks();
    if (audioTracks.length > 0) {
      console.log('Audio track created:', audioTracks[0].label, 'sampleRate:', audioTracks[0].getSettings().sampleRate);
    }

    return audioMediaStreamDest.stream;

  } catch (err) {
    console.error('Audio capture error:', err);
    return null;
  }
}

// Host: 开始屏幕共享（保留兼容性）
async function startScreenShare() {
  // 先显示画质设置弹窗
  elements.qualityModal.classList.remove('hidden');
}

// Host: 停止屏幕共享
function stopScreenShare() {
  // 停止音频捕获并清理资源
  if (window.electronAPI && window.electronAPI.audioCapture) {
    window.electronAPI.audioCapture.stopCapture().catch(() => {});
  }

  // 移除音频数据监听器（调用取消函数）
  if (typeof audioDataHandler === 'function') {
    audioDataHandler();
  }
  audioDataHandler = null;

  // 停止音频队列处理定时器
  isAudioPlaying = false;
  if (audioTimer) {
    clearTimeout(audioTimer);
    audioTimer = null;
  }
  audioQueue = [];

  // 关闭 AudioContext
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioMediaStreamDest = null;

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // 清理 Host 状态
  peerConnections.forEach((pc) => {
    pc.close();
  });
  peerConnections.clear();

  if (currentRoomId && sessionRole === 'host') {
    sendMessage({
      type: 'leave-room',
      roomId: currentRoomId,
      clientId: clientId
    }, { queueIfDisconnected: false });
  }

  sessionRole = null;
  currentRoomId = null;
  hostId = null;
  elements.roomInfo.classList.add('hidden');
  elements.viewerCount.textContent = '0';

  elements.localVideo.srcObject = null;
  elements.localVideo.classList.add('hidden');
  elements.btnStartShare.classList.remove('hidden');
  elements.btnStopShare.classList.add('hidden');
  elements.hostStatus.textContent = '准备就绪';
}

// Viewer: 加入房间
function joinRoom() {
  const roomId = elements.roomIdInput.value.toUpperCase().trim();
  if (!roomId) {
    showError('请输入房间号');
    return;
  }

  currentRoomId = roomId;
  sessionRole = 'viewer';
  sendMessage({
    type: 'join-room',
    roomId: roomId,
    clientId: clientId
  });
}

// Viewer: 离开房间
function leaveRoom() {
  sendMessage({
    type: 'leave-room',
    roomId: currentRoomId,
    clientId: clientId
  }, { queueIfDisconnected: false });

  // resetViewerState 会清理 peerConnections
  resetViewerState();
}

// 重置Viewer状态
function resetViewerState() {
  currentRoomId = null;
  sessionRole = null;
  hostId = null;
  myChainPosition = -1;
  viewerReadySent = false;
  videoStarted = false;
  upstreamConnected = false;
  relayPc = null;
  relayStream = null;

  // 清理音频资源
  isAudioPlaying = false;
  if (audioTimer) {
    clearTimeout(audioTimer);
    audioTimer = null;
  }
  audioQueue = [];

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioMediaStreamDest = null;
  // 调用返回的取消函数
  if (typeof audioDataHandler === 'function') {
    audioDataHandler();
  }
  audioDataHandler = null;

  // 清理连接
  peerConnections.forEach((pc) => {
    pc.close();
  });
  peerConnections.clear();

  elements.joinForm.classList.remove('hidden');
  elements.viewerStatus.classList.add('hidden');
  elements.btnLeave.classList.add('hidden');
  elements.remoteVideo.srcObject = null;
  elements.waitingMessage.classList.remove('hidden');
  elements.connectionStatus.textContent = '等待连接...';
  elements.connectionStatus.classList.remove('connected');
}

// 更新观众数量
function updateViewerCount(viewerId, leftPosition) {
  const countElement = elements.viewerCount;
  let count = parseInt(countElement.textContent) || 0;

  if (viewerId) {
    count++;
  } else if (leftPosition !== undefined) {
    count = Math.max(0, count - 1);
  }

  countElement.textContent = count;
}

// 复制房间号
function copyRoomId() {
  navigator.clipboard.writeText(currentRoomId).then(() => {
    showError('房间号已复制');
  });
}

// 显示错误
function showError(message) {
  elements.errorToast.textContent = message;
  elements.errorToast.classList.remove('hidden');
  setTimeout(() => {
    elements.errorToast.classList.add('hidden');
  }, 3000);
}

// ========== WebRTC 核心逻辑 ==========

// 创建PeerConnection
function legacyCreatePeerConnection(peerId, _isInitiator) {
  const pc = new RTCPeerConnection(config);

  // ICE收集状态监听
  pc.onicegatheringstatechange = () => {
    console.log('ICE gathering state:', pc.iceGatheringState, 'peerId:', peerId);
  };

  pc.onicecandidate = (event) => {
    // 等待remote description设置完成后再发送ICE候选
    if (event.candidate && pc.remoteDescription && pc.remoteDescription.type) {
      console.log('Sending ICE candidate to', peerId);
      sendMessage({
        type: 'ice-candidate',
        targetId: peerId,
        candidate: event.candidate,
        roomId: currentRoomId
      });
    }
  };

  pc.ontrack = (event) => {
    console.log('Received track from', peerId);
    const [stream] = event.streams;

    console.log('Stream tracks:', stream.getTracks().map(t => t.kind));
    console.log('Video tracks:', stream.getVideoTracks().length);
    console.log('Audio tracks:', stream.getAudioTracks().length);

    if (stream.getVideoTracks().length > 0) {
      const videoTrack = stream.getVideoTracks()[0];
      console.log('Video track enabled:', videoTrack.enabled);
      console.log('Video track readyState:', videoTrack.readyState);
    }

    // 如果已经连接到上游，再收到新连接就是转发连接
    const isRelayConnection = (upstreamConnected && !isHost);
    if (isRelayConnection) {
      console.log('Relay connection track received, only forwarding');
      // 更新relayStream用于转发
      relayStream = stream;
      // 添加轨道到转发PC
      if (relayPc && relayPc !== pc) {
        const existingSenders = relayPc.getSenders();
        stream.getTracks().forEach(track => {
          const alreadyAdded = existingSenders.some(s => s.track === track);
          if (!alreadyAdded) {
            console.log('Adding track to relay PC:', track.kind);
            relayPc.addTrack(track, stream);
          }
        });
        // 设置转发码率
        setVideoBitrate(relayPc).catch(err => console.log('Set bitrate error:', err));
      }
      return; // 转发连接不更新UI，不重复处理音频
    }

    // 主连接（Host）的处理逻辑
    // 保存收到的流用于转发
    relayStream = stream;

    // 如果有转发PC，添加track（防重复）
    if (relayPc) {
      const existingSenders = relayPc.getSenders();
      stream.getTracks().forEach(track => {
        const alreadyAdded = existingSenders.some(s => s.track === track);
        if (!alreadyAdded) {
          console.log('Adding track to relay PC:', track.kind);
          relayPc.addTrack(track, stream);
        }
      });
      // 设置转发码率
      setVideoBitrate(relayPc);
    }

    // 显示视频（只播放一次）
    if (!videoStarted && stream.getVideoTracks().length > 0) {
      videoStarted = true;
      upstreamConnected = true; // 标记已连接到上游
      elements.remoteVideo.srcObject = stream;
      elements.remoteVideo.play().then(() => {
        console.log('Video playing successfully');
      }).catch(e => console.log('Play error:', e));
      elements.waitingMessage.classList.add('hidden');
      elements.connectionStatus.textContent = '已连接';
      elements.connectionStatus.classList.add('connected');
    }

    // 如果是观众且收到视频，需要作为Relay转发给下一个（只发一次）
    if (!isHost && myChainPosition >= 0 && !viewerReadySent) {
      viewerReadySent = true;
      // 通知服务器我已收到视频，可以开始转发
      sendMessage({
        type: 'viewer-ready',
        roomId: currentRoomId,
        clientId: clientId,
        chainPosition: myChainPosition
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState, 'peerId:', peerId, 'ICE:', pc.iceGatheringState);
    // 只更新主连接（Host）的状态，不更新转发连接的状态
    // 转发连接的peerId是下一个观众的ID，不影响连接状态显示
    const isHostConnection = (peerId === hostId);
    if (isHostConnection) {
      if (pc.connectionState === 'connected') {
        console.log('WebRTC connected with', peerId);
        elements.connectionStatus.textContent = '已连接';
        elements.connectionStatus.classList.add('connected');
        // 启动统计日志
        startStatsLogging(pc, isHost ? 'Host->Viewer' : 'Viewer->Upstream');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.log('WebRTC connection failed:', pc.connectionState);
        elements.connectionStatus.textContent = '连接失败';
        elements.connectionStatus.classList.remove('connected');
        stopStatsLogging();
      }
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

// 设置视频码率
function createPeerConnection(peerId, _isInitiator) {
  const pc = new RTCPeerConnection(config);

  pc.onicegatheringstatechange = () => {
    console.log('ICE gathering state:', pc.iceGatheringState, 'peerId:', peerId);
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    console.log('Sending ICE candidate to', peerId);
    sendMessage({
      type: 'ice-candidate',
      targetId: peerId,
      candidate: event.candidate,
      roomId: currentRoomId
    });
  };

  pc.onicecandidateerror = (event) => {
    console.log('ICE candidate error:', peerId, event.errorText || event.errorCode);
  };

  pc.ontrack = (event) => {
    console.log('Received track from', peerId);
    const [stream] = event.streams;

    if (!stream) {
      return;
    }

    console.log('Stream tracks:', stream.getTracks().map((track) => track.kind));

    const isRelayConnection = upstreamConnected && !isHost;
    if (isRelayConnection) {
      relayStream = stream;
      if (relayPc && relayPc !== pc) {
        const existingSenders = relayPc.getSenders();
        stream.getTracks().forEach((track) => {
          const alreadyAdded = existingSenders.some((sender) => sender.track === track);
          if (!alreadyAdded) {
            relayPc.addTrack(track, stream);
          }
        });
        setVideoBitrate(relayPc).catch((error) => console.log('Set bitrate error:', error));
      }
      return;
    }

    relayStream = stream;

    if (relayPc) {
      const existingSenders = relayPc.getSenders();
      stream.getTracks().forEach((track) => {
        const alreadyAdded = existingSenders.some((sender) => sender.track === track);
        if (!alreadyAdded) {
          relayPc.addTrack(track, stream);
        }
      });
      setVideoBitrate(relayPc).catch((error) => console.log('Set bitrate error:', error));
    }

    if (!videoStarted && stream.getVideoTracks().length > 0) {
      videoStarted = true;
      upstreamConnected = true;
      elements.remoteVideo.srcObject = stream;
      elements.remoteVideo.play().catch((error) => console.log('Play error:', error));
      elements.waitingMessage.classList.add('hidden');
      elements.connectionStatus.textContent = '已连接';
      elements.connectionStatus.classList.add('connected');
    }

    if (!isHost && myChainPosition >= 0 && !viewerReadySent) {
      viewerReadySent = true;
      sendMessage({
        type: 'viewer-ready',
        roomId: currentRoomId,
        clientId: clientId,
        chainPosition: myChainPosition
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState, 'peerId:', peerId, 'ICE:', pc.iceGatheringState);

    const isUpstreamConnection = peerId === hostId;
    if (!isUpstreamConnection) {
      return;
    }

    if (pc.connectionState === 'connected') {
      elements.connectionStatus.textContent = '已连接';
      elements.connectionStatus.classList.add('connected');
      startStatsLogging(pc, isHost ? 'Host->Viewer' : 'Viewer->Upstream');
      return;
    }

    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      elements.connectionStatus.textContent = '连接失败';
      elements.connectionStatus.classList.remove('connected');
      stopStatsLogging();
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

async function setVideoBitrate(pc) {
  const senders = pc.getSenders();
  const videoSender = senders.find(s => s.track && s.track.kind === 'video');

  if (videoSender) {
    const parameters = videoSender.getParameters();
    if (!parameters.encodings) {
      parameters.encodings = [{}];
    }
    // 使用画质设置中的码率 (kbps -> bps)
    parameters.encodings[0].maxBitrate = qualitySettings.bitrate * 1000;
    parameters.encodings[0].maxFramerate = qualitySettings.frameRate;

    console.log('Setting video bitrate:', qualitySettings.bitrate * 1000, 'bps, framerate:', qualitySettings.frameRate);

    try {
      await videoSender.setParameters(parameters);
      console.log('Video parameters set successfully');
    } catch (err) {
      console.log('Failed to set video parameters:', err);
    }
  } else {
    console.log('No video sender found in setVideoBitrate');
  }
}

// 强制使用H.264编码（修改SDP）
function preferH264Codec(sdp) {
  // 查找m=video行中的H.264格式
  const videoLineMatch = sdp.match(/m=video (\d+) RTP\/AVP ([^\r\n]+)/);
  if (!videoLineMatch) return sdp;

  const mediaPort = videoLineMatch[1];
  const existingPayloads = videoLineMatch[2].trim().split(' ');

  // 查找H.264的payload type
  let h264Pt = null;
  const h264Regex = /a=rtpmap:(\d+) H264\/90000/i;
  const lines = sdp.split('\n');
  for (const line of lines) {
    const match = line.match(h264Regex);
    if (match) {
      // 检查是否是High Profile
      if (line.includes('packetization-mode=1') && line.includes('profile-level-id')) {
        h264Pt = match[1];
        break;
      }
    }
  }

  if (!h264Pt) {
    console.log('H.264 codec not found in SDP');
    return sdp;
  }

  console.log('Found H.264 payload type:', h264Pt);

  // 将H.264移到最前面
  const otherPayloads = existingPayloads.filter(pt => pt !== h264Pt);
  const newPayloads = [h264Pt, ...otherPayloads].join(' ');

  // 替换m=video行
  sdp = sdp.replace(
    /m=video \d+ RTP\/AVP [^\r\n]+/,
    `m=video ${mediaPort} RTP/AVP ${newPayloads}`
  );

  return sdp;
}

// 强制使用AV1编码（修改SDP）
function preferAV1Codec(sdp) {
  // 查找m=video行中的AV1格式
  const videoLineMatch = sdp.match(/m=video (\d+) RTP\/AVP ([^\r\n]+)/);
  if (!videoLineMatch) return sdp;

  const mediaPort = videoLineMatch[1];
  const existingPayloads = videoLineMatch[2].trim().split(' ');

  // 查找AV1的payload type
  let av1Pt = null;
  const av1Regex = /a=rtpmap:(\d+) AV1\/90000/i;
  const lines = sdp.split('\n');
  for (const line of lines) {
    const match = line.match(av1Regex);
    if (match) {
      av1Pt = match[1];
      break;
    }
  }

  if (!av1Pt) {
    console.log('AV1 codec not found in SDP');
    return sdp;
  }

  console.log('Found AV1 payload type:', av1Pt);

  // 将AV1移到最前面
  const otherPayloads = existingPayloads.filter(pt => pt !== av1Pt);
  const newPayloads = [av1Pt, ...otherPayloads].join(' ');

  // 替换m=video行
  sdp = sdp.replace(
    /m=video \d+ RTP\/AVP [^\r\n]+/,
    `m=video ${mediaPort} RTP/AVP ${newPayloads}`
  );

  return sdp;
}

// 设置编码偏好（通用函数）
function setCodecPreferencesForPC(pc) {
  const codec = qualitySettings.codecPreference;
  if (codec === 'none') return;

  try {
    const videoCapabilities = RTCRtpSender.getCapabilities('video');
    if (!videoCapabilities || !Array.isArray(videoCapabilities.codecs)) {
      console.log('Video capabilities unavailable for codec preference');
      return;
    }

    let allCodecs = videoCapabilities.codecs;
    let preferredCodecs = [];
    const capabilitySummary = allCodecs.map((entry) => ({
      mimeType: entry.mimeType,
      sdpFmtpLine: entry.sdpFmtpLine || '',
      clockRate: entry.clockRate
    }));
    console.log('Video codec capabilities:', capabilitySummary);

    // 根据配置构建偏好列表
    if (codec === 'av1') {
      const av1Codecs = allCodecs.filter(c => c.mimeType.toLowerCase() === 'video/av1');
      if (av1Codecs.length > 0) {
        console.log('AV1 codec available, will prefer it');
        preferredCodecs = preferredCodecs.concat(av1Codecs);
      } else {
        console.log('AV1 codec not available');
      }
    }
    if (codec === 'h264') {
      const h264Codecs = allCodecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
      if (h264Codecs.length > 0) {
        console.log('H.264 codec available, will prefer it');
        preferredCodecs = preferredCodecs.concat(h264Codecs);
      } else {
        console.log('H.264 codec not available');
      }
    }

    // 如果没有强制任何编码器，则使用全部（保持默认顺序）
    if (preferredCodecs.length === 0) {
      console.log('No specific codec preference, using default');
      return;
    } else {
      // 将其他未列出的编码器也添加进去，确保协商不会失败
      const otherCodecs = allCodecs.filter(c => !preferredCodecs.includes(c));
      preferredCodecs = preferredCodecs.concat(otherCodecs);
    }

    // 应用到所有video transceiver
    pc.getTransceivers().forEach(t => {
      if (t.sender && t.sender.track && t.sender.track.kind === 'video') {
        t.setCodecPreferences(preferredCodecs);
      }
    });
    console.log(
      'Applied codec preference order:',
      preferredCodecs.map((entry) => `${entry.mimeType}${entry.sdpFmtpLine ? ` (${entry.sdpFmtpLine})` : ''}`)
    );
  } catch (err) {
    console.log('Failed to set codec preferences:', err);
  }
}

// WebRTC 统计日志
let statsInterval = null;

async function logWebRTCStats(pc, label) {
  if (!pc || pc.connectionState !== 'connected') return;

  try {
    const stats = await pc.getStats();
    let output = `\n=== WebRTC Stats [${label}] ===`;

    stats.forEach(report => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        const codec = report.codecId ? stats.get(report.codecId) : null;
        output += `\n[Inbound Video]
  framesDecoded: ${report.framesDecoded || 0}
  framesDropped: ${report.framesDropped || 0}
  framesReceived: ${report.framesReceived || 0}
  packetsLost: ${report.packetsLost || 0}
  bytesReceived: ${report.bytesReceived || 0}
  jitter: ${report.jitter || 0}ms
  roundTripTime: ${report.roundTripTime || 0}ms
  decoderImplementation: ${report.decoderImplementation || 'unknown'}
  powerEfficientDecoder: ${report.powerEfficientDecoder ?? 'unknown'}
  codec: ${codec ? codec.mimeType : 'unknown'}`;
      }

      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        const codec = report.codecId ? stats.get(report.codecId) : null;
        output += `\n[Outbound Video]
  framesEncoded: ${report.framesEncoded || 0}
  packetsSent: ${report.packetsSent || 0}
  bytesSent: ${report.bytesSent || 0}
  targetBitrate: ${report.targetBitrate || 0}
  encoderBitrate: ${report.encoderBitrate || 0}
  encoderImplementation: ${report.encoderImplementation || 'unknown'}
  powerEfficientEncoder: ${report.powerEfficientEncoder ?? 'unknown'}
  codec: ${codec ? codec.mimeType : 'unknown'}`;
      }

      if (report.type === 'codec' && report.mimeType && report.mimeType.includes('video')) {
        output += `\n[Codec]
  mimeType: ${report.mimeType}
  clockRate: ${report.clockRate}
  channels: ${report.channels}`;
      }

      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        const localCandidate = stats.get(report.localCandidateId);
        const remoteCandidate = stats.get(report.remoteCandidateId);
        output += `\n[Candidate Pair]
  rtt: ${report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : 0}ms
  availableOutgoingBitrate: ${report.availableOutgoingBitrate || 0}
  localCandidate: ${localCandidate ? `${localCandidate.candidateType}/${localCandidate.protocol || 'unknown'}` : 'unknown'}
  remoteCandidate: ${remoteCandidate ? `${remoteCandidate.candidateType}/${remoteCandidate.protocol || 'unknown'}` : 'unknown'}`;
      }
    });

    console.log(output);
  } catch (err) {
    console.log('Stats error:', err);
  }
}

// 版本检查和自动更新
let currentVersion = '1.5.0'; // 默认版本（Electron环境会动态获取）

// 初始化版本号（从 Electron app 获取）
async function initVersion() {
  if (window.electronAPI && window.electronAPI.getAppVersion) {
    try {
      currentVersion = await window.electronAPI.getAppVersion();
      console.log('App version:', currentVersion);
    } catch (err) {
      console.log('Failed to get app version:', err);
    }
  }
}

// 格式化字节数
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 格式化时间（毫秒转可读格式）
function formatTime(ms) {
  if (!ms || ms <= 0) return '未知';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return hours + '小时' + (minutes % 60) + '分钟';
  } else if (minutes > 0) {
    return minutes + '分钟' + (seconds % 60) + '秒';
  } else {
    return seconds + '秒';
  }
}

async function legacyCheckForUpdates() {
  return checkForUpdates();
}


function startStatsLogging(pc, label) {
  if (statsInterval) clearInterval(statsInterval);

  statsInterval = setInterval(() => {
    logWebRTCStats(pc, label);
  }, 3000);
}

function stopStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// Host: 创建offer给观众
async function legacyCreateOffer(viewerId) {
  console.log('Host: createOffer for viewerId =', viewerId);
  const pc = createPeerConnection(viewerId, true);

  // 监听连接状态变化
  pc.onconnectionstatechange = () => {
    console.log(`Connection state [Host->${viewerId}]:`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      startStatsLogging(pc, `Host->Viewer(${viewerId.substr(0, 8)})`);
    }
  };

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // 设置编码器偏好
  setCodecPreferencesForPC(pc);

  const offer = await pc.createOffer();

  // 在SDP中设置带宽限制
  let sdp = offer.sdp;
  // 添加 b=AS (Application Specific) 带宽限制
  // 如果指定了编码偏好，修改SDP
  if (qualitySettings.codecPreference === 'h264') {
    sdp = preferH264Codec(sdp);
  } else if (qualitySettings.codecPreference === 'av1') {
    sdp = preferAV1Codec(sdp);
  }

  const modifiedOffer = {
    type: offer.type,
    sdp: sdp
  };
  await pc.setLocalDescription(modifiedOffer);

  // 设置视频码率和帧率（在连接建立后）
  await setVideoBitrate(pc);

  // 等待至少3个ICE候选后再发送offer（加快连接速度）
  let candidateCount = 0;
  const candidatePromise = new Promise(resolve => {
    const checkCandidate = (event) => {
      if (event.candidate) {
        candidateCount++;
        console.log('ICE candidate #' + candidateCount + ' for', viewerId);
        if (candidateCount >= 2) {
          pc.removeEventListener('icecandidate', checkCandidate);
          resolve();
        }
      }
    };
    pc.addEventListener('icecandidate', checkCandidate);
  });

  // 同时监听ICE收集完成，作为后备
  const gatherPromise = new Promise(resolve => {
    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', checkState);
  });

  // 任一条件满足就继续
  await Promise.race([candidatePromise, gatherPromise]);
  console.log('ICE candidates ready (' + candidateCount + '), sending offer');

  sendMessage({
    type: 'offer',
    targetId: viewerId,
    sdp: pc.localDescription,
    roomId: currentRoomId
  });
}

// 观众: 连接到下一个观众（作为Relay）
async function legacyCreateOfferToNextViewer(nextViewerId) {
  // 防止重复创建
  if (peerConnections.has(nextViewerId)) {
    console.log('Already connected to', nextViewerId);
    return;
  }

  // 等待 relayStream 可用（最多等 10 秒）
  const maxWait = 10000;
  const startTime = Date.now();
  while (!relayStream && Date.now() - startTime < maxWait) {
  console.log('Waiting for relayStream...');
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (!relayStream) {
    console.error('Timeout waiting for relayStream, cannot create offer');
    showError('无法建立转发连接：等待视频流超时');
    return;
  }

  console.log('Relay stream available, creating offer');

  const pc = createPeerConnection(nextViewerId, true);
  relayPc = pc; // 保存转发PC的引用

  // 监听连接状态变化
  pc.onconnectionstatechange = () => {
    console.log(`Connection state [Relay->${nextViewerId}]:`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      startStatsLogging(pc, `Viewer->NextViewer(${nextViewerId.substr(0, 8)})`);
    }
  };

  // 如果已经收到了视频流，先添加track
  if (relayStream) {
    console.log('Adding track to relay PC BEFORE offer');
    relayStream.getTracks().forEach(track => {
      pc.addTrack(track, relayStream);
    });
    // 设置视频码率
    await setVideoBitrate(pc);
  } else {
    console.log('No relay stream yet, will add later');
  }

  // 设置编码器偏好
  setCodecPreferencesForPC(pc);

  const offer = await pc.createOffer();

  // 在SDP中设置带宽限制
  let sdp = offer.sdp;
  // 如果指定了编码偏好，修改SDP
  if (qualitySettings.codecPreference === 'h264') {
    sdp = preferH264Codec(sdp);
  } else if (qualitySettings.codecPreference === 'av1') {
    sdp = preferAV1Codec(sdp);
  }

  const modifiedOffer = {
    type: offer.type,
    sdp: sdp
  };
  await pc.setLocalDescription(modifiedOffer);

  // 在连接建立后再次设置码率
  await setVideoBitrate(pc);

  // 等待至少3个ICE候选后再发送offer
  let candidateCount = 0;
  const candidatePromise = new Promise(resolve => {
    const checkCandidate = (event) => {
      if (event.candidate) {
        candidateCount++;
        console.log('Relay ICE candidate #' + candidateCount + ' for', nextViewerId);
        if (candidateCount >= 2) {
          pc.removeEventListener('icecandidate', checkCandidate);
          resolve();
        }
      }
    };
    pc.addEventListener('icecandidate', checkCandidate);
  });

  const gatherPromise = new Promise(resolve => {
    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', checkState);
  });

  await Promise.race([candidatePromise, gatherPromise]);
  console.log('Relay ICE candidates ready (' + candidateCount + '), sending offer');

  sendMessage({
    type: 'offer',
    targetId: nextViewerId,
    sdp: pc.localDescription,
    roomId: currentRoomId,
    isRelay: true
  });
}

// 收到offer
async function legacyHandleOffer(data) {
  const fromId = data.fromClientId;
  console.log('Viewer: received offer from', fromId);
  const pc = createPeerConnection(fromId, false);

  // createPeerConnection already sets up ontrack handler

  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // 等待至少3个ICE候选后再发送answer
  let candidateCount = 0;
  const candidatePromise = new Promise(resolve => {
    const checkCandidate = (event) => {
      if (event.candidate) {
        candidateCount++;
        console.log('Viewer ICE candidate #' + candidateCount + ' for', fromId);
        if (candidateCount >= 2) {
          pc.removeEventListener('icecandidate', checkCandidate);
          resolve();
        }
      }
    };
    pc.addEventListener('icecandidate', checkCandidate);
  });

  const gatherPromise = new Promise(resolve => {
    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', checkState);
  });

  await Promise.race([candidatePromise, gatherPromise]);
  console.log('Viewer ICE candidates ready (' + candidateCount + '), sending answer');

  console.log('Viewer: sending answer to', fromId);
  sendMessage({
    type: 'answer',
    targetId: fromId,
    sdp: pc.localDescription,
    roomId: currentRoomId
  });
}

// 收到answer
async function legacyHandleAnswer(data) {
  console.log('handleAnswer: targetId =', data.targetId, ', fromClientId =', data.fromClientId);
  console.log('peerConnections keys:', [...peerConnections.keys()]);
  // 使用fromClientId查找PC（服务器会设置这个为发送者的ID）
  const pc = peerConnections.get(data.fromClientId) || peerConnections.get(data.targetId);
  console.log('handleAnswer: pc found =', !!pc);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    console.log('Remote description set');
    // track添加已在createOfferToNextViewer中处理
  } else {
    console.log('ERROR: PC not found');
  }
}

// 收到ICE候选
async function legacyHandleIceCandidate(data) {
  // 使用 fromClientId 来查找对应的PeerConnection
  console.log('Received ICE candidate from', data.fromClientId);
  const pc = peerConnections.get(data.fromClientId);
  if (pc && data.candidate) {
    // 等待remote description设置完成后再添加ICE候选
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      console.log('Remote description not set yet, will retry...');
      // 延迟重试
      setTimeout(async () => {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log('ICE candidate added (retry)');
        } catch (error) {
          console.error('Error adding ICE candidate (retry):', error);
        }
      }, 100);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log('ICE candidate added successfully');
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  } else {
    console.log('PeerConnection not found for', data.fromClientId);
  }
}

async function createOffer(viewerId) {
  console.log('Host: createOffer for viewerId =', viewerId);
  const pc = createPeerConnection(viewerId, true);

  pc.addEventListener('connectionstatechange', () => {
    console.log(`Connection state [Host->${viewerId}]:`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      startStatsLogging(pc, `Host->Viewer(${viewerId.substr(0, 8)})`);
    }
  });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  setCodecPreferencesForPC(pc);

  const offer = await pc.createOffer();
  let sdp = offer.sdp;

  if (qualitySettings.codecPreference === 'h264') {
    sdp = preferH264Codec(sdp);
  } else if (qualitySettings.codecPreference === 'av1') {
    sdp = preferAV1Codec(sdp);
  }

  await pc.setLocalDescription({
    type: offer.type,
    sdp: sdp
  });

  await setVideoBitrate(pc);

  sendMessage({
    type: 'offer',
    targetId: viewerId,
    sdp: pc.localDescription,
    roomId: currentRoomId
  });
}

async function createOfferToNextViewer(nextViewerId) {
  if (peerConnections.has(nextViewerId)) {
    console.log('Already connected to', nextViewerId);
    return;
  }

  const maxWait = 10000;
  const startTime = Date.now();
  while (!relayStream && Date.now() - startTime < maxWait) {
  console.log('Waiting for relayStream...');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!relayStream) {
    console.error('Timeout waiting for relayStream, cannot create offer');
    showError('无法建立转发连接：等待视频流超时');
    return;
  }

  const pc = createPeerConnection(nextViewerId, true);
  relayPc = pc;

  pc.addEventListener('connectionstatechange', () => {
    console.log(`Connection state [Relay->${nextViewerId}]:`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      startStatsLogging(pc, `Viewer->NextViewer(${nextViewerId.substr(0, 8)})`);
    }
  });

  relayStream.getTracks().forEach((track) => {
    pc.addTrack(track, relayStream);
  });

  setCodecPreferencesForPC(pc);

  const offer = await pc.createOffer();
  let sdp = offer.sdp;

  if (qualitySettings.codecPreference === 'h264') {
    sdp = preferH264Codec(sdp);
  } else if (qualitySettings.codecPreference === 'av1') {
    sdp = preferAV1Codec(sdp);
  }

  await pc.setLocalDescription({
    type: offer.type,
    sdp: sdp
  });

  await setVideoBitrate(pc);

  sendMessage({
    type: 'offer',
    targetId: nextViewerId,
    sdp: pc.localDescription,
    roomId: currentRoomId,
    isRelay: true
  });
}

async function handleOffer(data) {
  const fromId = data.fromClientId;
  console.log('Viewer: received offer from', fromId);

  const pc = createPeerConnection(fromId, false);
  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  await flushRemoteCandidates(fromId, pc);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  sendMessage({
    type: 'answer',
    targetId: fromId,
    sdp: pc.localDescription,
    roomId: currentRoomId
  });
}

async function handleAnswer(data) {
  const fromId = data.fromClientId || data.targetId;
  console.log('handleAnswer: targetId =', data.targetId, ', fromClientId =', data.fromClientId);

  const pc = peerConnections.get(fromId) || peerConnections.get(data.targetId);
  if (!pc) {
    console.log('ERROR: PC not found');
    return;
  }

  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  await flushRemoteCandidates(fromId, pc);
  console.log('Remote description set');
}

async function handleIceCandidate(data) {
  const peerId = data.fromClientId;
  console.log('Received ICE candidate from', peerId);

  if (!data.candidate) {
    return;
  }

  const pc = peerConnections.get(peerId);
  if (!pc) {
    queueRemoteCandidate(peerId, data.candidate);
    console.log('PeerConnection not found yet, candidate queued for', peerId);
    return;
  }

  if (!pc.remoteDescription || !pc.remoteDescription.type) {
    queueRemoteCandidate(peerId, data.candidate);
    console.log('Remote description not set yet, candidate queued for', peerId);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    console.log('ICE candidate added successfully');
  } catch (error) {
    console.error('Error adding ICE candidate:', error);
  }
}

async function checkForUpdates() {
  if (!window.electronAPI || !window.electronAPI.checkForUpdates) {
    return null;
  }

  try {
    renderUpdateModal({
      title: '正在检查更新',
      step: '正在准备更新请求...',
      detail: buildUpdateDiagnosticDetail(`当前版本：v${currentVersion}\n更新源：${getUpdateManifestUrl()}`),
      showProgress: true,
      indeterminate: true,
      speedText: '等待响应',
      transferredText: '清单文件：latest.yml',
      timeText: '正在请求更新元数据'
    });

    console.log('Checking for updates...');
    const result = await window.electronAPI.checkForUpdates();

    if (result && result.devMode) {
      hideUpdateModal();
    }

    return result;
  } catch (error) {
    console.log('Update check failed:', error.message);
    applyUpdateStatus({
      status: 'error',
      currentVersion,
      feedUrl: getUpdateManifestUrl(),
      error: error.message
    });
    return null;
  }
}


async function attemptIceRestart(peerId, meta) {
  if (!meta || !meta.isInitiator || meta.restartInProgress || meta.restartAttempts >= ICE_RESTART_LIMIT) {
    return false;
  }

  const pc = peerConnections.get(peerId);
  if (!pc || pc.signalingState === 'closed' || pc.connectionState === 'closed') {
    return false;
  }

  if (pc.signalingState !== 'stable' || !shouldReconnectPeer(meta.kind)) {
    return false;
  }

  meta.restartAttempts += 1;
  meta.restartInProgress = true;

  try {
    console.log('Attempting ICE restart for', peerId, 'kind=', meta.kind);

    const offer = await pc.createOffer({ iceRestart: true });
    prepareLocalDescription(meta);
    await pc.setLocalDescription({
      type: offer.type,
      sdp: preferAV1Codec(preferH264Codec(offer.sdp))
    });

    await setVideoBitrate(pc);
    await waitForLocalIceWarmup(pc, meta, peerId, 'ice-restart');
    assertActivePeerConnection(peerId, pc);
    armPeerConnectionTimeout(peerId, pc, meta, 'ICE 重启超时，正在重建连接...');

    sendMessage({
      type: 'offer',
      targetId: peerId,
      sdp: pc.localDescription,
      roomId: currentRoomId,
      reconnect: true,
      iceRestart: true,
      isRelay: meta.kind === 'relay-viewer'
    });

    return true;
  } catch (error) {
    meta.restartInProgress = false;
    console.log('ICE restart failed:', peerId, error.message);
    return false;
  }
}

async function handlePeerConnectionFailure(peerId, meta, message) {
  stopStatsLogging();

  if (await attemptIceRestart(peerId, meta)) {
    return;
  }

  if (meta) {
    meta.restartInProgress = false;
  }

  if (!isHost && peerId === upstreamPeerId) {
    resetViewerMediaPipeline(message);
  } else {
    closePeerConnection(peerId);
  }

  if (meta && meta.isInitiator) {
    schedulePeerReconnect(peerId, meta.kind);
  }
}

function stopScreenShare() {
  if (window.electronAPI && window.electronAPI.audioCapture) {
    window.electronAPI.audioCapture.stopCapture().catch(() => {});
  }

  if (typeof audioDataHandler === 'function') {
    audioDataHandler();
  }
  audioDataHandler = null;

  isAudioPlaying = false;
  if (audioTimer) {
    clearTimeout(audioTimer);
    audioTimer = null;
  }
  audioQueue = [];

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioMediaStreamDest = null;

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  if (currentRoomId && sessionRole === 'host') {
    sendMessage({
      type: 'leave-room',
      roomId: currentRoomId,
      clientId: clientId
    }, { queueIfDisconnected: false });
  }

  clearAllPeerConnections({ clearRetryState: true });
  relayPc = null;
  relayStream = null;
  upstreamPeerId = null;
  upstreamConnected = false;
  viewerReadySent = false;
  videoStarted = false;

  sessionRole = null;
  currentRoomId = null;
  hostId = null;
  myChainPosition = -1;
  elements.roomInfo.classList.add('hidden');
  elements.viewerCount.textContent = '0';

  elements.localVideo.srcObject = null;
  elements.localVideo.classList.add('hidden');
  elements.btnStartShare.classList.remove('hidden');
  elements.btnStopShare.classList.add('hidden');
  elements.hostStatus.textContent = '准备就绪';
}

function resetViewerState() {
  currentRoomId = null;
  sessionRole = null;
  hostId = null;
  upstreamPeerId = null;
  myChainPosition = -1;
  viewerReadySent = false;
  videoStarted = false;
  upstreamConnected = false;
  relayPc = null;
  relayStream = null;

  isAudioPlaying = false;
  if (audioTimer) {
    clearTimeout(audioTimer);
    audioTimer = null;
  }
  audioQueue = [];

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioMediaStreamDest = null;

  if (typeof audioDataHandler === 'function') {
    audioDataHandler();
  }
  audioDataHandler = null;

  clearAllPeerConnections({ clearRetryState: true });
  stopStatsLogging();

  elements.joinForm.classList.remove('hidden');
  elements.viewerStatus.classList.add('hidden');
  elements.btnLeave.classList.add('hidden');
  elements.remoteVideo.srcObject = null;
  elements.waitingMessage.classList.remove('hidden');
  elements.connectionStatus.textContent = '等待连接...';
  elements.connectionStatus.classList.remove('connected');
}

async function handleMessage(data) {
  console.log('Received:', data.type);

  switch (data.type) {
    case 'room-created':
      currentRoomId = data.roomId;
      sessionRole = 'host';
      elements.roomIdDisplay.textContent = data.roomId;
      elements.roomInfo.classList.remove('hidden');
      elements.btnStartShare.classList.remove('hidden');
      elements.hostStatus.textContent = '可以开始共享';
      break;

    case 'room-joined':
      currentRoomId = data.roomId;
      sessionRole = 'viewer';
      myChainPosition = data.chainPosition;
      hostId = data.hostId;
      upstreamPeerId = data.upstreamPeerId || data.hostId;
      viewerReadySent = false;
      videoStarted = false;
      upstreamConnected = false;
      elements.joinForm.classList.add('hidden');
      elements.viewerStatus.classList.remove('hidden');
      elements.viewerRoomId.textContent = data.roomId;
      elements.btnLeave.classList.remove('hidden');
      elements.chainPosition.textContent = String(data.chainPosition + 1);
      setViewerConnectionState('等待上游连接...');
      break;

    case 'session-resumed':
      currentRoomId = data.roomId;
      sessionRole = data.role;
      if (data.role === 'host') {
        isHost = true;
        elements.roomIdDisplay.textContent = data.roomId;
        elements.roomInfo.classList.remove('hidden');
        elements.viewerCount.textContent = String(data.viewerCount || 0);
        elements.hostStatus.textContent = '会话已恢复';
      } else {
        isHost = false;
        hostId = data.hostId || hostId;
        upstreamPeerId = data.upstreamPeerId || hostId;
        myChainPosition = data.chainPosition;
        elements.joinForm.classList.add('hidden');
        elements.viewerStatus.classList.remove('hidden');
        elements.viewerRoomId.textContent = data.roomId;
        elements.btnLeave.classList.remove('hidden');
        elements.chainPosition.textContent = String(myChainPosition + 1);
        if (!upstreamConnected) {
          setViewerConnectionState('正在恢复连接...');
        } else {
          elements.connectionStatus.textContent = '已连接';
        }
      }
      break;

    case 'error':
      showError(data.message);
      break;

    case 'viewer-joined':
      if (!data.reconnect) {
        updateViewerCount(data.viewerId);
      }
      if (localStream) {
        await createOffer(data.viewerId, { force: Boolean(data.reconnect) });
      }
      break;

    case 'connect-to-next':
      await createOfferToNextViewer(data.nextViewerId, { force: true });
      break;

    case 'offer':
      await handleOffer(data);
      break;

    case 'answer':
      await handleAnswer(data);
      break;

    case 'ice-candidate':
      await handleIceCandidate(data);
      break;

    case 'host-disconnected':
      showError('分享者已断开连接');
      resetViewerState();
      break;

    case 'viewer-left':
      updateViewerCount(null, data.leftPosition);
      closePeerConnection(data.viewerId, { clearRetryState: true });
      break;

    case 'chain-reconnect':
      myChainPosition = data.newChainPosition;
      upstreamPeerId = data.upstreamPeerId || hostId;
      resetViewerMediaPipeline('正在重建上游连接...');
      elements.chainPosition.textContent = String(myChainPosition + 1);
      break;
  }
}

function createPeerConnection(peerId, isInitiator, kind = 'direct') {
  closePeerConnection(peerId);

  const pc = new RTCPeerConnection(config);
  const meta = {
    isInitiator: Boolean(isInitiator),
    kind,
    hasConnected: false,
    connectTimeoutId: null,
    disconnectTimerId: null,
    localCandidateCount: 0,
    localCandidateTypes: new Set(),
    restartAttempts: 0,
    restartInProgress: false,
    selectedCandidatePairLogged: false
  };

  peerConnections.set(peerId, pc);
  peerConnectionMeta.set(peerId, meta);

  if (meta.isInitiator) {
    armPeerConnectionTimeout(peerId, pc, meta);
  }

  pc.onicegatheringstatechange = () => {
    console.log('ICE gathering state:', pc.iceGatheringState, 'peerId:', peerId);
  };

  pc.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', pc.iceConnectionState, 'peerId:', peerId);
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    const candidateInfo = describeIceCandidate(event.candidate);
    meta.localCandidateCount += 1;
    meta.localCandidateTypes.add(candidateInfo.type);
    console.log('Local ICE candidate:', peerId, candidateInfo.type, candidateInfo.protocol);

    sendMessage({
      type: 'ice-candidate',
      targetId: peerId,
      candidate: event.candidate,
      roomId: currentRoomId
    });
  };

  pc.onicecandidateerror = (event) => {
    console.log('ICE candidate error:', peerId, event.errorText || event.errorCode);
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) {
      return;
    }

    relayStream = stream;

    if (isHost || peerId !== upstreamPeerId) {
      return;
    }

    upstreamConnected = true;
    videoStarted = true;
    clearPeerConnectionTimeout(peerId);
    clearPeerDisconnectTimer(peerId);
    clearPeerReconnect(peerId);

    if (elements.remoteVideo.srcObject !== stream) {
      elements.remoteVideo.srcObject = stream;
    }

    elements.remoteVideo.play().catch((error) => console.log('Play error:', error));
    elements.waitingMessage.classList.add('hidden');
    elements.connectionStatus.textContent = '已连接';
    elements.connectionStatus.classList.add('connected');

    if (myChainPosition >= 0 && !viewerReadySent) {
      viewerReadySent = true;
      sendMessage({
        type: 'viewer-ready',
        roomId: currentRoomId,
        clientId: clientId,
        chainPosition: myChainPosition
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (peerConnections.get(peerId) !== pc) {
      return;
    }

    const state = pc.connectionState;
    console.log('Connection state:', state, 'peerId:', peerId, 'ICE:', pc.iceConnectionState);

    if (state === 'connected') {
      meta.hasConnected = true;
      meta.restartAttempts = 0;
      meta.restartInProgress = false;
      clearPeerConnectionTimeout(peerId);
      clearPeerDisconnectTimer(peerId);
      clearPeerReconnect(peerId);

      const statsLabel = getPeerStatsLabel(peerId, kind);
      if (statsLabel) {
        startStatsLogging(pc, statsLabel);
        if (!meta.selectedCandidatePairLogged) {
          meta.selectedCandidatePairLogged = true;
          logSelectedCandidatePair(pc, statsLabel);
        }
      }
      return;
    }

    if (state === 'connecting') {
      return;
    }

    if (state === 'disconnected') {
      if (!meta.disconnectTimerId) {
        if (!isHost && peerId === upstreamPeerId) {
          setViewerConnectionState('连接不稳定，正在恢复...');
        }

        meta.disconnectTimerId = setTimeout(() => {
          meta.disconnectTimerId = null;
          if (peerConnections.get(peerId) !== pc || pc.connectionState !== 'disconnected') {
            return;
          }

          handlePeerConnectionFailure(peerId, meta, '连接已中断，正在重试...');
        }, PEER_DISCONNECT_GRACE_MS);
      }
      return;
    }

    handlePeerConnectionFailure(peerId, meta, '连接失败，正在重试...');
  };

  return pc;
}

function preferH264Codec(sdp) {
  return sdp;
}

function preferAV1Codec(sdp) {
  return sdp;
}

async function createOffer(viewerId, options = {}) {
  const { force = false } = options;
  const existingPc = peerConnections.get(viewerId);
  if (existingPc && !force && ['new', 'connecting', 'connected'].includes(existingPc.connectionState)) {
    return existingPc;
  }

  if (existingPc) {
    closePeerConnection(viewerId);
  }

  const pc = createPeerConnection(viewerId, true, 'host-viewer');
  const meta = peerConnectionMeta.get(viewerId);

  try {
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    setCodecPreferencesForPC(pc);

    const offer = await pc.createOffer();
    prepareLocalDescription(meta);
    await pc.setLocalDescription({
      type: offer.type,
      sdp: preferAV1Codec(preferH264Codec(offer.sdp))
    });

    await setVideoBitrate(pc);
    await waitForLocalIceWarmup(pc, meta, viewerId, 'host-offer');
    assertActivePeerConnection(viewerId, pc);

    sendMessage({
      type: 'offer',
      targetId: viewerId,
      sdp: pc.localDescription,
      roomId: currentRoomId
    });
    return pc;
  } catch (error) {
    closePeerConnection(viewerId);
    schedulePeerReconnect(viewerId, 'host-viewer');
    throw error;
  }
}

async function createOfferToNextViewer(nextViewerId, options = {}) {
  const { force = false } = options;
  const existingPc = peerConnections.get(nextViewerId);
  if (existingPc && !force && ['new', 'connecting', 'connected'].includes(existingPc.connectionState)) {
    return existingPc;
  }

  if (existingPc) {
    closePeerConnection(nextViewerId);
  }

  const maxWait = 10000;
  const startTime = Date.now();
  while (!relayStream && Date.now() - startTime < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!relayStream) {
    throw new Error('relay-stream-timeout');
  }

  const pc = createPeerConnection(nextViewerId, true, 'relay-viewer');
  const meta = peerConnectionMeta.get(nextViewerId);
  relayPc = pc;

  try {
    relayStream.getTracks().forEach((track) => {
      pc.addTrack(track, relayStream);
    });

    setCodecPreferencesForPC(pc);

    const offer = await pc.createOffer();
    prepareLocalDescription(meta);
    await pc.setLocalDescription({
      type: offer.type,
      sdp: preferAV1Codec(preferH264Codec(offer.sdp))
    });

    await setVideoBitrate(pc);
    await waitForLocalIceWarmup(pc, meta, nextViewerId, 'relay-offer');
    assertActivePeerConnection(nextViewerId, pc);

    sendMessage({
      type: 'offer',
      targetId: nextViewerId,
      sdp: pc.localDescription,
      roomId: currentRoomId,
      isRelay: true
    });
    return pc;
  } catch (error) {
    closePeerConnection(nextViewerId);
    schedulePeerReconnect(nextViewerId, 'relay-viewer');
    throw error;
  }
}

async function handleOffer(data) {
  const fromId = data.fromClientId;

  if (!isHost && upstreamPeerId && upstreamPeerId !== fromId) {
    resetViewerMediaPipeline('正在切换上游连接...');
  }

  if (!isHost) {
    upstreamPeerId = fromId;
  }

  let pc = peerConnections.get(fromId);
  let meta = peerConnectionMeta.get(fromId);
  const canReusePc = pc &&
    meta &&
    meta.kind === 'upstream' &&
    pc.signalingState === 'stable' &&
    pc.connectionState !== 'failed';

  if (!canReusePc) {
    pc = createPeerConnection(fromId, false, 'upstream');
    meta = peerConnectionMeta.get(fromId);
  } else {
    clearPeerConnectionTimeout(fromId);
    clearPeerDisconnectTimer(fromId);
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushRemoteCandidates(fromId, pc);

    const answer = await pc.createAnswer();
    prepareLocalDescription(meta);
    await pc.setLocalDescription(answer);
    await waitForLocalIceWarmup(pc, meta, fromId, 'answer');
    assertActivePeerConnection(fromId, pc);

    sendMessage({
      type: 'answer',
      targetId: fromId,
      sdp: pc.localDescription,
      roomId: currentRoomId
    });
  } catch (error) {
    closePeerConnection(fromId);
    throw error;
  }
}

async function handleAnswer(data) {
  const fromId = data.fromClientId || data.targetId;
  const peerId = peerConnections.has(fromId) ? fromId : data.targetId;
  const pc = peerConnections.get(peerId);
  if (!pc) {
    return;
  }

  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  await flushRemoteCandidates(peerId, pc);

  const meta = peerConnectionMeta.get(peerId);
  if (meta && meta.restartInProgress && pc.connectionState === 'connected') {
    meta.restartInProgress = false;
    clearPeerConnectionTimeout(peerId);

    const statsLabel = getPeerStatsLabel(peerId, meta.kind);
    if (statsLabel) {
      logSelectedCandidatePair(pc, statsLabel);
    }
  }
}

async function handleIceCandidate(data) {
  const peerId = data.fromClientId;
  if (!data.candidate) {
    return;
  }

  const pc = peerConnections.get(peerId);
  if (!pc) {
    queueRemoteCandidate(peerId, data.candidate);
    return;
  }

  if (!pc.remoteDescription || !pc.remoteDescription.type) {
    queueRemoteCandidate(peerId, data.candidate);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (error) {
    console.error('Failed to add ICE candidate:', peerId, error);
  }
}
