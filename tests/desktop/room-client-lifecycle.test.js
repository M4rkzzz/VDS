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
    client, sockets, timers, events,
    setResumeMessage: (message) => { resumeMessage = message; },
    runNextTimer: () => {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      return timer.delay;
    }
  };
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
  const second = client.connectWebSocket();
  sockets[0].finishClose();
  assert.equal(client.connectWebSocket(), second);
  sockets[1].open();
  await second;
  assert.equal(client.isConnected(), true);
  assert.equal(events.includes('resume-needed'), false);
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
