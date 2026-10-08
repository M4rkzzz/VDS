const assert = require('assert');
const http = require('http');
const { once } = require('events');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const { startServer } = require('../server/server-core');

const manifest = {
  protocol: 'vds-media-encoded-v1', protocolVersion: 1,
  mediaSessionId: 'revival-test', manifestVersion: 1,
  video: { codec: 'h264', payloadFormat: 'annexb', width: 1280, height: 720, fps: 30 },
  audio: { codec: 'opus', payloadFormat: 'opus-raw', sampleRate: 48000, channels: 2 }
};

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}

function request(ws, data) {
  const response = once(ws, 'message');
  ws.send(JSON.stringify(data));
  return response.then(([value]) => JSON.parse(String(value)));
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

async function withServer(test, options = {}) {
  const instance = startServer({ port: 0, disconnectGraceMs: 10, ...options });
  await once(instance.server, 'listening');
  if (instance.adminServer && !instance.adminServer.listening) await once(instance.adminServer, 'listening');
  try {
    await test(instance, instance.server.address().port);
  } finally {
    for (const socket of instance.wss.clients) socket.terminate();
    await new Promise((resolve) => instance.wss.close(resolve));
    await new Promise((resolve) => instance.server.close(resolve));
    if (instance.adminServer) await new Promise((resolve) => instance.adminServer.close(resolve));
  }
}

async function testOversizedPayload() {
  // Run separately so an unhandled server socket error is detected as a process crash.
  const child = spawnSync(process.execPath, [__filename, '--oversize-child'], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(child.status, 0, `oversized payload crashed the server: ${child.stderr}`);
  assert.match(child.stdout, /oversize isolation passed/);
}

async function oversizedChild() {
  await withServer(async (_instance, port) => {
    const ws = await connect(port);
    const closed = once(ws, 'close');
    ws.send('x'.repeat(1025));
    const [code] = await closed;
    assert.strictEqual(code, 1009);
    assert.strictEqual((await get(port, '/api/version')).status, 200);
    const healthy = await connect(port);
    assert.strictEqual((await request(healthy, { type: 'create-room', clientId: 'healthy' })).type, 'room-created');
  }, { maxPayload: 1024 });
  console.log('oversize isolation passed');
}

async function testViewerCanSwitchRooms() {
  await withServer(async (instance, port) => {
    const hostA = await connect(port);
    const hostB = await connect(port);
    const roomA = await request(hostA, { type: 'create-room', clientId: 'host-a', mediaManifest: manifest });
    const roomB = await request(hostB, { type: 'create-room', clientId: 'host-b', mediaManifest: manifest });
    const viewer = await connect(port);
    const joined = await request(viewer, { type: 'join-room', roomId: roomA.roomId, clientId: 'switcher' });
    viewer.send(JSON.stringify({ type: 'leave-room', roomId: roomA.roomId, clientId: 'switcher', sessionToken: joined.sessionToken }));
    const nextJoined = await request(viewer, { type: 'join-room', roomId: roomB.roomId, clientId: 'switcher' });
    assert.strictEqual(nextJoined.type, 'room-joined', JSON.stringify(nextJoined));
    assert.strictEqual(instance.rooms.get(roomA.roomId).viewers.length, 0);
    assert.strictEqual(instance.rooms.get(roomB.roomId).viewers.length, 1);
    viewer.send(JSON.stringify({ type: 'leave-room', roomId: roomA.roomId, clientId: 'switcher', sessionToken: joined.sessionToken }));
    assert.strictEqual((await request(viewer, { type: 'join-room', roomId: roomA.roomId, clientId: 'switcher-other' })).code, 'socket-already-bound');
    assert.strictEqual(instance.rooms.get(roomB.roomId).viewers.length, 1);
  });
}

async function testAdminDirectAccess() {
  await withServer(async (_instance, port) => {
    const host = await connect(port);
    const room = await request(host, { type: 'create-room', clientId: 'private-host', mediaManifest: manifest });
    const viewer = await connect(port);
    const joined = await request(viewer, { type: 'join-room', roomId: room.roomId, clientId: 'private-viewer' });
    assert.deepStrictEqual(JSON.parse((await get(port, '/api/public-rooms')).body).rooms, []);
    const response = await get(port, '/api/admin/rooms');
    assert.strictEqual(response.status, 200);
    const snapshot = JSON.parse(response.body);
    assert.strictEqual(snapshot.scope, 'public-rooms');
    assert.strictEqual(snapshot.roomCount, 0);
    assert.deepStrictEqual(snapshot.rooms, []);
    for (const privateValue of [room.roomId, 'private-host', 'private-viewer', manifest.mediaSessionId]) {
      assert.ok(!response.body.includes(privateValue), `public snapshot leaked ${privateValue}`);
    }
    assert.ok(!response.body.includes(room.sessionToken));
    assert.ok(!response.body.includes(joined.sessionToken));
    assert.strictEqual(response.headers['cache-control'], 'no-store');
    assert.strictEqual(response.headers['access-control-allow-origin'], undefined);
    assert.strictEqual(response.headers['www-authenticate'], undefined);
    assert.strictEqual((await get(port, '/api/admin/rooms', { Authorization: 'Bearer stale-browser-header' })).status, 200);
    assert.strictEqual((await get(port, '/admin')).status, 200);
    assert.strictEqual((await get(port, '/api/version')).status, 200);
    const publicHost = await connect(port);
    const publicRoom = await request(publicHost, { type: 'create-room', clientId: 'public-host', publicListing: true, mediaManifest: manifest });
    const publicSnapshot = JSON.parse((await get(port, '/api/admin/rooms')).body);
    assert.strictEqual(publicSnapshot.roomCount, 1);
    assert.strictEqual(publicSnapshot.rooms[0].roomId, publicRoom.roomId);
  });

  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const adminPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await withServer(async (instance, port) => {
    assert.strictEqual(instance.adminServer.address().address, '127.0.0.1');
    const host = await connect(port);
    const room = await request(host, { type: 'create-room', clientId: 'internal-host', mediaManifest: manifest });
    const viewer = await connect(port);
    const joined = await request(viewer, { type: 'join-room', roomId: room.roomId, clientId: 'internal-viewer' });
    const response = await get(adminPort, '/api/rooms');
    assert.strictEqual(response.status, 200);
    const snapshot = JSON.parse(response.body);
    assert.strictEqual(snapshot.scope, 'all-rooms');
    assert.strictEqual(snapshot.roomCount, 1);
    assert.strictEqual(snapshot.rooms[0].roomId, room.roomId);
    assert.deepStrictEqual(snapshot.rooms[0].nodes.map((node) => node.id), ['internal-host', 'internal-viewer']);
    assert.ok(!response.body.includes(room.sessionToken));
    assert.ok(!response.body.includes(joined.sessionToken));
    assert.strictEqual(response.headers['cache-control'], 'no-store');
    assert.strictEqual(response.headers['www-authenticate'], undefined);
    const mainSnapshot = await get(port, '/api/ADMIN/rooms');
    assert.strictEqual(mainSnapshot.status, 200);
    assert.strictEqual(JSON.parse(mainSnapshot.body).roomCount, 0);
    assert.strictEqual(mainSnapshot.headers['access-control-allow-origin'], undefined);
    assert.strictEqual((await get(port, '/admin')).status, 200);
    assert.strictEqual((await get(adminPort, '/')).status, 200);
  }, { adminPort, adminHost: '127.0.0.1' });
}

async function testViewerIdentityCollision() {
  await withServer(async (instance, port) => {
    const host = await connect(port);
    const room = await request(host, { type: 'create-room', clientId: 'owner', mediaManifest: manifest });
    assert.match(room.roomId, /^[2-9A-HJ-NP-Z]{6}$/);
    for (const clientId of ['host', 'HOST', ' host ', 'owner', '']) {
      const attacker = await connect(port);
      const rejected = await request(attacker, { type: 'join-room', roomId: room.roomId, clientId });
      assert.strictEqual(rejected.code, 'client-id-unavailable');
    }
    assert.strictEqual(instance.rooms.get(room.roomId).viewers.length, 0);
    const viewer = await connect(port);
    const joined = await request(viewer, { type: 'join-room', roomId: room.roomId, clientId: 'ordinary-viewer' });
    assert.strictEqual(joined.type, 'room-joined');
    const duplicate = await connect(port);
    assert.strictEqual((await request(duplicate, { type: 'join-room', roomId: room.roomId, clientId: 'ordinary-viewer' })).code, 'session-token-invalid');
    assert.strictEqual(instance.rooms.get(room.roomId).viewers.length, 1);
  });
}

async function testSignalWhitelistAndManifestBounds() {
  await withServer(async (instance, port) => {
    const host = await connect(port);
    const room = await request(host, { type: 'create-room', clientId: 'owner', mediaManifest: {
      ...manifest, video: { ...manifest.video, payloadFormat: 'x'.repeat(5000) }
    } });
    assert.strictEqual(room.mediaManifest.video.payloadFormat.length, 32);
    assert.strictEqual(instance.rooms.get(room.roomId).mediaManifest.video.payloadFormat.length, 32);
    const viewer = await connect(port);
    const hostNotice = once(host, 'message');
    const joined = await request(viewer, { type: 'join-room', roomId: room.roomId, clientId: 'viewer', mediaCapabilities: { platform: 'desktop' } });
    await hostNotice;
    const answered = once(host, 'message');
    viewer.send(JSON.stringify({ type: 'answer', roomId: 'fake-room', targetId: 'host', fromClientId: 'fake-host',
      sessionToken: 'must-not-forward', arbitrary: 'must-not-forward', mediaManifest: { marker: 'fake-manifest' },
      mediaCapabilities: { marker: 'fake-capabilities' }, sdp: { type: 'offer', sdp: 'answer-sdp', arbitrary: 'must-not-forward' }, attemptId: 7,
      candidate: 'must-not-forward' }));
    const answer = JSON.parse(String((await answered)[0]));
    assert.deepStrictEqual(answer, {
      type: 'answer', roomId: room.roomId, targetId: 'owner', fromClientId: 'viewer',
      mediaManifest: room.mediaManifest, mediaCapabilities: joined.mediaCapabilities, sdp: { type: 'answer', sdp: 'answer-sdp' }, attemptId: 7
    });
    const candidate = { candidate: 'candidate:review-only', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag', arbitrary: 'must-not-forward' };
    const iced = once(host, 'message');
    viewer.send(JSON.stringify({ type: 'ice-candidate', targetId: 'owner', candidate, attemptId: 7, trickle: true, natMapping: true, arbitrary: true }));
    const ice = JSON.parse(String((await iced)[0]));
    assert.deepStrictEqual(ice.candidate, { candidate: candidate.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag' });
    assert.strictEqual(ice.attemptId, 7);
    assert.strictEqual(ice.trickle, true);
    assert.strictEqual(ice.natMapping, true);
    assert.strictEqual(ice.arbitrary, undefined);
  });
}

async function testHeartbeatReclaimsStalledConnection() {
  await withServer(async (instance, port) => {
    const healthy = await connect(port);
    const stalled = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
    stalled.on('error', () => {});
    const ping = once(stalled, 'ping');
    const closed = once(stalled, 'close');
    await once(stalled, 'open');
    const serverSocket = Array.from(instance.wss.clients)[1];
    const serverClosed = once(serverSocket, 'close');
    let deadline;
    try {
      await Promise.race([
        Promise.all([ping, closed, serverClosed]),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('heartbeat failed to reclaim stalled connection')), 2000); })
      ]);
    } finally { clearTimeout(deadline); }
    assert.strictEqual(healthy.readyState, WebSocket.OPEN);
    assert.strictEqual(instance.wss.clients.size, 1);
    const replacement = await connect(port);
    assert.strictEqual((await request(replacement, { type: 'create-room', clientId: 'replacement', mediaManifest: manifest })).type, 'room-created');
  }, { heartbeatIntervalMs: 50, maxConnections: 2 });
}

async function testShutdownCancelsDisconnectTimers() {
  let participant;
  await withServer(async (instance, port) => {
    const host = await connect(port);
    const room = await request(host, { type: 'create-room', clientId: 'closing-host', mediaManifest: manifest });
    participant = instance.rooms.get(room.roomId).host;
    const disconnected = once(participant.ws, 'close');
    host.terminate();
    await disconnected;
    assert.ok(participant.disconnectTimer, 'disconnect recovery timer was not scheduled');
  }, { disconnectGraceMs: 60000, hostDisconnectGraceMs: 60000 });
  assert.strictEqual(participant.disconnectTimer, null, 'shutdown retained a disconnect timer');
}

const tests = { oversized: testOversizedPayload, switch: testViewerCanSwitchRooms, admin: testAdminDirectAccess,
  identity: testViewerIdentityCollision, signaling: testSignalWhitelistAndManifestBounds, heartbeat: testHeartbeatReclaimsStalledConnection,
  shutdown: testShutdownCancelsDisconnectTimers };

async function main() {
  if (process.argv.includes('--oversize-child')) return oversizedChild();
  const selection = process.argv[2];
  for (const [name, test] of Object.entries(tests)) {
    if (selection && selection !== name) continue;
    await test();
    console.log(`${name} passed`);
  }
  console.log('server revival tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
