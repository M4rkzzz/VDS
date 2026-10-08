const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../server/public/room-client.js'), 'utf8');

function createHarness() {
  const sockets = [];
  const timers = new Map();
  const events = [];
  let timerId = 0;
  let resumeMessage = null;
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen(); }
    finishClose() { this.readyState = 3; this.onclose(); }
    error() { this.onerror(new Error('socket failed')); }
    message(data) { return this.onmessage({ data: JSON.stringify(data) }); }
  }
  const context = {
    window: {}, WebSocket: FakeWebSocket,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.runInNewContext(source, context, { filename: 'room-client.js' });
  const client = context.window.VDS.roomClient;
  client.installLegacyAdapter({
    getWebSocketUrl: () => 'ws://signaling.test',
    onWebSocketOpen: () => events.push('open'),
    onWebSocketClose: ({ manualClose }) => events.push(manualClose ? 'manual-close' : 'unexpected-close'),
    onWebSocketDisconnected: () => events.push('disconnect'),
    onWebSocketUnexpectedClose: () => { events.push('resume-needed'); return true; },
    onReconnectScheduled: () => events.push('reconnect'),
    consumeResumeSessionMessage: () => { const message = resumeMessage; resumeMessage = null; return message; }
  });
  return {
    client, sockets, timers, events, context,
    setResumeMessage: (message) => { resumeMessage = message; },
    runNextTimer: () => {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      return timer.delay;
    }
  };
}

function installRealAppAdapter(harness, session = {}) {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../../server/public/app.js'), 'utf8');
  const adapterStart = appSource.lastIndexOf("if (window.VDS && window.VDS.roomClient && typeof window.VDS.roomClient.installLegacyAdapter === 'function')");
  assert.ok(adapterStart >= 0);
  Object.assign(harness.context, {
    wsBaseUrl: 'ws://signaling.test', wsConnected: false, resumeOnNextConnect: false,
    currentRoomId: 'ABCDEF123456', sessionRole: 'viewer', currentSessionToken: null,
    clientId: 'viewer1', upstreamConnected: false, isHost: false, elements: {},
    debugLog() {}, syncAppState() {}, joinRoomById() {}, leaveRoom() {}, handleMessage() {},
    ...session
  });
  vm.runInNewContext(appSource.slice(adapterStart), harness.context, { filename: 'app.js room-client adapter' });
}

test('normal connection shares its pending attempt and flushes queued messages once', async () => {
  const { client, sockets } = createHarness();
  const connection = client.connectWebSocket();
  assert.equal(client.connectWebSocket(), connection);
  client.joinRoomById({ roomId: ' room1 ', clientId: 'viewer1' });
  assert.equal(sockets.length, 1);
  sockets[0].open();
  await connection;
  assert.equal(client.isConnected(), true);
  assert.equal(client.getPendingMessageCount(), 0);
  assert.deepEqual(sockets[0].sent.map(({ type, roomId }) => ({ type, roomId })), [{ type: 'join-room', roomId: 'ROOM1' }]);
  const received = [];
  client.registerMessageHandler('joined-room', data => received.push(data.roomId));
  await sockets[0].message({ type: 'joined-room', roomId: 'ROOM1' });
  assert.deepEqual(received, ['ROOM1']);
});

test('a late close from a manually closed socket cannot disconnect its replacement', async () => {
  const { client, sockets, events, timers } = createHarness();
  const first = client.connectWebSocket();
  sockets[0].open();
  await first;
  client.disconnectWebSocket();
  const second = client.connectWebSocket();
  sockets[1].open();
  await second;
  sockets[0].finishClose();
  assert.equal(client.isConnected(), true);
  assert.equal(client.isWebSocketOpen(), true);
  assert.equal(events.includes('resume-needed'), false);
  assert.equal(events.includes('reconnect'), false);
  assert.equal(timers.size, 0);
});

