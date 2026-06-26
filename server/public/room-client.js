(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.roomClient) {
    return;
  }

  const MAX_PENDING_MESSAGES = 256;
  let legacyAdapter = null;
  const pendingMessages = [];
  const messageHandlers = new Map();

  let ws = null;
  let wsConnected = false;
  let wsConnectPromise = null;
  let wsReconnectAttempts = 0;
  let wsReconnectTimer = null;
  let pendingReconnect = false;
  let wsManualClose = false;

  function installLegacyAdapter(adapter) {
    legacyAdapter = adapter && typeof adapter === 'object' ? adapter : null;
    return legacyAdapter;
  }

  function requireAdapterMethod(method) {
    if (!legacyAdapter || typeof legacyAdapter[method] !== 'function') {
      throw new Error(`room-client-adapter-missing:${method}`);
    }
    return legacyAdapter[method];
  }

  function callAdapter(method, args) {
    return requireAdapterMethod(method).apply(legacyAdapter, args);
  }

  function callOptionalAdapter(method, args, fallbackValue) {
    if (!legacyAdapter || typeof legacyAdapter[method] !== 'function') {
      return fallbackValue;
    }
    return legacyAdapter[method].apply(legacyAdapter, args);
  }

  function getWebSocketUrl() {
    return requireAdapterMethod('getWebSocketUrl').call(legacyAdapter);
  }

  function isWebSocketOpen() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  function debugLog(category, ...args) {
    callOptionalAdapter('debugLog', [category, ...args]);
  }

  function normalizeMessageType(type) {
    return String(type || '').trim();
  }

  function registerMessageHandler(type, handler) {
    const messageType = normalizeMessageType(type);
    if (!messageType) {
      throw new Error('room-client-message-handler-missing-type');
    }
    if (typeof handler !== 'function') {
      throw new Error('room-client-message-handler-missing-handler');
    }
    let handlers = messageHandlers.get(messageType);
    if (!handlers) {
      handlers = new Set();
      messageHandlers.set(messageType, handlers);
    }
    handlers.add(handler);
    return () => unregisterMessageHandler(messageType, handler);
  }

  function unregisterMessageHandler(type, handler) {
    const messageType = normalizeMessageType(type);
    const handlers = messageHandlers.get(messageType);
    if (!handlers) {
      return false;
    }
    const removed = handlers.delete(handler);
    if (handlers.size === 0) {
      messageHandlers.delete(messageType);
    }
    return removed;
  }

  function getRegisteredMessageTypes() {
    return Array.from(messageHandlers.keys());
  }

  function waitForMessage(type, predicate, timeoutMs = 5000) {
    const messageType = normalizeMessageType(type);
    if (!messageType) {
      return Promise.reject(new Error('room-client-wait-message-missing-type'));
    }
    const shouldResolve = typeof predicate === 'function' ? predicate : () => true;
    const waitMs = Math.max(1000, Number(timeoutMs || 5000) || 5000);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = 0;
      let unregister = null;
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = 0;
        }
        if (typeof unregister === 'function') {
          unregister();
          unregister = null;
        }
      };
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback(value);
      };
      unregister = registerMessageHandler(messageType, (data) => {
        let matched = false;
        try {
          matched = shouldResolve(data) === true;
        } catch (error) {
          settle(reject, error);
          return false;
        }
        if (!matched) {
          return false;
        }
        settle(resolve, data);
        return true;
      });
      timeoutId = setTimeout(() => {
        settle(reject, new Error(`room-client-wait-message-timeout:${messageType}`));
      }, waitMs);
    });
  }

  function handleUnhandledMessage(data) {
    const handled = callOptionalAdapter('onUnhandledMessage', [data], false);
    if (handled === true) {
      return true;
    }
    debugLog('connection', 'Unhandled room-client message:', data && data.type ? data.type : 'unknown');
    return false;
  }

  async function dispatchMessage(data) {
    const messageType = normalizeMessageType(data && data.type);
    if (messageType && messageHandlers.has(messageType)) {
      let lastResult;
      for (const handler of messageHandlers.get(messageType)) {
        lastResult = await handler(data);
      }
      return lastResult;
    }
    return handleUnhandledMessage(data);
  }

  function sendRawMessage(data) {
    if (isWebSocketOpen()) {
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  function pendingMessagePriority(data) {
    const type = data && data.type;
    if (type === 'ice-candidate' || type === 'candidate') {
      return 1;
    }
    if (type === 'offer' || type === 'answer' || type === 'viewer-ready') {
      return 2;
    }
    return 3;
  }

  function removePendingMessages(predicate) {
    if (typeof predicate !== 'function' || pendingMessages.length === 0) {
      return 0;
    }

    let removed = 0;
    for (let index = pendingMessages.length - 1; index >= 0; index -= 1) {
      const entry = pendingMessages[index];
      const payload = entry && entry.payload ? entry.payload : entry;
      if (predicate(payload)) {
        pendingMessages.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  function clearPendingMessages() {
    const queuedMessages = pendingMessages.length;
    pendingMessages.length = 0;
    return queuedMessages;
  }

  function enqueuePendingMessage(data) {
    const entry = {
      payload: data,
      priority: pendingMessagePriority(data),
      queuedAt: Date.now()
    };
    pendingMessages.push(entry);

    while (pendingMessages.length > MAX_PENDING_MESSAGES) {
      let dropIndex = 0;
      let dropPriority = Number.POSITIVE_INFINITY;
      for (let index = 0; index < pendingMessages.length; index += 1) {
        const candidate = pendingMessages[index];
        const priority = candidate && Number.isFinite(candidate.priority) ? candidate.priority : 0;
        if (priority < dropPriority) {
          dropPriority = priority;
          dropIndex = index;
        }
      }
      pendingMessages.splice(dropIndex, 1);
    }

    return pendingMessages.length;
  }

  function flushPendingMessages() {
    let flushed = 0;
    while (pendingMessages.length > 0 && isWebSocketOpen()) {
      const entry = pendingMessages.shift();
      sendRawMessage(entry && entry.payload ? entry.payload : entry);
      flushed += 1;
    }
    return flushed;
  }

  function clearPendingSignalingQueues(reason = '') {
    const queuedMessages = clearPendingMessages();
    if (queuedMessages > 0) {
      debugLog('connection', 'Cleared pending room-client messages:', {
        reason,
        queuedMessages
      });
    }
    return { queuedMessages };
  }

  function sendResumeSessionMessageIfNeeded() {
    const resumeMessage = callOptionalAdapter('consumeResumeSessionMessage', [], null);
    if (!resumeMessage || typeof resumeMessage !== 'object') {
      return false;
    }

    removePendingMessages((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      return entry.type === 'join-room' ||
        entry.type === 'create-room' ||
        entry.type === 'resume-session';
    });
    return sendRawMessage(resumeMessage);
  }

  function scheduleReconnect() {
    if (pendingReconnect) {
      return;
    }

    pendingReconnect = true;
    const maxDelay = 30000;
    const baseDelay = 1000;
    const delay = Math.min(baseDelay * Math.pow(2, wsReconnectAttempts), maxDelay);
    const attempt = wsReconnectAttempts + 1;

    debugLog('connection', `Reconnecting in ${delay}ms (attempt ${attempt})...`);
    callOptionalAdapter('onReconnectScheduled', [{ delay, attempt }]);

    wsReconnectTimer = setTimeout(() => {
      pendingReconnect = false;
      wsReconnectAttempts += 1;
      connectWebSocket().catch(() => {});
    }, delay);
  }

  function connectWebSocket() {
    if (isWebSocketOpen()) {
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

      ws = new WebSocket(getWebSocketUrl());

      ws.onopen = () => {
        debugLog('connection', 'WebSocket connected');
        wsConnected = true;
        wsReconnectAttempts = 0;
        wsConnectPromise = null;

        if (wsReconnectTimer) {
          clearTimeout(wsReconnectTimer);
          wsReconnectTimer = null;
        }

        callOptionalAdapter('onWebSocketOpen', []);
        sendResumeSessionMessageIfNeeded();
        flushPendingMessages();
        settle(resolve);
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || typeof data !== 'object') {
            return;
          }
          await dispatchMessage(data);
        } catch (error) {
          debugLog('connection', 'Unhandled message processing error:', error && error.message ? error.message : String(error));
        }
      };

      ws.onclose = () => {
        debugLog('connection', 'WebSocket disconnected');
        wsConnected = false;
        wsConnectPromise = null;
        callOptionalAdapter('onWebSocketClose', [{ manualClose: wsManualClose }]);

        if (wsManualClose) {
          debugLog('connection', 'Manual close, skipping reconnect');
          return;
        }

        const shouldReconnect = callOptionalAdapter('onWebSocketUnexpectedClose', [], true);
        if (shouldReconnect !== false) {
          scheduleReconnect();
        }
      };

      ws.onerror = (error) => {
        debugLog('connection', 'WebSocket error:', error && error.message ? error.message : String(error));

        if (!settled) {
          wsConnectPromise = null;
          settle(reject, new Error('websocket-connect-failed'));
        }
      };
    });

    return wsConnectPromise;
  }

  function disconnectWebSocket() {
    clearPendingSignalingQueues('disconnect');
    wsManualClose = true;
    pendingReconnect = false;
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
    callOptionalAdapter('onWebSocketDisconnected', []);
  }

  async function waitForWsConnected(timeoutMs = 10000) {
    if (isWebSocketOpen()) {
      return;
    }

    await Promise.race([
      connectWebSocket(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('websocket-timeout')), timeoutMs);
      })
    ]);
  }

  function sendMessage(data, options = {}) {
    const { queueIfDisconnected = true } = options;

    if (isWebSocketOpen()) {
      sendRawMessage(data);
      return true;
    }

    if (!queueIfDisconnected) {
      return false;
    }

    enqueuePendingMessage(data);
    connectWebSocket().catch(() => {});
    return false;
  }

  function normalizeRoomId(roomId) {
    return String(roomId || '').toUpperCase().trim();
  }

  function buildJoinRoomMessage(options = {}) {
    const roomId = normalizeRoomId(options.roomId);
    const clientId = String(options.clientId || '').trim();
    if (!roomId) {
      throw new Error('room-client-join-missing-room-id');
    }
    if (!clientId) {
      throw new Error('room-client-join-missing-client-id');
    }

    const message = {
      type: 'join-room',
      roomId,
      clientId,
      sessionToken: options.sessionToken ? String(options.sessionToken) : ''
    };

    if (Number.isFinite(options.viewerAudioDelayMs)) {
      message.viewerAudioDelayMs = options.viewerAudioDelayMs;
    }

    return message;
  }

  function buildCreateRoomMessage(options = {}) {
    const clientId = String(options.clientId || '').trim();
    if (!clientId) {
      throw new Error('room-client-create-missing-client-id');
    }

    return {
      type: 'create-room',
      clientId,
      publicListing: Boolean(options.publicListing),
      mediaManifest: options.mediaManifest || null
    };
  }

  function buildLeaveRoomMessage(options = {}) {
    const roomId = normalizeRoomId(options.roomId);
    const clientId = String(options.clientId || '').trim();
    if (!roomId) {
      throw new Error('room-client-leave-missing-room-id');
    }
    if (!clientId) {
      throw new Error('room-client-leave-missing-client-id');
    }

    return {
      type: 'leave-room',
      roomId,
      clientId,
      sessionToken: options.sessionToken ? String(options.sessionToken) : ''
    };
  }

  function buildViewerReconnectReadyMessage(options = {}) {
    const roomId = normalizeRoomId(options.roomId);
    const clientId = String(options.clientId || '').trim();
    const upstreamPeerId = String(options.upstreamPeerId || '').trim();
    if (!roomId) {
      throw new Error('room-client-viewer-reconnect-missing-room-id');
    }
    if (!clientId) {
      throw new Error('room-client-viewer-reconnect-missing-client-id');
    }
    if (!upstreamPeerId) {
      throw new Error('room-client-viewer-reconnect-missing-upstream-peer-id');
    }

    const message = {
      type: 'viewer-reconnect-ready',
      roomId,
      clientId,
      sessionToken: options.sessionToken ? String(options.sessionToken) : '',
      chainPosition: options.chainPosition,
      upstreamPeerId
    };
    if (options.failedUpstreamPeerId) {
      message.failedUpstreamPeerId = String(options.failedUpstreamPeerId);
    }
    if (options.reason) {
      message.reason = String(options.reason);
    }
    return message;
  }

  function buildViewerReadyMessage(options = {}) {
    const roomId = normalizeRoomId(options.roomId);
    const clientId = String(options.clientId || '').trim();
    if (!roomId) {
      throw new Error('room-client-viewer-ready-missing-room-id');
    }
    if (!clientId) {
      throw new Error('room-client-viewer-ready-missing-client-id');
    }
    return {
      type: 'viewer-ready',
      roomId,
      clientId,
      sessionToken: options.sessionToken ? String(options.sessionToken) : '',
      chainPosition: options.chainPosition
    };
  }

  function joinRoomById(roomIdOrOptions, options = {}) {
    const request = typeof roomIdOrOptions === 'object' && roomIdOrOptions !== null
      ? roomIdOrOptions
      : { ...options, roomId: roomIdOrOptions };
    return sendMessage(buildJoinRoomMessage(request), request.sendOptions || {});
  }

  function createRoom(options = {}) {
    const request = options && typeof options === 'object' ? options : {};
    const message = buildCreateRoomMessage(request);
    return sendMessage(message, request.sendOptions || {});
  }

  function leaveRoom(options = {}) {
    return sendMessage(buildLeaveRoomMessage(options), options.sendOptions || { queueIfDisconnected: false });
  }

  function sendViewerReconnectReady(options = {}) {
    return sendMessage(buildViewerReconnectReadyMessage(options), options.sendOptions || {});
  }

  function sendViewerReady(options = {}) {
    return sendMessage(buildViewerReadyMessage(options), options.sendOptions || {});
  }

  VDS.roomClient = {
    installLegacyAdapter,
    getLegacyAdapter() {
      return legacyAdapter;
    },
    getPendingMessageCount() {
      return pendingMessages.length;
    },
    isWebSocketOpen,
    isConnected() {
      return wsConnected && isWebSocketOpen();
    },
    connectWebSocket,
    disconnectWebSocket,
    waitForWsConnected,
    sendRawMessage,
    sendMessage,
    enqueuePendingMessage,
    removePendingMessages,
    flushPendingMessages,
    clearPendingMessages,
    clearPendingSignalingQueues,
    registerMessageHandler,
    unregisterMessageHandler,
    getRegisteredMessageTypes,
    waitForMessage,
    handleUnhandledMessage,
    dispatchMessage,
    buildCreateRoomMessage,
    buildJoinRoomMessage,
    buildLeaveRoomMessage,
    buildViewerReconnectReadyMessage,
    buildViewerReadyMessage,
    createRoom,
    joinRoomById,
    leaveRoom,
    sendViewerReconnectReady,
    sendViewerReady,
    handleMessage() {
      return dispatchMessage.apply(null, arguments);
    }
  };
})();
