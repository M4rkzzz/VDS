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
const DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM = 2;
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
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const disconnectGraceMs = normalizePositiveInt(options.disconnectGraceMs || process.env.DISCONNECT_GRACE_MS, 30000);
  const hostDisconnectGraceMs = normalizePositiveInt(
    options.hostDisconnectGraceMs || process.env.HOST_DISCONNECT_GRACE_MS,
    Math.min(disconnectGraceMs, 3000)
  );
  const viewerDisconnectGraceMs = normalizePositiveInt(
    options.viewerDisconnectGraceMs || process.env.VIEWER_DISCONNECT_GRACE_MS,
    Math.min(disconnectGraceMs, 3000)
  );
  const maxPayload = normalizePositiveInt(options.maxPayload || process.env.WS_MAX_PAYLOAD_BYTES, DEFAULT_MAX_WS_PAYLOAD_BYTES);
  const maxConnections = normalizePositiveInt(options.maxConnections || process.env.WS_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS);
  const maxRooms = normalizePositiveInt(options.maxRooms || process.env.WS_MAX_ROOMS, DEFAULT_MAX_ROOMS);
  const maxViewersPerRoom = normalizePositiveInt(options.maxViewersPerRoom || process.env.WS_MAX_VIEWERS_PER_ROOM, DEFAULT_MAX_VIEWERS_PER_ROOM);
  const maxDownstreamsPerUpstream = normalizePositiveInt(options.maxDownstreamsPerUpstream || process.env.MAX_DOWNSTREAMS_PER_UPSTREAM, DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM);
  const maxMessagesPerWindow = normalizePositiveInt(options.maxMessagesPerWindow || process.env.WS_MAX_MESSAGES_PER_WINDOW, DEFAULT_MAX_MESSAGES_PER_WINDOW);
  const messageRateWindowMs = normalizePositiveInt(options.messageRateWindowMs || process.env.WS_MESSAGE_RATE_WINDOW_MS, DEFAULT_MESSAGE_RATE_WINDOW_MS);
  const adminPort = options.adminPort === undefined ? 0 : normalizePositiveInt(options.adminPort, 0);
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
  let adminServer = null;
  const rooms = new Map();
  let activeConnections = 0;

  logServerInfo('[server limits]', {
    maxPayload,
    maxConnections,
    maxRooms,
    maxViewersPerRoom,
    maxDownstreamsPerUpstream,
    maxMessagesPerWindow,
    messageRateWindowMs,
    disconnectGraceMs,
    hostDisconnectGraceMs,
    viewerDisconnectGraceMs,
    adminPort
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
        res.set('Cache-Control', 'no-store');
        res.sendFile(webEntry);
        return;
      }
      next();
    });
    app.get(['/vds_web', '/vds_web/'], (_req, res, next) => {
      const webEntry = path.join(publicDir, 'vds_web', 'index.html');
      if (fs.existsSync(webEntry)) {
        res.set('Cache-Control', 'no-store');
        res.sendFile(webEntry);
        return;
      }
      next();
    });
    app.get('/admin', (_req, res, next) => {
      const adminEntry = path.join(publicDir, 'admin.html');
      if (fs.existsSync(adminEntry)) {
        res.set('Cache-Control', 'no-store');
        res.sendFile(adminEntry);
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
      disconnectGraceMs,
      hostDisconnectGraceMs,
      viewerDisconnectGraceMs
    });
  });

  app.get('/api/version', (_req, res) => {
    res.json({
      version: appVersion,
      disconnectGraceMs,
      hostDisconnectGraceMs,
      viewerDisconnectGraceMs
    });
  });

  app.get('/api/public-rooms', (_req, res) => {
    res.json({
      rooms: buildPublicRoomSummaryList(rooms)
    });
  });

  app.get('/api/admin/rooms', (_req, res) => {
    res.json({
      generatedAt: Date.now(),
      activeConnections,
      limits: {
        maxRooms,
        maxViewersPerRoom,
        maxDownstreamsPerUpstream,
        maxConnections
      },
      rooms: buildAdminRoomSnapshotList(rooms, maxDownstreamsPerUpstream)
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
    if (ws.roomId || ws.role) {
      sendJson(ws, {
        type: 'error',
        code: 'socket-already-bound',
        message: 'This connection is already bound to a room'
      });
      return;
    }

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
      const previousWs = existingViewer.ws;
      clearDisconnectTimer(existingViewer);
      existingViewer.ws = ws;
      existingViewer.mediaCapabilities = sanitizeMediaCapabilities(data.mediaCapabilities) || existingViewer.mediaCapabilities;
      attachSocketMetadata(ws, roomId, clientId, 'viewer');
      retireSocket(previousWs, 'viewer-rebound', ws);

      if (rebindRequired) {
        sendJson(ws, {
          type: 'room-joined',
          roomId,
          clientId,
          sessionToken: existingViewer.sessionToken,
          hostId: room.host.clientId,
          upstreamPeerId: getViewerUpstreamId(room, existingViewer),
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
    const upstreamPeerId = selectViewerUpstream(room, chainPosition, maxDownstreamsPerUpstream);
    if (!upstreamPeerId) {
      sendJson(ws, {
        type: 'error',
        code: 'upstream-capacity-unavailable',
        message: 'No upstream peer is currently available for this viewer'
      });
      return;
    }
    const viewer = {
      clientId,
      sessionToken: viewerToken,
      ws,
      mediaCapabilities: sanitizeMediaCapabilities(data.mediaCapabilities),
      chainPosition,
      upstreamPeerId,
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
      upstreamPeerId,
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

    requestViewerReconnect(room, viewer, maxDownstreamsPerUpstream);
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
      const previousWs = room.host.ws;
      room.host.ws = ws;
      attachSocketMetadata(ws, room.id, data.clientId, 'host');
      retireSocket(previousWs, 'host-session-resumed', ws);
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
    const previousWs = viewer.ws;
    viewer.ws = ws;
    if (data.needsMediaReconnect) {
      viewer.mediaReady = false;
      viewer.relayEstablished = false;
    }
    attachSocketMetadata(ws, room.id, data.clientId, 'viewer');
    retireSocket(previousWs, 'viewer-session-resumed', ws);
    sendJson(ws, {
      type: 'session-resumed',
      role: 'viewer',
      roomId: room.id,
      sessionToken: viewer.sessionToken,
      hostId: room.host.clientId,
      upstreamPeerId: getViewerUpstreamId(room, viewer),
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
    if (!isAuthoritativeSocket(ws, rooms)) {
      return;
    }
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

    notifyPendingDownstreams(room, viewer);
  }

  function handleViewerReconnectReady(ws, data) {
    if (!isAuthoritativeSocket(ws, rooms)) {
      return;
    }
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

    requestViewerReconnect(room, viewer, maxDownstreamsPerUpstream, String(data.failedUpstreamPeerId || ''));
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
    if (!isAuthoritativeSocket(ws, rooms)) {
      return;
    }
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
        const expectedUpstreamId = getViewerUpstreamId(room, viewer);
        if (expectedUpstreamId !== room.host.clientId) {
          return;
        }
        targetWs = room.host.ws;
      } else {
        const expectedUpstreamId = getViewerUpstreamId(room, viewer);
        const isAllowedTarget = data.targetId === expectedUpstreamId || isViewerDirectDownstream(room, viewer.clientId, data.targetId);
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

    data.fromClientId = ws.clientId;
    if (!data.mediaManifest && room.mediaManifest) {
      data.mediaManifest = room.mediaManifest;
    }

    sendJson(targetWs, data);
  }

  function handleHostMediaManifest(ws, data) {
    if (!isAuthoritativeSocket(ws, rooms)) {
      sendJson(ws, {
        type: 'error',
        code: 'session-not-found',
        message: 'Session not found'
      });
      return;
    }
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
      }, hostDisconnectGraceMs);
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
      }, viewerDisconnectGraceMs);
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

    rebalanceViewerUpstreams(room, {
      maxDownstreamsPerUpstream,
      forceFromIndex: leftPosition,
      failedUpstreamId: clientId
    });

    if (room.viewers.length === 0) {
      return;
    }

    notifyReconnectTargets(room);
  }

  function destroyRoom(room, reason) {
    if (!room || !rooms.has(room.id)) {
      return;
    }

    clearDisconnectTimer(room.host);
    clearSocketMetadata(room.host.ws);
    room.host.sessionToken = null;
    room.host.ws = null;
    room.viewers.forEach((viewer) => {
      clearDisconnectTimer(viewer);
      clearSocketMetadata(viewer.ws);
      viewer.sessionToken = null;
      viewer.ws = null;
      viewer.mediaReady = false;
      viewer.relayEstablished = false;
      viewer.connectRequestPending = false;
    });
    room.viewers = [];
    room.destroyReason = reason || 'room-destroyed';
    rooms.delete(room.id);
    logServerDebug(`Room destroyed: ${room.id} (${room.destroyReason})`);
  }

  function handleListenError(error) {
    if (handleListenError.handled) {
      return;
    }
    handleListenError.handled = true;
    if (typeof options.onError === 'function') {
      options.onError(error);
      return;
    }
    logServerWarning('server-listen-error', 'Server listen error:', error, 0);
  }

  server.on('error', handleListenError);
  wss.on('error', handleListenError);

  server.listen(port, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    console.log(`Server running on http://localhost:${actualPort}`);
  });

  if (adminPort > 0) {
    const adminApp = express();
    adminApp.get('/api/rooms', (_req, res) => {
      res.json(buildAdminSnapshot(rooms, maxDownstreamsPerUpstream, activeConnections, {
        maxRooms,
        maxViewersPerRoom,
        maxDownstreamsPerUpstream,
        maxConnections
      }));
    });
    if (publicDir) {
      adminApp.get('/', (_req, res, next) => {
        const adminEntry = path.join(publicDir, 'admin.html');
        if (fs.existsSync(adminEntry)) {
          res.sendFile(adminEntry);
          return;
        }
        next();
      });
    }
    adminApp.use((_req, res) => {
      res.status(404).send('admin page not found');
    });
    adminServer = http.createServer(adminApp);
    adminServer.on('error', handleListenError);
    adminServer.listen(adminPort, () => {
      const address = adminServer.address();
      const actualPort = address && typeof address === 'object' ? address.port : adminPort;
      logServerInfo(`Admin dashboard running on http://localhost:${actualPort}`);
    });
  }

  return { app, server, wss, rooms, adminServer };
}

function notifyHostToConnectViewer(room, viewer, reconnect) {
  if (!room || !viewer || !isSocketOpen(room.host && room.host.ws)) {
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

function requestViewerReconnect(room, viewer, maxDownstreamsPerUpstream = DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM, failedUpstreamId = '') {
  if (!viewer) {
    return;
  }

  viewer.mediaReady = false;
  viewer.relayEstablished = false;
  viewer.connectRequestPending = false;
  const upstreamPeerId = selectViewerUpstream(room, viewer.chainPosition, maxDownstreamsPerUpstream, viewer.clientId, failedUpstreamId);
  viewer.upstreamPeerId = upstreamPeerId;
  if (!upstreamPeerId) {
    viewer.needsChainReconnect = true;
    if (isSocketOpen(viewer.ws)) {
      sendJson(viewer.ws, {
        type: 'error',
        code: 'upstream-capacity-unavailable',
        message: 'No upstream peer is currently available for reconnect'
      });
    }
    return;
  }
  notifyViewerCurrentUpstream(room, viewer, true);
}

function notifyViewerToConnectNext(room, previousViewer, nextViewer) {
  if (!room || !previousViewer || !nextViewer || !isSocketOpen(previousViewer.ws)) {
    return;
  }

  if (nextViewer.mediaReady || nextViewer.relayEstablished || nextViewer.connectRequestPending) {
    return;
  }
  if (getViewerUpstreamId(room, nextViewer) !== previousViewer.clientId) {
    return;
  }

  nextViewer.connectRequestPending = true;
  sendJson(previousViewer.ws, {
    type: 'connect-to-next',
    nextViewerId: nextViewer.clientId,
    nextViewerChainPosition: nextViewer.chainPosition,
    upstreamPeerId: previousViewer.clientId,
    nextViewerMediaCapabilities: nextViewer.mediaCapabilities,
    mediaManifest: room.mediaManifest
  });
}

function notifyViewerCurrentUpstream(room, viewer, reconnect) {
  if (!room || !viewer) {
    return;
  }
  const upstreamPeerId = getViewerUpstreamId(room, viewer);
  if (!upstreamPeerId) {
    return;
  }
  if (upstreamPeerId === room.host.clientId) {
    notifyHostToConnectViewer(room, viewer, reconnect);
    return;
  }
  const upstreamViewer = findViewerById(room, upstreamPeerId);
  if (upstreamViewer && upstreamViewer.mediaReady && isSocketOpen(upstreamViewer.ws)) {
    notifyViewerToConnectNext(room, upstreamViewer, viewer);
  }
}

function attachSocketMetadata(ws, roomId, clientId, role) {
  ws.roomId = roomId;
  ws.clientId = clientId;
  ws.role = role;
}

function clearSocketMetadata(ws) {
  if (!ws) {
    return;
  }
  ws.roomId = null;
  ws.clientId = null;
  ws.role = null;
}

function retireSocket(ws, reason, replacementWs) {
  if (!ws || ws === replacementWs) {
    return;
  }
  clearSocketMetadata(ws);
  if (isSocketOpen(ws)) {
    ws.close(4000, reason || 'socket-retired');
  }
}

function isAuthoritativeSocket(ws, rooms) {
  if (!ws || !ws.roomId || !ws.role || !ws.clientId || !(rooms instanceof Map)) {
    return false;
  }
  const room = rooms.get(ws.roomId);
  if (!room) {
    return false;
  }
  if (ws.role === 'host') {
    return Boolean(room.host && room.host.clientId === ws.clientId && room.host.ws === ws);
  }
  if (ws.role === 'viewer') {
    const viewer = room.viewers.find((candidate) => candidate.clientId === ws.clientId);
    return Boolean(viewer && viewer.ws === ws);
  }
  return false;
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

function buildAdminSnapshot(rooms, maxDownstreamsPerUpstream, activeConnections, limits) {
  const roomList = buildAdminRoomSnapshotList(rooms, maxDownstreamsPerUpstream);
  return {
    generatedAt: Date.now(),
    activeConnections: Number(activeConnections || 0),
    roomCount: roomList.length,
    limits: limits || {},
    rooms: roomList
  };
}

function buildAdminRoomSnapshotList(rooms, maxDownstreamsPerUpstream) {
  if (!(rooms instanceof Map)) {
    return [];
  }
  return Array.from(rooms.values())
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .map((room) => buildAdminRoomSnapshot(room, maxDownstreamsPerUpstream));
}

function buildAdminRoomSnapshot(room, maxDownstreamsPerUpstream) {
  const viewers = Array.isArray(room && room.viewers) ? room.viewers : [];
  const hostId = room && room.host ? room.host.clientId : '';
  const nodes = [];
  if (hostId) {
    nodes.push({
      id: hostId,
      role: 'host',
      online: isSocketOpen(room.host.ws),
      chainPosition: -1,
      upstreamPeerId: '',
      directDownstreamCount: countDirectDownstreams(room, hostId),
      maxDirectDownstreams: getUpstreamDirectDownstreamLimit(room, hostId, maxDownstreamsPerUpstream),
      mediaReady: true,
      relayEstablished: true,
      connectRequestPending: false
    });
  }
  viewers.forEach((viewer) => {
    const upstreamPeerId = getViewerUpstreamId(room, viewer);
    nodes.push({
      id: viewer.clientId,
      role: 'viewer',
      online: isSocketOpen(viewer.ws),
      chainPosition: viewer.chainPosition,
      upstreamPeerId,
      directDownstreamCount: countDirectDownstreams(room, viewer.clientId),
      maxDirectDownstreams: getUpstreamDirectDownstreamLimit(room, viewer.clientId, maxDownstreamsPerUpstream),
      mediaReady: viewer.mediaReady === true,
      relayEstablished: viewer.relayEstablished === true,
      connectRequestPending: viewer.connectRequestPending === true,
      needsChainReconnect: viewer.needsChainReconnect === true,
      mediaCapabilities: viewer.mediaCapabilities || null
    });
  });
  return {
    roomId: room.id,
    publicListing: room.publicListing === true,
    createdAt: Number(room.createdAt || 0),
    viewerCount: viewers.length,
    mediaManifest: room.mediaManifest || null,
    nodes,
    edges: viewers.map((viewer) => ({
      from: getViewerUpstreamId(room, viewer),
      to: viewer.clientId,
      ready: viewer.mediaReady === true && viewer.relayEstablished === true,
      pending: viewer.connectRequestPending === true || viewer.needsChainReconnect === true
    })).filter((edge) => edge.from && edge.to)
  };
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
      maxDirectDownstreams: normalizePositiveInt(value.maxDirectDownstreams, DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM),
      encodedMediaDataChannel: null
    };
  }

  return {
    webViewer: value.webViewer === true,
    maxDirectDownstreams: normalizePositiveInt(value.maxDirectDownstreams, DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM),
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

function getViewerUpstreamId(room, viewer) {
  if (!room || !viewer || !viewer.upstreamPeerId) {
    return '';
  }
  if (viewer.upstreamPeerId === room.host.clientId) {
    return room.host.clientId;
  }
  const upstreamViewer = findViewerById(room, viewer.upstreamPeerId);
  if (!upstreamViewer || upstreamViewer.clientId === viewer.clientId) {
    return '';
  }
  return upstreamViewer.clientId;
}

function findViewerById(room, clientId) {
  return room && Array.isArray(room.viewers)
    ? room.viewers.find((viewer) => viewer.clientId === clientId) || null
    : null;
}

function countDirectDownstreams(room, upstreamPeerId, excludeViewerId) {
  if (!room || !Array.isArray(room.viewers) || !upstreamPeerId) {
    return 0;
  }
  return room.viewers.filter((viewer) =>
    viewer.clientId !== excludeViewerId && getViewerUpstreamId(room, viewer) === upstreamPeerId
  ).length;
}

function getUpstreamDirectDownstreamLimit(room, upstreamPeerId, globalLimit) {
  const limit = Math.max(1, Number(globalLimit) || DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM);
  if (!room || !upstreamPeerId || upstreamPeerId === room.host.clientId) {
    return limit;
  }
  const upstreamViewer = findViewerById(room, upstreamPeerId);
  const capabilityLimit = upstreamViewer && upstreamViewer.mediaCapabilities
    ? normalizePositiveInt(upstreamViewer.mediaCapabilities.maxDirectDownstreams, limit)
    : limit;
  return Math.max(1, Math.min(limit, capabilityLimit));
}

function isUpstreamCandidateReady(room, upstreamPeerId) {
  if (!room || !upstreamPeerId) {
    return false;
  }
  if (upstreamPeerId === room.host.clientId) {
    return isSocketOpen(room.host.ws);
  }
  const upstreamViewer = findViewerById(room, upstreamPeerId);
  return Boolean(upstreamViewer && upstreamViewer.mediaReady && isSocketOpen(upstreamViewer.ws));
}

function wouldCreateUpstreamCycle(room, viewerId, upstreamPeerId) {
  let currentId = upstreamPeerId;
  const visited = new Set([viewerId]);
  while (currentId && room && currentId !== room.host.clientId) {
    if (visited.has(currentId)) {
      return true;
    }
    visited.add(currentId);
    const currentViewer = findViewerById(room, currentId);
    if (!currentViewer) {
      return false;
    }
    currentId = getViewerUpstreamId(room, currentViewer);
  }
  return false;
}

function selectViewerUpstream(room, chainPosition, maxDownstreamsPerUpstream, viewerId, excludeUpstreamId = '') {
  if (!room || !Array.isArray(room.viewers)) {
    return room && room.host ? room.host.clientId : '';
  }
  const limit = Math.max(1, Number(maxDownstreamsPerUpstream) || DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM);
  const preferredViewer = chainPosition > 0 ? room.viewers[chainPosition - 1] : null;
  const candidates = [];
  if (preferredViewer) {
    candidates.push(preferredViewer.clientId);
  }
  candidates.push(room.host.clientId);
  for (let index = chainPosition - 2; index >= 0; index -= 1) {
    const fallback = room.viewers[index];
    if (fallback) {
      candidates.push(fallback.clientId);
    }
  }

  for (const candidateId of Array.from(new Set(candidates))) {
    if (candidateId === excludeUpstreamId) {
      continue;
    }
    if (candidateId === viewerId || !isUpstreamCandidateReady(room, candidateId)) {
      continue;
    }
    if (countDirectDownstreams(room, candidateId, viewerId) >= getUpstreamDirectDownstreamLimit(room, candidateId, limit)) {
      continue;
    }
    if (wouldCreateUpstreamCycle(room, viewerId, candidateId)) {
      continue;
    }
    return candidateId;
  }

  if (
    preferredViewer &&
    preferredViewer.clientId !== excludeUpstreamId &&
    preferredViewer.clientId !== viewerId &&
    countDirectDownstreams(room, preferredViewer.clientId, viewerId) < getUpstreamDirectDownstreamLimit(room, preferredViewer.clientId, limit) &&
    !wouldCreateUpstreamCycle(room, viewerId, preferredViewer.clientId)
  ) {
    return preferredViewer.clientId;
  }

  return '';
}

function isViewerDirectDownstream(room, upstreamPeerId, downstreamPeerId) {
  const downstream = findViewerById(room, downstreamPeerId);
  return Boolean(downstream && getViewerUpstreamId(room, downstream) === upstreamPeerId);
}

function markViewerForReconnect(viewer, upstreamPeerId) {
  if (!viewer) {
    return;
  }
  viewer.upstreamPeerId = upstreamPeerId;
  viewer.mediaReady = false;
  viewer.relayEstablished = false;
  viewer.connectRequestPending = false;
  viewer.needsChainReconnect = true;
}

function rebalanceViewerUpstreams(room, options = {}) {
  const forceFromIndex = Number.isInteger(options.forceFromIndex) ? options.forceFromIndex : 0;
  const failedUpstreamId = options.failedUpstreamId || '';
  const limit = Math.max(1, Number(options.maxDownstreamsPerUpstream) || DEFAULT_MAX_DOWNSTREAMS_PER_UPSTREAM);
  if (!room || !Array.isArray(room.viewers)) {
    return;
  }
  room.viewers.forEach((viewer, index) => {
    viewer.chainPosition = index;
    const currentUpstreamId = getViewerUpstreamId(room, viewer);
    const mustReassign =
      index >= forceFromIndex ||
      currentUpstreamId === failedUpstreamId ||
      !isUpstreamCandidateReady(room, currentUpstreamId) ||
      countDirectDownstreams(room, currentUpstreamId, viewer.clientId) >= getUpstreamDirectDownstreamLimit(room, currentUpstreamId, limit) ||
      wouldCreateUpstreamCycle(room, viewer.clientId, currentUpstreamId);
    if (!mustReassign) {
      return;
    }
    const nextUpstreamId = selectViewerUpstream(room, index, limit, viewer.clientId, failedUpstreamId);
    markViewerForReconnect(viewer, nextUpstreamId);
  });
}

function notifyReconnectTargets(room) {
  if (!room || !Array.isArray(room.viewers)) {
    return;
  }
  room.viewers.forEach((viewer) => {
    if (!viewer.needsChainReconnect) {
      return;
    }
    const upstreamPeerId = getViewerUpstreamId(room, viewer);
    if (!upstreamPeerId) {
      return;
    }
    viewer.needsChainReconnect = false;
    if (isSocketOpen(viewer.ws)) {
      sendJson(viewer.ws, {
        type: 'chain-reconnect',
        newChainPosition: viewer.chainPosition,
        upstreamPeerId,
        mediaManifest: room.mediaManifest
      });
    }
  });
}

function notifyPendingDownstreams(room, upstreamViewer) {
  if (!room || !upstreamViewer || !upstreamViewer.mediaReady || !isSocketOpen(upstreamViewer.ws)) {
    return;
  }
  room.viewers
    .filter((viewer) => getViewerUpstreamId(room, viewer) === upstreamViewer.clientId)
    .forEach((viewer) => notifyViewerToConnectNext(room, upstreamViewer, viewer));
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