test('late messages from a replaced socket cannot mutate the new session', async () => {
  const { client, sockets } = createHarness();
  const received = [];
  client.registerMessageHandler('room-closed', data => received.push(data.roomId));
  const first = client.connectWebSocket();
  sockets[0].open();
  await first;
  client.disconnectWebSocket();
  const second = client.connectWebSocket();
  sockets[1].open();
  await second;
  await sockets[0].message({ type: 'room-closed', roomId: 'OLD' });
  await sockets[1].message({ type: 'room-closed', roomId: 'CURRENT' });
  assert.deepEqual(received, ['CURRENT']);
});

test('manual cancellation settles a pending connection and ignores its late open and error', async () => {
  const { client, sockets, events } = createHarness();
  const first = client.connectWebSocket();
  const firstOutcome = first.then(() => 'opened', error => error.message);
  client.disconnectWebSocket();
  const second = client.connectWebSocket();
  const outcome = await Promise.race([firstOutcome, new Promise(resolve => setImmediate(() => resolve('still-pending')))]);
  assert.equal(outcome, 'websocket-connect-cancelled');
  sockets[0].open();
  sockets[0].error();
  assert.equal(client.connectWebSocket(), second);
  assert.equal(client.isConnected(), false);
  assert.equal(events.filter(event => event === 'open').length, 0);
  sockets[1].open();
  await second;
  assert.equal(client.isConnected(), true);
});

test('unexpected disconnect reconnects and resumes before flushing media messages', async () => {
  const harness = createHarness();
  const { client, sockets, events } = harness;
  const first = client.connectWebSocket();
  sockets[0].open();
  await first;
  sockets[0].finishClose();
  assert.equal(client.isConnected(), false);
  assert.equal(harness.runNextTimer(), 1000);
  harness.setResumeMessage({ type: 'resume-session', roomId: 'ROOM1', clientId: 'viewer1', sessionToken: 'token' });
  client.enqueuePendingMessage({ type: 'join-room', roomId: 'ROOM1', clientId: 'viewer1' });
  client.enqueuePendingMessage({ type: 'viewer-ready', roomId: 'ROOM1', clientId: 'viewer1' });
  const reconnect = client.connectWebSocket();
  sockets[1].open();
  await reconnect;
  assert.equal(client.isConnected(), true);
  assert.deepEqual(sockets[1].sent.map(message => message.type), ['resume-session', 'viewer-ready']);
  assert.equal(events.filter(event => event === 'resume-needed').length, 1);
});

test('closing before open rejects the connection and permits a subsequent retry', async () => {
  const { client, sockets } = createHarness();
  const connection = client.connectWebSocket();
  const closed = connection.then(() => 'opened', error => error.message);
  sockets[0].finishClose();
  assert.equal(await Promise.race([closed, new Promise(resolve => setImmediate(() => resolve('still-pending')))]), 'websocket-connect-closed');
  const retry = client.connectWebSocket();
  sockets[1].open();
  await retry;
  assert.equal(client.isConnected(), true);
});

test('a connection error rejects once and its obsolete close cannot cancel a retry', async () => {
  const { client, sockets, events } = createHarness();
  const first = client.connectWebSocket();
  const failed = assert.rejects(first, /websocket-connect-failed/);
  sockets[0].error();
  await failed;
  const unexpectedCloseCount = events.filter(event => event === 'resume-needed').length;
  const second = client.connectWebSocket();
  sockets[0].finishClose();
  assert.equal(client.connectWebSocket(), second);
  sockets[1].open();
  await second;
  assert.equal(client.isConnected(), true);
  assert.equal(events.filter(event => event === 'resume-needed').length, unexpectedCloseCount);
});

test('initial connection failure automatically retries after close and opens normally', async () => {
  const harness = createHarness();
  const { client, sockets, events } = harness;
  client.sendMessage({ type: 'join-room', roomId: 'ROOM1', clientId: 'viewer1' });
  sockets[0].error();
  sockets[0].finishClose();
  assert.equal(events.includes('reconnect'), true);
  assert.equal(harness.runNextTimer(), 1000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.isConnected(), true);
  assert.deepEqual(sockets[1].sent.map(message => message.type), ['join-room']);
  assert.equal(client.getPendingMessageCount(), 0);
});

