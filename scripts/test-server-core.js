const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const { startServer, generateRoomId, validateInboundMessage } = require('../server/server-core');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message-timeout')), 2000);
    ws.once('message', (message) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(message)));
    });
  });
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function withServer(testFn) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const instance = startServer({
    port,
    publicDir: null,
    updatesDir: null,
    maxMessagesPerWindow: 20,
    disconnectGraceMs: 80
  });
  try {
    await testFn(port);
  } finally {
    for (const client of instance.wss.clients) {
      client.close();
    }
    await new Promise((resolve) => instance.server.close(resolve));
  }
}

async function testResumeTokenProtection() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-a' }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');
    assert.ok(created.sessionToken);

    const viewer = await openWs(port);
    viewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-a' }));
    const joined = await onceMessage(viewer);
    assert.strictEqual(joined.type, 'room-joined');
    assert.ok(joined.sessionToken);

    const attacker = await openWs(port);
    attacker.send(JSON.stringify({
      type: 'resume-session',
      roomId: created.roomId,
      clientId: 'host-a',
      role: 'host',
      sessionToken: joined.sessionToken
    }));
    const rejected = await onceMessage(attacker);
    assert.strictEqual(rejected.code, 'session-token-invalid');

    const resumedHost = await openWs(port);
    resumedHost.send(JSON.stringify({
      type: 'resume-session',
      roomId: created.roomId,
      clientId: 'host-a',
      role: 'host',
      sessionToken: created.sessionToken
    }));
    const resumed = await onceMessage(resumedHost);
    assert.strictEqual(resumed.type, 'session-resumed');
    assert.strictEqual(resumed.role, 'host');

    host.close();
    viewer.close();
    attacker.close();
    resumedHost.close();
  });
}

async function testHostGraceResumeKeepsRoom() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-grace' }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    host.close();
    await wait(20);

    const resumedHost = await openWs(port);
    resumedHost.send(JSON.stringify({
      type: 'resume-session',
      roomId: created.roomId,
      clientId: 'host-grace',
      role: 'host',
      sessionToken: created.sessionToken
    }));
    const resumed = await onceMessage(resumedHost);
    assert.strictEqual(resumed.type, 'session-resumed');
    assert.strictEqual(resumed.role, 'host');

    resumedHost.close();
  });
}

async function testHostGraceExpiryDestroysRoomAndToken() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-expire' }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    host.close();
    await wait(140);

    const resumedHost = await openWs(port);
    resumedHost.send(JSON.stringify({
      type: 'resume-session',
      roomId: created.roomId,
      clientId: 'host-expire',
      role: 'host',
      sessionToken: created.sessionToken
    }));
    const rejected = await onceMessage(resumedHost);
    assert.strictEqual(rejected.code, 'session-not-found');

    const viewer = await openWs(port);
    viewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-expire' }));
    const joinRejected = await onceMessage(viewer);
    assert.strictEqual(joinRejected.code, 'room-not-found');

    resumedHost.close();
    viewer.close();
  });
}

function testGenerateRoomIdAvoidsCollision() {
  const originalRandomBytes = crypto.randomBytes;
  const existingRooms = new Map([['AAAAAA', {}]]);
  let calls = 0;
  crypto.randomBytes = () => {
    calls += 1;
    return calls === 1
      ? Buffer.from([0xaa, 0xaa, 0xaa])
      : Buffer.from([0xbb, 0xbb, 0xbb]);
  };
  try {
    assert.strictEqual(generateRoomId(existingRooms), 'BBBBBB');
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }
}

function testValidateInboundMessageRateLimit() {
  const sent = [];
  const ws = {
    __vdsRateWindowStartedAt: Date.now(),
    __vdsRateWindowCount: 0,
    readyState: WebSocket.OPEN,
    send: (payload) => sent.push(JSON.parse(payload)),
    close: () => {}
  };
  assert.strictEqual(validateInboundMessage(ws, { type: 'ping' }, 1, 10000), true);
  assert.strictEqual(validateInboundMessage(ws, { type: 'ping' }, 1, 10000), false);
  assert.strictEqual(sent[sent.length - 1].code, 'message-rate-limit');
}

(async () => {
  testGenerateRoomIdAvoidsCollision();
  testValidateInboundMessageRateLimit();
  await testResumeTokenProtection();
  await testHostGraceResumeKeepsRoom();
  await testHostGraceExpiryDestroysRoomAndToken();
  console.log('server-core tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
