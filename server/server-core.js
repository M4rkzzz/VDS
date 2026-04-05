const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

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

function startServer(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const port = Number(options.port || process.env.PORT || 3000);
  const disconnectGraceMs = Number(process.env.DISCONNECT_GRACE_MS || 30000);
  const appVersion = resolveAppVersion(baseDir);
  const iceServers = buildIceServers();
  const publicDir = resolveExistingPath([
    options.publicDir,
    path.join(baseDir, 'public'),
    path.resolve(baseDir, '../public')
  ]);
  const updatesDir = resolveExistingPath([
    options.updatesDir,
    path.join(baseDir, 'updates'),
    path.resolve(baseDir, '../server/updates')
  ]);

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });
  const rooms = new Map();

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
    }
    next();
  });

  if (publicDir) {
    app.use(express.static(publicDir));
  }

  if (updatesDir) {
    app.use('/updates', express.static(updatesDir));
  }

  app.get('/api/config', (_req, res) => {
    res.json({
      version: appVersion,
      iceServers,
      disconnectGraceMs
    });
  });

  app.get('/api/version', (_req, res) => {
    res.json({
      version: appVersion,
      disconnectGraceMs
    });
  });

  wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleMessage(ws, data);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws, false);
    });
  });

  function handleMessage(ws, data) {
    switch (data.type) {
      case 'create-room':
        handleCreateRoom(ws, data);
        break;
      case 'join-room':
        handleJoinRoom(ws, data);
        break;
      case 'resume-session':
        handleResumeSession(ws, data);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'candidate':
        forwardMessage(ws, data);
        break;
      case 'viewer-ready':
        handleViewerReady(ws, data);
        break;
      case 'leave-room':
        handleDisconnect(ws, true);
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  }

  function handleCreateRoom(ws, data) {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      host: {
        clientId: data.clientId,
        ws: ws,
        disconnectTimer: null
      },
      viewers: [],
      createdAt: Date.now()
    };

    rooms.set(roomId, room);
    attachSocketMetadata(ws, roomId, data.clientId, 'host');

    sendJson(ws, {
      type: 'room-created',
      roomId: roomId,
      clientId: data.clientId
    });

    console.log(`Room created: ${roomId} by ${data.clientId}`);
  }

  function handleJoinRoom(ws, data) {
    const { roomId, clientId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      sendJson(ws, {
        type: 'error',
        code: 'room-not-found',
        message: 'Room not found'
      });
      return;
    }

    const existingViewer = room.viewers.find((candidate) => candidate.clientId === clientId);
    if (existingViewer) {
      const rebindRequired = existingViewer.ws !== ws;
      clearDisconnectTimer(existingViewer);
      existingViewer.ws = ws;
      attachSocketMetadata(ws, roomId, clientId, 'viewer');

      if (rebindRequired) {
        sendJson(ws, {
          type: 'room-joined',
          roomId,
          clientId,
          hostId: room.host.clientId,
          upstreamPeerId: resolveViewerUpstreamId(room, existingViewer.chainPosition),
          chainPosition: existingViewer.chainPosition,
          isFirstViewer: existingViewer.chainPosition === 0
        });

        if (!existingViewer.mediaReady || !existingViewer.relayEstablished) {
          requestViewerReconnect(room, existingViewer);
        }
      }
      return;
    }

    const chainPosition = room.viewers.length;
    const viewer = {
      clientId,
      ws,
      chainPosition,
      mediaReady: false,
      relayEstablished: false,
      connectRequestPending: false,
      disconnectTimer: null
    };

    room.viewers.push(viewer);
    attachSocketMetadata(ws, roomId, clientId, 'viewer');

    sendJson(ws, {
      type: 'room-joined',
      roomId,
      clientId,
      hostId: room.host.clientId,
      upstreamPeerId: resolveViewerUpstreamId(room, chainPosition),
      chainPosition,
      isFirstViewer: chainPosition === 0
    });

    if (chainPosition === 0) {
      notifyHostToConnectViewer(room, viewer, false);
      return;
    }

    const previousViewer = room.viewers[chainPosition - 1];
    if (previousViewer && previousViewer.mediaReady && isSocketOpen(previousViewer.ws)) {
      notifyViewerToConnectNext(room, previousViewer, viewer);
    }
  }

  function handleResumeSession(ws, data) {
    const room = rooms.get(data.roomId);
    if (!room) {
      sendJson(ws, {
        type: 'error',
        code: 'session-not-found',
        message: 'Session not found'
      });
      return;
    }

    if (data.role === 'host' && room.host.clientId === data.clientId) {
      clearDisconnectTimer(room.host);
      room.host.ws = ws;
      attachSocketMetadata(ws, room.id, data.clientId, 'host');
      sendJson(ws, {
        type: 'session-resumed',
        role: 'host',
        roomId: room.id,
        viewerCount: room.viewers.length
      });
      return;
    }

    const viewer = room.viewers.find((candidate) => candidate.clientId === data.clientId);
    if (!viewer) {
      sendJson(ws, {
        type: 'error',
        code: 'session-not-found',
        message: 'Session not found'
      });
      return;
    }

    clearDisconnectTimer(viewer);
    viewer.ws = ws;
    if (data.needsMediaReconnect) {
      viewer.mediaReady = false;
      viewer.relayEstablished = false;
    }
    attachSocketMetadata(ws, room.id, data.clientId, 'viewer');
    sendJson(ws, {
      type: 'session-resumed',
      role: 'viewer',
      roomId: room.id,
      hostId: room.host.clientId,
      upstreamPeerId: resolveViewerUpstreamId(room, viewer.chainPosition),
      chainPosition: viewer.chainPosition,
      viewerCount: room.viewers.length
    });

    if (data.needsMediaReconnect) {
      requestViewerReconnect(room, viewer);
    }
  }

  function handleViewerReady(ws, data) {
    const room = rooms.get(ws.roomId);
    if (!room) {
      return;
    }

    const viewer = room.viewers.find((candidate) => candidate.clientId === ws.clientId);
    if (!viewer) {
      return;
    }
    if (Number(data.chainPosition) !== viewer.chainPosition) {
      return;
    }

    if (viewer.mediaReady && viewer.relayEstablished) {
      return;
    }

    viewer.mediaReady = true;
    viewer.relayEstablished = true;
    viewer.connectRequestPending = false;

    const nextViewer = room.viewers[data.chainPosition + 1];
    if (nextViewer && isSocketOpen(ws)) {
      notifyViewerToConnectNext(room, viewer, nextViewer);
    }
  }

  function forwardMessage(ws, data) {
    const room = rooms.get(ws.roomId);
    if (!room) {
      return;
    }

    let targetWs = null;
    if (ws.role === 'host') {
      const viewer = room.viewers.find((candidate) => candidate.clientId === data.targetId);
      targetWs = viewer ? viewer.ws : null;
    } else if (ws.role === 'viewer') {
      const viewer = room.viewers.find((candidate) => candidate.clientId === ws.clientId);
      if (!viewer) {
        return;
      }

      if (data.targetId === 'host' || data.targetId === room.host.clientId || data.toHost) {
        const expectedUpstreamId = resolveViewerUpstreamId(room, viewer.chainPosition);
        if (expectedUpstreamId !== room.host.clientId) {
          return;
        }
        targetWs = room.host.ws;
      } else {
        const expectedUpstreamId = resolveViewerUpstreamId(room, viewer.chainPosition);
        const nextViewer = room.viewers[viewer.chainPosition + 1];
        const isAllowedTarget =
          data.targetId === expectedUpstreamId ||
          (nextViewer && data.targetId === nextViewer.clientId);
        if (!isAllowedTarget) {
          return;
        }

        const targetViewer = room.viewers.find((candidate) => candidate.clientId === data.targetId);
        targetWs = targetViewer ? targetViewer.ws : null;
      }
    }

    if (!isSocketOpen(targetWs)) {
      return;
    }

    if (!data.fromClientId) {
      data.fromClientId = ws.clientId;
    }

    sendJson(targetWs, data);
  }

  function handleDisconnect(ws, immediate) {
    if (!ws.roomId) {
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) {
      return;
    }

    if (ws.role === 'host') {
      if (room.host.ws !== ws) {
        return;
      }

      if (immediate) {
        finalizeHostDisconnect(room);
        return;
      }

      room.host.ws = null;
      scheduleDisconnectTimer(room.host, () => {
        finalizeHostDisconnect(room);
      }, disconnectGraceMs);
      return;
    }

    if (ws.role === 'viewer') {
      const viewer = room.viewers.find((candidate) => candidate.clientId === ws.clientId);
      if (!viewer || viewer.ws !== ws) {
        return;
      }

      if (immediate) {
        finalizeViewerDisconnect(room, viewer.clientId);
        return;
      }

      viewer.ws = null;
      scheduleDisconnectTimer(viewer, () => {
        finalizeViewerDisconnect(room, viewer.clientId);
      }, disconnectGraceMs);
    }
  }

  function finalizeHostDisconnect(room) {
    clearDisconnectTimer(room.host);
    room.viewers.forEach((viewer) => {
      if (isSocketOpen(viewer.ws)) {
        sendJson(viewer.ws, { type: 'host-disconnected' });
      }
      clearDisconnectTimer(viewer);
    });
    rooms.delete(room.id);
  }

  function finalizeViewerDisconnect(room, clientId) {
    const viewerIndex = room.viewers.findIndex((viewer) => viewer.clientId === clientId);
    if (viewerIndex === -1) {
      return;
    }

    const upstreamViewer =
      viewerIndex > 0 && viewerIndex - 1 < room.viewers.length
        ? room.viewers[viewerIndex - 1]
        : null;
    const [viewer] = room.viewers.splice(viewerIndex, 1);
    clearDisconnectTimer(viewer);

    const leftPosition = viewer.chainPosition;
    room.viewers.forEach((candidate, index) => {
      candidate.chainPosition = index;
      candidate.connectRequestPending = false;
    });

    if (isSocketOpen(room.host.ws)) {
      sendJson(room.host.ws, {
        type: 'viewer-left',
        viewerId: clientId,
        leftPosition
      });
    }

    if (upstreamViewer && isSocketOpen(upstreamViewer.ws)) {
      sendJson(upstreamViewer.ws, {
        type: 'viewer-left',
        viewerId: clientId,
        leftPosition
      });
    }

    for (let index = leftPosition; index < room.viewers.length; index += 1) {
      const candidate = room.viewers[index];
      candidate.mediaReady = false;
      candidate.relayEstablished = false;
      if (isSocketOpen(candidate.ws)) {
        sendJson(candidate.ws, {
          type: 'chain-reconnect',
          newChainPosition: index,
          upstreamPeerId: resolveViewerUpstreamId(room, index)
        });
      }
    }

    if (room.viewers.length === 0) {
      return;
    }

    if (leftPosition === 0) {
      notifyHostToConnectViewer(room, room.viewers[0], true);
      return;
    }

    if (leftPosition < room.viewers.length) {
      const previousViewer = room.viewers[leftPosition - 1];
      const nextViewer = room.viewers[leftPosition];
      if (previousViewer && nextViewer && previousViewer.mediaReady && isSocketOpen(previousViewer.ws)) {
        notifyViewerToConnectNext(room, previousViewer, nextViewer);
      }
    }
  }

