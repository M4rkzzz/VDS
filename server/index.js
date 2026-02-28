const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

// 房间管理
const rooms = new Map(); // roomId -> { host, viewers: [], created: timestamp }

// WebSocket连接处理
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

// 处理消息
function handleMessage(ws, data) {
  console.log('Received:', data.type);

  switch (data.type) {
    case 'create-room':
      handleCreateRoom(ws, data);
      break;
    case 'join-room':
      handleJoinRoom(ws, data);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      forwardMessage(ws, data);
      break;
    case 'relay-request':
      handleRelayRequest(ws, data);
      break;
    case 'viewer-ready':
      handleViewerReady(ws, data);
      break;
    case 'leave-room':
      handleLeaveRoom(ws, data);
      break;
    default:
      console.log('Unknown message type:', data.type);
  }
}

// 创建房间
function handleCreateRoom(ws, data) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    host: ws,
    hostId: data.clientId,
    viewers: [],
    created: Date.now()
  };
  rooms.set(roomId, room);

  ws.roomId = roomId;
  ws.clientId = data.clientId;
  ws.role = 'host';

  ws.send(JSON.stringify({
    type: 'room-created',
    roomId: roomId,
    clientId: data.clientId
  }));

  console.log(`Room created: ${roomId} by ${data.clientId}`);
}

// 加入房间
function handleJoinRoom(ws, data) {
  const { roomId, clientId } = data;
  const room = rooms.get(roomId);

  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room not found'
    }));
    return;
  }

  ws.roomId = roomId;
  ws.clientId = clientId;
  ws.role = 'viewer';

  // 确定在链中的位置
  const chainPosition = room.viewers.length;

  // 添加到观看者列表
  room.viewers.push({
    ws: ws,
    clientId: clientId,
    chainPosition: chainPosition,
    connected: false
  });

  // 通知加入成功
  ws.send(JSON.stringify({
    type: 'room-joined',
    roomId: roomId,
    clientId: clientId,
    hostId: room.hostId,  // 告诉观众Host的ID
    chainPosition: chainPosition,
    isFirstViewer: chainPosition === 0
  }));

  // 通知相关人员建立连接
  if (chainPosition === 0) {
    // 第一个观众加入，通知Host
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({
        type: 'viewer-joined',
        viewerId: clientId,
        viewerChainPosition: 0
      }));
    }
  } else {
    // 第N个观众加入，通知第N-1个观众作为Relay连接到新观众
    const prevViewer = room.viewers[chainPosition - 1];
    if (prevViewer && prevViewer.ws && prevViewer.ws.readyState === WebSocket.OPEN) {
      prevViewer.ws.send(JSON.stringify({
        type: 'connect-to-next',
        nextViewerId: clientId,
        nextViewerChainPosition: chainPosition
      }));
    }
  }

  console.log(`Viewer ${clientId} joined room ${roomId} at position ${chainPosition}`);
}

// 处理转发请求
function handleRelayRequest(ws, data) {
  const room = rooms.get(ws.roomId);
  if (!room) return;

  const { nextViewerId } = data;
  const nextViewer = room.viewers.find(v => v.clientId === nextViewerId);

  if (nextViewer && nextViewer.ws && nextViewer.ws.readyState === WebSocket.OPEN) {
    nextViewer.ws.send(JSON.stringify({
      type: 'relay-offer-request',
      fromViewerId: ws.clientId
    }));
  }
}

// 处理观众准备就绪
function handleViewerReady(ws, data) {
  const room = rooms.get(ws.roomId);
  if (!room) return;

  const viewer = room.viewers.find(v => v.clientId === ws.clientId);
  if (viewer) {
    // 如果已经通知过上一个节点，不再重复通知
    if (viewer.relayEstablished) {
      console.log(`Viewer ${ws.clientId} already has relay, skipping`);
      return;
    }
    viewer.connected = true;
    viewer.relayEstablished = true; // 标记已建立中继
  }

  // 告诉上一个节点连接这个观众（建立中继）
  if (data.chainPosition > 0) {
    const prevViewer = room.viewers[data.chainPosition - 1];
    if (prevViewer && prevViewer.ws && prevViewer.ws.readyState === WebSocket.OPEN) {
      prevViewer.ws.send(JSON.stringify({
        type: 'connect-to-next',
        nextViewerId: ws.clientId,
        nextViewerChainPosition: data.chainPosition
      }));
    }
  }
}

