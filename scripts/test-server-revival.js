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
    assert.strictEqual(snapshot.roomCount, 1);
    assert.strictEqual(snapshot.rooms[0].roomId, room.roomId);
    assert.strictEqual(snapshot.rooms[0].viewerCount, 1);
    assert.deepStrictEqual(snapshot.rooms[0].nodes.map((node) => node.id), ['private-host', 'private-viewer']);
    assert.ok(!response.body.includes(room.sessionToken));
    assert.ok(!response.body.includes(joined.sessionToken));
    assert.strictEqual(response.headers['cache-control'], 'no-store');
    assert.strictEqual(response.headers['access-control-allow-origin'], undefined);
    assert.strictEqual(response.headers['www-authenticate'], undefined);
    assert.strictEqual((await get(port, '/api/admin/rooms', { Authorization: 'Bearer stale-browser-header' })).status, 200);
    assert.strictEqual((await get(port, '/admin')).status, 200);
    assert.strictEqual((await get(port, '/api/version')).status, 200);
  });

  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const adminPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await withServer(async (instance, port) => {
    assert.strictEqual(instance.adminServer.address().address, '127.0.0.1');
    const response = await get(adminPort, '/api/rooms');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(JSON.parse(response.body).roomCount, 0);
    assert.strictEqual(response.headers['cache-control'], 'no-store');
    assert.strictEqual(response.headers['www-authenticate'], undefined);
    const mainSnapshot = await get(port, '/api/ADMIN/rooms');
    assert.strictEqual(mainSnapshot.status, 200);
    assert.strictEqual(mainSnapshot.headers['access-control-allow-origin'], undefined);
    assert.strictEqual((await get(port, '/admin')).status, 200);
    assert.strictEqual((await get(adminPort, '/')).status, 200);
  }, { adminPort, adminHost: '127.0.0.1' });
}

const tests = { oversized: testOversizedPayload, switch: testViewerCanSwitchRooms, admin: testAdminDirectAccess };

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
