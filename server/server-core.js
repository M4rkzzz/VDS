const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERBOSE_SERVER_LOGS = process.env.VDS_VERBOSE_SERVER_LOGS === '1';
const serverLogRateLimitState = new Map();
const DEFAULT_MAX_WS_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_ROOMS = 128;
const DEFAULT_MAX_VIEWERS_PER_ROOM = 16;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 120;
const DEFAULT_MESSAGE_RATE_WINDOW_MS = 10000;
const MAX_ID_LENGTH = 128;
const MAX_SIGNAL_FIELD_LENGTH = 65536;

function logServerDebug(...args) {
  if (VERBOSE_SERVER_LOGS) {
    console.log(...args);
  }
}

function logServerInfo(...args) {
  console.log(...args);
}

function shouldEmitServerLog(key, intervalMs = 5000) {
  if (VERBOSE_SERVER_LOGS || intervalMs <= 0) {
    return { emit: true, suppressed: 0 };
  }

  const now = Date.now();
  const state = serverLogRateLimitState.get(key) || { lastAt: 0, suppressed: 0 };
  if (now - state.lastAt < intervalMs) {
    state.suppressed += 1;
    serverLogRateLimitState.set(key, state);
    return { emit: false, suppressed: state.suppressed };
  }

  const suppressed = state.suppressed;
  serverLogRateLimitState.set(key, { lastAt: now, suppressed: 0 });
  return { emit: true, suppressed };
}