// 转发WebRTC消息
function forwardMessage(ws, data) {
  const room = rooms.get(ws.roomId);
  if (!room) return;

  const targetId = data.targetId;
  let targetWs = null;

  if (ws.role === 'host') {
    // Host转发给指定观众
    const viewer = room.viewers.find(v => v.clientId === targetId);
    if (viewer) {
      targetWs = viewer.ws;
      console.log(`Forwarding from Host to viewer: ${targetId}`);
    }
  } else if (ws.role === 'viewer') {
    // 观众转发给Host或下一个观众
    // 检查是否是发给Host（支持targetId === 'host' 或 targetId === room.hostId）
    if (targetId === 'host' || targetId === room.hostId || data.toHost) {
      targetWs = room.host;
      console.log(`Forwarding from viewer ${ws.clientId} to Host`);
    } else if (targetId) {
      // 转发给另一个观众
      const targetViewer = room.viewers.find(v => v.clientId === targetId);
      if (targetViewer) {
        targetWs = targetViewer.ws;
        console.log(`Forwarding from viewer ${ws.clientId} to viewer: ${targetId}`);
      }
    }
  }

  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    // 添加发送者信息（不要覆盖已有的targetId）
    if (!data.fromClientId) {
      data.fromClientId = ws.clientId;
    }
    console.log(`Forwarding ${data.type}: from=${ws.clientId}, targetId=${data.targetId}, fromClientId=${data.fromClientId}`);
    targetWs.send(JSON.stringify(data));
  } else {
    console.log(`Failed to forward: targetWs=${!!targetWs}, readyState=${targetWs?.readyState}, targetId=${targetId}`);
  }
}

// 处理离开房间
function handleLeaveRoom(ws, data) {
  handleDisconnect(ws);
}

// 处理断开连接
function handleDisconnect(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  if (ws.role === 'host') {
    // Host离开，关闭房间
    console.log(`Host left room ${ws.roomId}`);
    room.viewers.forEach(viewer => {
      if (viewer.ws && viewer.ws.readyState === WebSocket.OPEN) {
        viewer.ws.send(JSON.stringify({ type: 'host-disconnected' }));
      }
    });
    rooms.delete(ws.roomId);
  } else if (ws.role === 'viewer') {
    // 观众离开
    const viewerIndex = room.viewers.findIndex(v => v.clientId === ws.clientId);
    if (viewerIndex !== -1) {
      const leftPosition = room.viewers[viewerIndex].chainPosition;
      room.viewers.splice(viewerIndex, 1);

      // 重新调整链位置
      room.viewers.forEach((v, i) => {
        v.chainPosition = i;
      });

      // 通知相关人员
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: 'viewer-left',
          viewerId: ws.clientId,
          leftPosition: leftPosition
        }));
      }

      // 通知后面的观众重新连接
      for (let i = leftPosition; i < room.viewers.length; i++) {
        const viewer = room.viewers[i];
        if (viewer.ws && viewer.ws.readyState === WebSocket.OPEN) {
          viewer.ws.send(JSON.stringify({
            type: 'chain-reconnect',
            newChainPosition: i
          }));
        }
      }

      // 如果有下一个观众，通知其连接前一个
      if (leftPosition < room.viewers.length && leftPosition > 0) {
        const nextViewer = room.viewers[leftPosition];
        const prevViewer = room.viewers[leftPosition - 1];
        if (nextViewer && nextViewer.ws && nextViewer.ws.readyState === WebSocket.OPEN &&
            prevViewer && prevViewer.ws && prevViewer.ws.readyState === WebSocket.OPEN) {
          prevViewer.ws.send(JSON.stringify({
            type: 'connect-to-next',
            nextViewerId: nextViewer.clientId,
            nextViewerChainPosition: leftPosition
          }));
        }
      }

      console.log(`Viewer ${ws.clientId} left room ${ws.roomId} at position ${leftPosition}`);
    }
  }
}

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