function notifyHostToConnectViewer(room, viewer, reconnect) {
  if (!isSocketOpen(room.host.ws) || !viewer) {
    return;
  }

  if (viewer.connectRequestPending) {
    return;
  }

  viewer.connectRequestPending = true;
  sendJson(room.host.ws, {
    type: 'viewer-joined',
    viewerId: viewer.clientId,
    viewerChainPosition: viewer.chainPosition,
    reconnect
  });
}

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });

  return { app, server, wss, rooms };
}

function requestViewerReconnect(room, viewer) {
  if (!viewer) {
    return;
  }

  viewer.mediaReady = false;
  viewer.relayEstablished = false;
  viewer.connectRequestPending = false;

  if (viewer.chainPosition === 0) {
    notifyHostToConnectViewer(room, viewer, true);
    return;
  }

  const previousViewer = room.viewers[viewer.chainPosition - 1];
  if (previousViewer && previousViewer.mediaReady && isSocketOpen(previousViewer.ws)) {
    notifyViewerToConnectNext(room, previousViewer, viewer);
  }
}

function notifyViewerToConnectNext(room, previousViewer, nextViewer) {
  if (!room || !previousViewer || !nextViewer || !isSocketOpen(previousViewer.ws)) {
    return;
  }

  if (nextViewer.mediaReady || nextViewer.relayEstablished || nextViewer.connectRequestPending) {
    return;
  }

  nextViewer.connectRequestPending = true;
  sendJson(previousViewer.ws, {
    type: 'connect-to-next',
    nextViewerId: nextViewer.clientId,
    nextViewerChainPosition: nextViewer.chainPosition
  });
}