function logServerWarning(key, message, error, intervalMs = 5000) {
  const rate = shouldEmitServerLog(key, intervalMs);
  if (!rate.emit) {
    return;
  }

  const suffix = rate.suppressed ? `suppressed=${rate.suppressed}` : '';
  console.error(message, error, suffix);
}

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
  const disconnectGraceMs = normalizePositiveInt(options.disconnectGraceMs || process.env.DISCONNECT_GRACE_MS, 30000);
  const maxPayload = normalizePositiveInt(options.maxPayload || process.env.WS_MAX_PAYLOAD_BYTES, DEFAULT_MAX_WS_PAYLOAD_BYTES);
  const maxConnections = normalizePositiveInt(options.maxConnections || process.env.WS_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS);
  const maxRooms = normalizePositiveInt(options.maxRooms || process.env.WS_MAX_ROOMS, DEFAULT_MAX_ROOMS);
  const maxViewersPerRoom = normalizePositiveInt(options.maxViewersPerRoom || process.env.WS_MAX_VIEWERS_PER_ROOM, DEFAULT_MAX_VIEWERS_PER_ROOM);
  const maxMessagesPerWindow = normalizePositiveInt(options.maxMessagesPerWindow || process.env.WS_MAX_MESSAGES_PER_WINDOW, DEFAULT_MAX_MESSAGES_PER_WINDOW);
  const messageRateWindowMs = normalizePositiveInt(options.messageRateWindowMs || process.env.WS_MESSAGE_RATE_WINDOW_MS, DEFAULT_MESSAGE_RATE_WINDOW_MS);
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
  const wss = new WebSocket.Server({ server, maxPayload });
  const rooms = new Map();
  let activeConnections = 0;

  logServerInfo('[server limits]', {
    maxPayload,
    maxConnections,
    maxRooms,
    maxViewersPerRoom,
    maxMessagesPerWindow,
    messageRateWindowMs,
    disconnectGraceMs
  });

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
    app.get('/', (req, res, next) => {
      const webEntry = path.join(publicDir, 'vds_web', 'index.html');
      if (!isElectronUserAgent(req) && fs.existsSync(webEntry)) {
        res.sendFile(webEntry);
        return;
      }
      next();
    });
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

  app.get('/api/public-rooms', (_req, res) => {
    res.json({
      rooms: buildPublicRoomSummaryList(rooms)
    });
  });

  wss.on('connection', (ws) => {
    if (activeConnections >= maxConnections) {
      sendJson(ws, {
        type: 'error',
        code: 'server-busy',
        message: 'Server connection limit reached'
      });
      ws.close(1013, 'server-busy');
      return;
    }

    activeConnections += 1;
    ws.__vdsRateWindowStartedAt = Date.now();
    ws.__vdsRateWindowCount = 0;
    logServerDebug('New WebSocket connection');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (!validateInboundMessage(ws, data, maxMessagesPerWindow, messageRateWindowMs)) {
          return;
        }
        handleMessage(ws, data);
      } catch (error) {
        logServerWarning('ws-message-parse', 'Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      activeConnections = Math.max(0, activeConnections - 1);
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
      case 'host-media-manifest':
        handleHostMediaManifest(ws, data);
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
      case 'viewer-reconnect-ready':
        handleViewerReconnectReady(ws, data);
        break;
      case 'leave-room':
        handleDisconnect(ws, true);
        break;
      default:
        logServerDebug('Unknown message type:', data.type);
    }
  }

  function handleCreateRoom(ws, data) {
    if (rooms.size >= maxRooms) {
      sendJson(ws, {
        type: 'error',
        code: 'room-limit-reached',
        message: 'Room limit reached'
      });
      return;
    }

    const roomId = generateRoomId(rooms);
    const hostToken = generateSessionToken();
    const mediaManifest = sanitizeMediaManifest(data.mediaManifest);
    const room = {
      id: roomId,
      publicListing: data.publicListing === true,
      mediaManifest,
      host: {
        clientId: data.clientId,
        sessionToken: hostToken,
        mediaCapabilities: sanitizeMediaCapabilities(data.mediaCapabilities),
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
      clientId: data.clientId,
      sessionToken: hostToken,
      publicListing: room.publicListing,
      mediaManifest: room.mediaManifest
    });

    logServerDebug(`Room created: ${roomId} by ${data.clientId}`);
  }

  function handleJoinRoom(ws, data) {
    const { roomId, clientId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      sendJson(ws, {
        type: 'error',
        code: 'room-not-found',
        message: '该房间已不存在'
      });
      return;
    }
    if (!room.mediaManifest) {
      sendJson(ws, {
        type: 'error',
        code: 'host-media-manifest-missing',
        message: 'Host media manifest is not ready'
      });
      return;
    }

    const existingViewer = room.viewers.find((candidate) => candidate.clientId === clientId);
    if (existingViewer) {
      if (!isValidSessionToken(existingViewer.sessionToken, data.sessionToken)) {
        sendJson(ws, {
          type: 'error',
          code: 'session-token-invalid',
          message: 'Session token is invalid'
        });
        return;
      }

      const rebindRequired = existingViewer.ws !== ws;
      clearDisconnectTimer(existingViewer);
      existingViewer.ws = ws;
      existingViewer.mediaCapabilities = sanitizeMediaCapabilities(data.mediaCapabilities) || existingViewer.mediaCapabilities;
      attachSocketMetadata(ws, roomId, clientId, 'viewer');

      if (rebindRequired) {
        sendJson(ws, {
          type: 'room-joined',
          roomId,
          clientId,
          sessionToken: existingViewer.sessionToken,
          hostId: room.host.clientId,
          upstreamPeerId: resolveViewerUpstreamId(room, existingViewer.chainPosition),
          chainPosition: existingViewer.chainPosition,
          isFirstViewer: existingViewer.chainPosition === 0,
          mediaCapabilities: existingViewer.mediaCapabilities,
          mediaManifest: room.mediaManifest
        });

        if (!existingViewer.mediaReady || !existingViewer.relayEstablished) {
          requestViewerReconnect(room, existingViewer);
        }
      }
      return;
    }

    if (room.viewers.length >= maxViewersPerRoom) {
      sendJson(ws, {
        type: 'error',
        code: 'viewer-limit-reached',
        message: 'Room viewer limit reached'
      });
      return;
    }

    const chainPosition = room.viewers.length;
    const viewerToken = generateSessionToken();
    const viewer = {
      clientId,
      sessionToken: viewerToken,
      ws,
      mediaCapabilities: sanitizeMediaCapabilities(data.mediaCapabilities),
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
      sessionToken: viewerToken,
      hostId: room.host.clientId,
      upstreamPeerId: resolveViewerUpstreamId(room, chainPosition),
      chainPosition,
      isFirstViewer: chainPosition === 0,
      mediaCapabilities: viewer.mediaCapabilities,
      mediaManifest: room.mediaManifest
    });

    if (chainPosition === 0) {
      notifyHostToConnectViewer(room, viewer, false);
      return;
    }

    notifyHostViewerCount(room);

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
      if (!isValidSessionToken(room.host.sessionToken, data.sessionToken)) {
        sendJson(ws, {
          type: 'error',
          code: 'session-token-invalid',
          message: 'Session token is invalid'
        });
        return;
      }

      clearDisconnectTimer(room.host);
      room.host.ws = ws;
      attachSocketMetadata(ws, room.id, data.clientId, 'host');
      sendJson(ws, {
        type: 'session-resumed',
        role: 'host',
        roomId: room.id,
        sessionToken: room.host.sessionToken,
        viewerCount: room.viewers.length,
        mediaManifest: room.mediaManifest
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
    if (!isValidSessionToken(viewer.sessionToken, data.sessionToken)) {
      sendJson(ws, {
        type: 'error',
        code: 'session-token-invalid',
        message: 'Session token is invalid'
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
      sessionToken: viewer.sessionToken,
      hostId: room.host.clientId,
      upstreamPeerId: resolveViewerUpstreamId(room, viewer.chainPosition),
      chainPosition: viewer.chainPosition,
      viewerCount: room.viewers.length,
      mediaCapabilities: viewer.mediaCapabilities,
      mediaManifest: room.mediaManifest
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

  function handleViewerReconnectReady(ws, data) {
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

  function notifyHostViewerCount(room) {
    if (!room || !isSocketOpen(room.host && room.host.ws)) {
      return;
    }
    sendJson(room.host.ws, {
      type: 'viewer-count-updated',
      viewerCount: room.viewers.length
    });
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
    if (!data.mediaManifest && room.mediaManifest) {
      data.mediaManifest = room.mediaManifest;
    }

    sendJson(targetWs, data);
  }

  function handleHostMediaManifest(ws, data) {
    const room = rooms.get(data.roomId || ws.roomId);
    if (!room || ws.role !== 'host' || room.host.clientId !== ws.clientId) {
      sendJson(ws, {
        type: 'error',
        code: 'session-not-found',
        message: 'Session not found'
      });
      return;
    }
    if (!isValidSessionToken(room.host.sessionToken, data.sessionToken)) {
      sendJson(ws, {
        type: 'error',
        code: 'session-token-invalid',
        message: 'Session token is invalid'
      });
      return;
    }

    const mediaManifest = sanitizeMediaManifest(data.mediaManifest);
    if (!mediaManifest) {
      sendJson(ws, {
        type: 'error',
        code: 'host-media-manifest-invalid',
        message: 'Host media manifest is invalid'
      });
      return;
    }
    room.mediaManifest = mediaManifest;
    sendJson(ws, {
      type: 'host-media-manifest-ack',
      roomId: room.id,
      mediaSessionId: mediaManifest.mediaSessionId,
      manifestVersion: mediaManifest.manifestVersion,
      mediaManifest
    });
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
    room.viewers.forEach((viewer) => {
      if (isSocketOpen(viewer.ws)) {
        sendJson(viewer.ws, { type: 'host-disconnected' });
      }
    });
    destroyRoom(room, 'host-disconnected');
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
    notifyHostViewerCount(room);

    const leftPosition = viewer.chainPosition;
    room.viewers.forEach((candidate, index) => {
      candidate.chainPosition = index;
      candidate.connectRequestPending = false;
    });

    if (isSocketOpen(room.host.ws)) {
      sendJson(room.host.ws, {
        type: 'viewer-left',
        viewerId: clientId,
        leftPosition,
        viewerCount: room.viewers.length
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
      candidate.connectRequestPending = true;
      if (isSocketOpen(candidate.ws)) {
        sendJson(candidate.ws, {
          type: 'chain-reconnect',
          newChainPosition: index,
          upstreamPeerId: resolveViewerUpstreamId(room, index),
          mediaManifest: room.mediaManifest
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

  function destroyRoom(room, reason) {
    if (!room || !rooms.has(room.id)) {
      return;
    }

    clearDisconnectTimer(room.host);
    room.host.sessionToken = null;
    room.host.ws = null;
    room.viewers.forEach((viewer) => {
      clearDisconnectTimer(viewer);
      viewer.sessionToken = null;
      viewer.ws = null;
      viewer.mediaReady = false;
      viewer.relayEstablished = false;
      viewer.connectRequestPending = false;
    });
    room.viewers = [];
    room.destroyedAt = Date.now();
    room.destroyReason = reason || 'room-destroyed';
    rooms.delete(room.id);
    logServerDebug(`Room destroyed: ${room.id} (${room.destroyReason})`);
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
    viewerMediaCapabilities: viewer.mediaCapabilities,
    mediaManifest: room.mediaManifest,
    viewerCount: room.viewers.length,
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
    nextViewerChainPosition: nextViewer.chainPosition,
    nextViewerMediaCapabilities: nextViewer.mediaCapabilities,
    mediaManifest: room.mediaManifest
  });
}

function attachSocketMetadata(ws, roomId, clientId, role) {
  ws.roomId = roomId;
  ws.clientId = clientId;
  ws.role = role;
}

function buildPublicRoomSummaryList(rooms) {
  if (!(rooms instanceof Map)) {
    return [];
  }

  return Array.from(rooms.values())
    .filter((room) => room && room.publicListing === true && isSocketOpen(room.host && room.host.ws))
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .map((room) => ({
      roomId: room.id,
      viewerCount: Array.isArray(room.viewers) ? room.viewers.length : 0,
      createdAt: Number(room.createdAt || 0)
    }));
}

function isElectronUserAgent(req) {
  const userAgent = String((req && req.headers && req.headers['user-agent']) || '');
  return /\bElectron\//i.test(userAgent);
}

function sanitizeMediaCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const encoded = value.encodedMediaDataChannel;
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) {
    return {
      webViewer: value.webViewer === true,
      encodedMediaDataChannel: null
    };
  }

  return {
    webViewer: value.webViewer === true,
    encodedMediaDataChannel: {
      protocol: String(encoded.protocol || '').slice(0, 64),
      protocolVersion: Number(encoded.protocolVersion || 0),
      supportedVideoCodecs: sanitizeStringList(encoded.supportedVideoCodecs, 8, 32),
      supportedAudioCodecs: sanitizeStringList(encoded.supportedAudioCodecs, 8, 32),
      maxFrameBytes: normalizePositiveInt(encoded.maxFrameBytes, 0),
      bootstrapRequired: encoded.bootstrapRequired === true
    }
  };
}

function sanitizeMediaManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const protocol = String(value.protocol || '').trim().slice(0, 64);
  const video = sanitizeVideoManifest(value.video);
  const audio = sanitizeAudioManifest(value.audio);
  if (protocol !== 'vds-media-encoded-v1' || !video) {
    return null;
  }

  return {
    protocol,
    protocolVersion: normalizePositiveInt(value.protocolVersion, 1),
    mediaSessionId: String(value.mediaSessionId || '').trim().slice(0, MAX_ID_LENGTH) || generateSessionToken(),
    manifestVersion: normalizePositiveInt(value.manifestVersion, 1),
    sourceType: String(value.sourceType || 'native-capture').trim().slice(0, 64),
    updatedAt: normalizePositiveInt(value.updatedAt, Date.now()),
    video,
    audio
  };
}

function sanitizeVideoManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const codec = normalizeCodecName(value.codec);
  if (codec !== 'h264' && codec !== 'h265' && codec !== 'hevc') {
    return null;
  }
  const payloadFormat = normalizePayloadFormat(value.payloadFormat, codec === 'h264' ? 'annexb' : 'annexb');
  return {
    codec: codec === 'hevc' ? 'h265' : codec,
    payloadFormat,
    width: normalizePositiveInt(value.width, 0),
    height: normalizePositiveInt(value.height, 0),
    fps: normalizePositiveInt(value.fps || value.frameRate, 0),
    keyframeIntervalMs: normalizePositiveInt(value.keyframeIntervalMs, 1000),
    profile: String(value.profile || '').trim().slice(0, 64),
    level: String(value.level || '').trim().slice(0, 32),
    configVersion: normalizePositiveInt(value.configVersion, 1),
    config: sanitizeCodecConfig(value.config, codec)
  };
}

function sanitizeAudioManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const codec = normalizeCodecName(value.codec);
  if (codec !== 'opus' && codec !== 'aac') {
    return null;
  }
  return {
    codec,
    payloadFormat: normalizePayloadFormat(value.payloadFormat, codec === 'opus' ? 'opus-raw' : 'aac-adts'),
    sampleRate: normalizePositiveInt(value.sampleRate, 48000),
    channels: normalizePositiveInt(value.channels, 2),
    frameDurationMs: normalizePositiveInt(value.frameDurationMs, codec === 'opus' ? 20 : 23),
    profile: String(value.profile || '').trim().slice(0, 64),
    configVersion: normalizePositiveInt(value.configVersion, 1),
    config: sanitizeCodecConfig(value.config, codec)
  };
}

function normalizeCodecName(value) {
  return String(value || '').trim().toLowerCase().replace(/\./g, '');
}

function normalizePayloadFormat(value, fallback) {
  const normalized = String(value || fallback || '').trim().toLowerCase().slice(0, 32);
  return normalized || fallback;
}

function sanitizeCodecConfig(value, codec) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const allowedKeys = codec === 'h264'
    ? ['sps', 'pps']
    : (codec === 'h265' || codec === 'hevc' ? ['vps', 'sps', 'pps'] : ['audioSpecificConfig']);
  const result = {};
  for (const key of allowedKeys) {
    if (typeof value[key] === 'string') {
      result[key] = value[key].slice(0, 8192);
    }
  }
  return result;
}

function sanitizeStringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, maxItems)
    .map((item) => String(item || '').trim().slice(0, maxLength))
    .filter(Boolean);
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

  return sanitizeIceServers(DEFAULT_ICE_SERVERS);
}

function normalizeIceUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

  const lowered = value.toLowerCase();
  if (lowered.startsWith('turn:') || lowered.startsWith('turns:')) {
    return null;
  }

  if (lowered.startsWith('stun:')) {
    return value.replace(/\?.*$/, '');
  }

  return null;
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

      return { urls };
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

function normalizePositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function validateInboundMessage(ws, data, maxMessagesPerWindow, messageRateWindowMs) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string' || data.type.length > 64) {
    sendJson(ws, {
      type: 'error',
      code: 'invalid-message',
      message: 'Invalid message'
    });
    return false;
  }

  const now = Date.now();
  if (!ws.__vdsRateWindowStartedAt || now - ws.__vdsRateWindowStartedAt > messageRateWindowMs) {
    ws.__vdsRateWindowStartedAt = now;
    ws.__vdsRateWindowCount = 0;
  }
  ws.__vdsRateWindowCount += 1;
  if (ws.__vdsRateWindowCount > maxMessagesPerWindow) {
    sendJson(ws, {
      type: 'error',
      code: 'message-rate-limit',
      message: 'Too many messages'
    });
    ws.close(1008, 'message-rate-limit');
    return false;
  }

  const idKeys = ['roomId', 'clientId', 'targetId', 'fromClientId', 'role', 'sessionToken'];
  for (const key of idKeys) {
    if (data[key] != null && (typeof data[key] !== 'string' || data[key].length > MAX_ID_LENGTH)) {
      sendJson(ws, {
        type: 'error',
        code: 'invalid-message',
        message: `Invalid ${key}`
      });
      return false;
    }
  }

  for (const key of ['sdp', 'candidate']) {
    if (data[key] != null) {
      const value = typeof data[key] === 'string'
        ? data[key]
        : JSON.stringify(data[key]);
      if (value.length > MAX_SIGNAL_FIELD_LENGTH) {
        sendJson(ws, {
          type: 'error',
          code: 'message-too-large',
          message: `${key} is too large`
        });
        return false;
      }
    }
  }

  if ((data.type === 'create-room' || data.type === 'join-room' || data.type === 'resume-session' || data.type === 'host-media-manifest') &&
      typeof data.clientId !== 'string') {
    sendJson(ws, {
      type: 'error',
      code: 'invalid-message',
      message: 'Invalid clientId'
    });
    return false;
  }
  if ((data.type === 'join-room' || data.type === 'resume-session' || data.type === 'host-media-manifest') &&
      typeof data.roomId !== 'string') {
    sendJson(ws, {
      type: 'error',
      code: 'invalid-message',
      message: 'Invalid roomId'
    });
    return false;
  }
  if (data.type === 'resume-session' && data.role !== 'host' && data.role !== 'viewer') {
    sendJson(ws, {
      type: 'error',
      code: 'invalid-message',
      message: 'Invalid role'
    });
    return false;
  }

  return true;
}

function generateSessionToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function isValidSessionToken(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || !expected || !actual) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);
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

function generateRoomId(existingRooms) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    if (!existingRooms || !existingRooms.has(roomId)) {
      return roomId;
    }
  }

  throw new Error('room-id-generation-failed');
}

module.exports = {
  startServer,
  generateRoomId,
  validateInboundMessage
};