test('manual disconnection cancels a scheduled retry and clears pending messages', async () => {
  const { client, sockets, timers } = createHarness();
  client.sendMessage({ type: 'join-room', roomId: 'ROOM1', clientId: 'viewer1' });
  sockets[0].error();
  sockets[0].finishClose();
  assert.equal(timers.size, 1);
  client.disconnectWebSocket();
  assert.equal(timers.size, 0);
  assert.equal(client.getPendingMessageCount(), 0);
  assert.equal(client.isConnected(), false);
  await new Promise(resolve => setImmediate(resolve));
});

test('a black-holed handshake is closed and retried even when the socket never emits close', async () => {
  const harness = createHarness();
  const { client, sockets, events, timers } = harness;
  const first = client.connectWebSocket();
  const failed = assert.rejects(first, /websocket-timeout/);
  assert.equal(harness.runNextTimer(), 10000);
  await failed;
  assert.equal(sockets[0].readyState, 2);
  assert.equal(events.filter(event => event === 'reconnect').length, 1);
  assert.equal(harness.runNextTimer(), 1000);
  const retry = client.connectWebSocket();
  assert.equal(sockets.length, 2);
  sockets[0].open();
  sockets[0].finishClose();
  assert.equal(client.isConnected(), false);
  sockets[1].open();
  await retry;
  assert.equal(client.isConnected(), true);
  assert.equal(timers.size, 0);
});

test('a caller deadline cancels a shared handshake instead of reusing a stuck connection', async () => {
  const { client, sockets, timers } = createHarness();
  const first = client.connectWebSocket();
  const firstFailure = assert.rejects(first, /websocket-timeout/);
  const wait = client.waitForWsConnected(20);
  const waitFailure = assert.rejects(wait, /websocket-timeout/);
  const [id, deadline] = [...timers].find(([, timer]) => timer.delay === 20);
  timers.delete(id);
  deadline.callback();
  await Promise.all([firstFailure, waitFailure]);
  const replacement = client.connectWebSocket();
  assert.notEqual(replacement, first);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].readyState, 2);
  sockets[1].open();
  await replacement;
  assert.equal(timers.size, 0);
});

test('successful connection cancels both the internal handshake and caller deadline timers', async () => {
  const { client, sockets, timers } = createHarness();
  const wait = client.waitForWsConnected(30);
  sockets[0].open();
  await wait;
  assert.equal(timers.size, 0);
});

test('actual app adapter retries first join after a handshake failure without an empty-token resume', async () => {
  const harness = createHarness();
  installRealAppAdapter(harness);
  const { client, sockets } = harness;
  client.joinRoomById({ roomId: ' abcdef123456 ', clientId: 'viewer1' });
  sockets[0].error();
  assert.equal(harness.runNextTimer(), 1000);
  sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sockets[1].sent.map(({ type, roomId }) => ({ type, roomId })), [
    { type: 'join-room', roomId: 'ABCDEF123456' }
  ]);
  assert.equal(client.getPendingMessageCount(), 0);
});

for (const type of ['join-room', 'create-room']) {
  test(`unconfirmed ${type} is resent exactly once after its socket closes after send`, async () => {
    const harness = createHarness();
    const { client, sockets } = harness;
    const isHost = type === 'create-room';
    installRealAppAdapter(harness, { sessionRole: isHost ? 'host' : 'viewer', isHost, clientId: isHost ? 'host1' : 'viewer1' });
    const message = isHost
      ? { type, clientId: 'host1', publicListing: true, mediaManifest: { mediaSessionId: 'media1', video: { codec: 'h264' } } }
      : { type, roomId: 'ABCDEF123456', clientId: 'viewer1', viewerAudioDelayMs: 250 };
    client.sendMessage(message);
    sockets[0].open();
    const firstSent = sockets[0].sent[0];
    sockets[0].finishClose();
    assert.equal(harness.runNextTimer(), 1000);
    sockets[1].open();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sockets[1].sent, [firstSent]);
    assert.equal(client.getPendingMessageCount(), 0);
  });
}