function attachSocketMetadata(ws, roomId, clientId, role) {
  ws.roomId = roomId;
  ws.clientId = clientId;
  ws.role = role;
}

function buildIceServers() {
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = sanitizeIceServers(JSON.parse(process.env.ICE_SERVERS_JSON));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (error) {
      console.error('Invalid ICE_SERVERS_JSON:', error.message);
    }
  }

  const iceServers = sanitizeIceServers(DEFAULT_ICE_SERVERS);
  if (process.env.TURN_URL) {
    iceServers.unshift({
      urls: process.env.TURN_URL.split(',').map((value) => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || ''
    });
  }

  return iceServers;
}

function normalizeIceUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

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

function clearDisconnectTimer(participant) {
  if (participant && participant.disconnectTimer) {
    clearTimeout(participant.disconnectTimer);
    participant.disconnectTimer = null;
  }
}

function scheduleDisconnectTimer(participant, callback, delayMs) {
  clearDisconnectTimer(participant);
  participant.disconnectTimer = setTimeout(() => {
    participant.disconnectTimer = null;
    callback();
  }, delayMs);
}

function sendJson(ws, payload) {
  if (isSocketOpen(ws)) {
    ws.send(JSON.stringify(payload));
  }
}

function isSocketOpen(ws) {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function resolveAppVersion(baseDir) {
  const candidates = [
    path.join(baseDir, 'package.json'),
    path.resolve(baseDir, '../package.json')
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch (_error) {
      // Ignore malformed package metadata and keep searching.
    }
  }

  return '0.0.0';
}

function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveViewerUpstreamId(room, chainPosition) {
  if (chainPosition <= 0) {
    return room.host.clientId;
  }

  const previousViewer = room.viewers[chainPosition - 1];
  return previousViewer ? previousViewer.clientId : room.host.clientId;
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = {
  startServer
};
