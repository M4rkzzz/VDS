// 生成客户端ID
const clientId = 'client_' + Math.random().toString(36).substring(2, 11);

// WebSocket连接
let ws = null;
let wsConnected = false;

// 状态
let isHost = false;
let currentRoomId = null;
let localStream = null;
let myChainPosition = -1; // 观众在链中的位置
let hostId = null; // Host的clientId

// WebRTC连接管理
// Host侧: viewerId -> RTCPeerConnection
// Viewer侧: 最多2个连接 - 前一个(prev)和下一个(next)
const peerConnections = new Map();
let relayPc = null; // 转发给下一个观众的PC
let relayStream = null; // 收到的视频流，用于转发
let viewerReadySent = false; // 防止重复发送viewer-ready
let videoStarted = false; // 防止重复播放

// ICE服务器配置 - 国内STUN服务器
const iceServers = [
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.aliyun.com:3478' },
  { urls: 'stun:stun.huawei.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.voipbuster.com:3478' }
];

const config = {
  iceServers: iceServers
};

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
  joinForm: document.getElementById('join-form')
};

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

// 页面导航
function showHostPanel() {
  elements.modeSelect.classList.add('hidden');
  elements.hostPanel.classList.remove('hidden');
  isHost = true;
  elements.hostStatus.textContent = '正在连接...';
  elements.hostStatus.classList.add('waiting');
  connectWebSocket();
}

function showViewerPanel() {
  elements.modeSelect.classList.add('hidden');
  elements.viewerPanel.classList.remove('hidden');
  isHost = false;
  elements.connectionStatus.textContent = '正在连接...';
  connectWebSocket();
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
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    console.log('WebSocket connected');
    wsConnected = true;
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    await handleMessage(data);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showError('连接失败，请刷新页面重试');
  };
}

function disconnectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
  wsConnected = false;
}

// 等待WebSocket连接
function waitForWsConnected() {
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
function sendMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// 处理WebSocket消息
async function handleMessage(data) {
  console.log('Received:', data.type);

  switch (data.type) {
    case 'room-created':
      currentRoomId = data.roomId;
      elements.roomIdDisplay.textContent = data.roomId;
      elements.roomInfo.classList.remove('hidden');
      elements.btnStartShare.classList.remove('hidden');
      elements.hostStatus.textContent = '等待开始共享';
      break;

    case 'room-joined':
      currentRoomId = data.roomId;
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
      updateViewerCount(data.viewerId);
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

// Host: 开始屏幕共享
async function startScreenShare() {
  try {
    // 等待WebSocket连接
    await waitForWsConnected();

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 }
      },
      audio: true,
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false
    });

    localStream = stream;
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

// Host: 停止屏幕共享
function stopScreenShare() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  peerConnections.forEach((pc, id) => {
    pc.close();
  });
  peerConnections.clear();

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
  });

  peerConnections.forEach((pc) => {
    pc.close();
  });
  peerConnections.clear();

  resetViewerState();
}

// 重置Viewer状态
function resetViewerState() {
  currentRoomId = null;
  myChainPosition = -1;
  viewerReadySent = false;
  videoStarted = false;
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
function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(config);

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
    }

    // 显示视频（只播放一次）
    if (!videoStarted && stream.getVideoTracks().length > 0) {
      videoStarted = true;
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
    console.log('Connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      console.log('WebRTC connected with', peerId);
      elements.connectionStatus.textContent = '已连接';
      elements.connectionStatus.classList.add('connected');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      console.log('WebRTC connection failed:', pc.connectionState);
      elements.connectionStatus.textContent = '连接失败';
      elements.connectionStatus.classList.remove('connected');
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

// Host: 创建offer给观众
async function createOffer(viewerId) {
  console.log('Host: createOffer for viewerId =', viewerId);
  const pc = createPeerConnection(viewerId, true);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sendMessage({
    type: 'offer',
    targetId: viewerId,
    sdp: pc.localDescription,
    roomId: currentRoomId
  });
}

// 观众: 连接到下一个观众（作为Relay）
async function createOfferToNextViewer(nextViewerId) {
  // 防止重复创建
  if (peerConnections.has(nextViewerId)) {
    console.log('Already connected to', nextViewerId);
    return;
  }

  const pc = createPeerConnection(nextViewerId, true);
  relayPc = pc; // 保存转发PC的引用

  // 如果已经收到了视频流，先添加track
  if (relayStream) {
    console.log('Adding track to relay PC BEFORE offer');
    relayStream.getTracks().forEach(track => {
      pc.addTrack(track, relayStream);
    });
  } else {
    console.log('No relay stream yet, will add later');
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sendMessage({
    type: 'offer',
    targetId: nextViewerId,
    sdp: pc.localDescription,
    roomId: currentRoomId,
    isRelay: true
  });
}

// 收到offer
async function handleOffer(data) {
  const fromId = data.fromClientId;
  console.log('Viewer: received offer from', fromId);
  const pc = createPeerConnection(fromId, false);

  // createPeerConnection already sets up ontrack handler

  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  console.log('Viewer: sending answer to', fromId);
  sendMessage({
    type: 'answer',
    targetId: fromId,
    sdp: pc.localDescription,
    roomId: currentRoomId
  });
}

// 收到answer
async function handleAnswer(data) {
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
async function handleIceCandidate(data) {
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