test('an acknowledged join reconnects with the actual app token and never creates a second join', async () => {
  const harness = createHarness();
  installRealAppAdapter(harness);
  const { client, sockets, context } = harness;
  client.joinRoomById({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
  sockets[0].open();
  await sockets[0].message({ type: 'room-joined', roomId: 'ABCDEF123456', sessionToken: 'confirmed-token' });
  context.currentSessionToken = 'confirmed-token';
  sockets[0].finishClose();
  harness.runNextTimer();
  sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sockets[1].sent.map(({ type, sessionToken }) => ({ type, sessionToken })), [
    { type: 'resume-session', sessionToken: 'confirmed-token' }
  ]);
});

test('a confirmed token bridges asynchronous acknowledgement cleanup if transport closes before app state commits', async () => {
  const harness = createHarness();
  installRealAppAdapter(harness);
  const { client, sockets, context } = harness;
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  client.registerMessageHandler('room-joined', async () => {
    await cleanup;
    context.currentSessionToken = 'confirmed-token';
  });
  client.joinRoomById({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
  sockets[0].open();
  const handling = sockets[0].message({ type: 'room-joined', roomId: 'ABCDEF123456', sessionToken: 'confirmed-token' });
  assert.equal(context.currentSessionToken, null);
  sockets[0].finishClose();
  harness.runNextTimer();
  sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sockets[1].sent.map(({ type, sessionToken }) => ({ type, sessionToken })), [
    { type: 'resume-session', sessionToken: 'confirmed-token' }
  ]);
  finishCleanup();
  await handling;
});

test('real native join cleanup commits before replacement resume and offer handling', async () => {
  const harness = createHarness();
  installRealAppAdapter(harness);
  const { client, sockets, context } = harness;
  for (const file of ['native/native-room-message-controller.js', 'native/native-peer-message-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../server/public', file), 'utf8'), context, { filename: file });
  }
  let finishCleanup;
  const firstCleanup = new Promise(resolve => { finishCleanup = resolve; });
  let cleanupCount = 0;
  let pending = true;
  const phases = [];
  const setSession = ({ roomId, sessionToken, role = 'viewer' }) => Object.assign(context, {
    currentRoomId: roomId, currentSessionToken: sessionToken, sessionRole: role
  });
  context.window.VDS.nativeRoomMessages.createController({
    roomClient: client, getClientId: () => context.clientId,
    getSessionRole: () => context.sessionRole, getCurrentRoomId: () => context.currentRoomId,
    getCurrentSessionToken: () => context.currentSessionToken, getViewerJoinGeneration: () => 1,
    isViewerJoinPending: () => pending,
    clearAllPeerConnections: () => ++cleanupCount === 1 ? firstCleanup : Promise.resolve(),
    setViewerRoomState: setSession, setSessionRoomState: setSession,
    setViewerResumeState: value => Object.assign(context, value),
    handleViewerJoinSucceeded: () => { pending = false; },
    syncRendererAppState: reason => phases.push(reason)
  }).registerHandlers();
  context.window.VDS.nativePeerMessages.createController({
    roomClient: client, isHost: () => false, getCurrentRoomId: () => context.currentRoomId,
    nativePeerController: {
      getSignalAttemptId: () => 1, normalizeSessionDescription: description => description,
      prepareViewerUpstreamSwitch: () => ({}),
      handleRemoteOffer: async () => {
        assert.ok(phases.includes('session-resumed-viewer'));
        assert.equal(context.currentSessionToken, 'confirmed-token');
        phases.push('offer-applied');
        return { action: 'applied', handle: {} };
      },
      attachViewerRemoteOfferSurface: async () => {},
      flushQueuedAndCreateAnswer: async (_peer, _handle, options) => {
        assert.equal(options.roomId, 'ABCDEF123456');
        phases.push('answer-created');
        return {};
      },
      applyQueuedRemoteCandidateFlushResult() {}
    }
  }).registerHandlers();
  client.joinRoomById({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
  sockets[0].open();
  const ack = { type: 'room-joined', roomId: 'ABCDEF123456', sessionToken: 'confirmed-token', hostId: 'host1', chainPosition: 0 };
  const joining = sockets[0].message(ack);
  sockets[0].finishClose();
  harness.runNextTimer();
  sockets[1].open();
  const resuming = sockets[1].message({ ...ack, type: 'session-resumed', role: 'viewer', chainPosition: 2 });
  const offering = sockets[1].message({ type: 'offer', fromClientId: 'host1', sdp: { type: 'offer', sdp: 'test-offer' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phases.length, 0);
  finishCleanup();
  await Promise.all([joining, resuming, offering]);
  assert.equal(context.currentSessionToken, 'confirmed-token');
  assert.equal(context.chainPosition, 2);
  assert.equal(cleanupCount, 2);
  assert.ok(phases.indexOf('room-joined') < phases.indexOf('session-resumed-viewer'));
  assert.ok(phases.indexOf('session-resumed-viewer') < phases.indexOf('offer-applied'));
  assert.ok(phases.includes('answer-created'));
});

test('explicit cancellation releases a stuck ACK barrier without waiting for native cleanup', async () => {
  const harness = createHarness();
  const { client, sockets } = harness;
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  client.registerMessageHandler('room-joined', () => cleanup);
  const received = [];
  client.registerMessageHandler('probe', data => received.push(data.value));
  client.joinRoomById({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
  sockets[0].open();
  const joining = sockets[0].message({ type: 'room-joined', roomId: 'ABCDEF123456', sessionToken: 'confirmed-token' });
  const probing = sockets[0].message({ type: 'probe', value: 'after-cancel' });
  client.clearPendingSignalingQueues('join-cancelled');
  await probing;
  assert.deepEqual(received, ['after-cancel']);
  finishCleanup();
  await joining;
});

for (const type of ['join-room', 'create-room']) {
  test(`${type} acknowledgements settle retry intent even without an app resume adapter`, async () => {
    const harness = createHarness();
    const { client, sockets } = harness;
    client.sendMessage({ type, roomId: 'ABCDEF123456', clientId: 'client1', mediaManifest: { mediaSessionId: 'media1' } });
    sockets[0].open();
    await sockets[0].message({ type: type === 'join-room' ? 'room-joined' : 'room-created', roomId: 'ABCDEF123456',
      sessionToken: 'confirmed-token', mediaManifest: { mediaSessionId: 'media1' } });
    sockets[0].finishClose();
    harness.runNextTimer();
    sockets[1].open();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sockets[1].sent, []);
  });
}

test('room-not-found stops retrying the rejected room after another transport failure', async () => {
  const harness = createHarness();
  const { client, sockets } = harness;
  client.joinRoomById({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
  sockets[0].open();
  await sockets[0].message({ type: 'error', code: 'room-not-found' });
  sockets[0].finishClose();
  harness.runNextTimer();
  sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sockets[1].sent, []);
});

for (const cancel of ['remove-pending', 'leave-room', 'clear-queues', 'disconnect']) {
  test(`${cancel} cancels a sent but unconfirmed join so reconnection cannot resurrect it`, async () => {
    const harness = createHarness();
    const { client, sockets } = harness;
    client.joinRoomById({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
    sockets[0].open();
    if (cancel === 'remove-pending') client.removePendingMessages(data => data.type === 'join-room');
    else if (cancel === 'leave-room') client.leaveRoom({ roomId: 'ABCDEF123456', clientId: 'viewer1' });
    else if (cancel === 'clear-queues') client.clearPendingSignalingQueues('cancelled');
    else client.disconnectWebSocket();
    if (cancel !== 'disconnect') {
      sockets[0].finishClose();
      harness.runNextTimer();
    } else client.connectWebSocket();
    sockets[1].open();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sockets[1].sent, []);
  });
}
