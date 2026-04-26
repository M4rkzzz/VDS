const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { startServer, generateRoomId, validateInboundMessage } = require('../server/server-core');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testMediaManifest(overrides = {}) {
  return {
    protocol: 'vds-media-encoded-v1',
    protocolVersion: 1,
    mediaSessionId: overrides.mediaSessionId || 'media-test',
    manifestVersion: overrides.manifestVersion || 1,
    sourceType: overrides.sourceType || 'native-capture',
    updatedAt: Date.now(),
    video: {
      codec: overrides.videoCodec || 'h264',
      payloadFormat: 'annexb',
      width: 1920,
      height: 1080,
      fps: 60,
      keyframeIntervalMs: 1000,
      configVersion: 1,
      config: {}
    },
    audio: {
      codec: overrides.audioCodec || 'opus',
      payloadFormat: overrides.audioCodec === 'aac' ? 'aac-adts' : 'opus-raw',
      sampleRate: 48000,
      channels: 2,
      frameDurationMs: overrides.audioCodec === 'aac' ? 23 : 20,
      configVersion: 1,
      config: {}
    }
  };
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

function collectMessages(ws, durationMs) {
  return new Promise((resolve) => {
    const messages = [];
    const handler = (message) => messages.push(JSON.parse(String(message)));
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, durationMs);
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

async function withStaticServer(publicDir, testFn) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const instance = startServer({
    port,
    publicDir,
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

function getHttp(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      headers
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function testResumeTokenProtection() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-a', mediaManifest: testMediaManifest() }));
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
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-grace', mediaManifest: testMediaManifest() }));
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
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-expire', mediaManifest: testMediaManifest() }));
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

async function testViewerMediaCapabilitiesAreForwarded() {
  await withServer(async (port) => {
    const mediaCapabilities = {
      webViewer: true,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-cap', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const firstViewer = await openWs(port);
    firstViewer.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-cap-a',
      mediaCapabilities
    }));
    const joinedFirst = await onceMessage(firstViewer);
    assert.strictEqual(joinedFirst.type, 'room-joined');
    assert.strictEqual(joinedFirst.mediaCapabilities.encodedMediaDataChannel.protocol, 'vds-media-encoded-v1');
    assert.strictEqual(joinedFirst.mediaManifest.video.codec, 'h264');

    const hostNotice = await onceMessage(host);
    assert.strictEqual(hostNotice.type, 'viewer-joined');
    assert.strictEqual(hostNotice.viewerMediaCapabilities.encodedMediaDataChannel.protocolVersion, 1);
    assert.strictEqual(hostNotice.mediaManifest.protocol, 'vds-media-encoded-v1');

    firstViewer.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-cap-a',
      chainPosition: 0
    }));

    const secondViewer = await openWs(port);
    secondViewer.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-cap-b',
      mediaCapabilities
    }));
    const joinedSecond = await onceMessage(secondViewer);
    assert.strictEqual(joinedSecond.type, 'room-joined');

    const connectNext = await onceMessage(firstViewer);
    assert.strictEqual(connectNext.type, 'connect-to-next');
    assert.strictEqual(connectNext.nextViewerMediaCapabilities.encodedMediaDataChannel.protocol, 'vds-media-encoded-v1');
    assert.strictEqual(connectNext.mediaManifest.audio.codec, 'opus');

    host.close();
    firstViewer.close();
    secondViewer.close();
  });
}

async function testViewerReconnectReadyRenotifiesHost() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-reconnect', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const firstViewer = await openWs(port);
    firstViewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-reconnect-a' }));
    const joinedFirst = await onceMessage(firstViewer);
    assert.strictEqual(joinedFirst.type, 'room-joined');
    const firstHostNotice = await onceMessage(host);
    assert.strictEqual(firstHostNotice.type, 'viewer-joined');

    firstViewer.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-reconnect-a',
      chainPosition: 0
    }));

    const secondViewer = await openWs(port);
    secondViewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-reconnect-b' }));
    const joinedSecond = await onceMessage(secondViewer);
    assert.strictEqual(joinedSecond.type, 'room-joined');
    const connectNext = await onceMessage(firstViewer);
    assert.strictEqual(connectNext.type, 'connect-to-next');

    const hostMessagesAfterLeavePromise = collectMessages(host, 80);
    firstViewer.send(JSON.stringify({ type: 'leave-room', roomId: created.roomId, clientId: 'viewer-reconnect-a' }));
    const chainReconnect = await onceMessage(secondViewer);
    assert.strictEqual(chainReconnect.type, 'chain-reconnect');
    assert.strictEqual(chainReconnect.upstreamPeerId, 'host-reconnect');
    assert.strictEqual(chainReconnect.mediaManifest.protocol, 'vds-media-encoded-v1');
    const hostMessagesAfterLeave = await hostMessagesAfterLeavePromise;
    assert.ok(hostMessagesAfterLeave.some((message) => message.type === 'viewer-count-updated'));
    assert.ok(hostMessagesAfterLeave.some((message) => message.type === 'viewer-left'));
    assert.ok(!hostMessagesAfterLeave.some((message) => message.type === 'viewer-joined'));

    secondViewer.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-reconnect-b',
      chainPosition: 0,
      upstreamPeerId: 'host-reconnect'
    }));
    const forcedReconnect = await onceMessage(host);
    assert.strictEqual(forcedReconnect.type, 'viewer-joined');
    assert.strictEqual(forcedReconnect.viewerId, 'viewer-reconnect-b');
    assert.strictEqual(forcedReconnect.reconnect, true);

    host.close();
    firstViewer.close();
    secondViewer.close();
  });
}

async function testJoinRequiresHostMediaManifest() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-no-manifest' }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewer = await openWs(port);
    viewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-no-manifest' }));
    const rejected = await onceMessage(viewer);
    assert.strictEqual(rejected.code, 'host-media-manifest-missing');

    host.send(JSON.stringify({
      type: 'host-media-manifest',
      roomId: created.roomId,
      clientId: 'host-no-manifest',
      sessionToken: created.sessionToken,
      mediaManifest: testMediaManifest({ mediaSessionId: 'media-updated' })
    }));
    const ack = await onceMessage(host);
    assert.strictEqual(ack.type, 'host-media-manifest-ack');
    assert.strictEqual(ack.mediaSessionId, 'media-updated');

    viewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-no-manifest' }));
    const joined = await onceMessage(viewer);
    assert.strictEqual(joined.type, 'room-joined');
    assert.strictEqual(joined.mediaManifest.mediaSessionId, 'media-updated');

    host.close();
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

async function testBrowserRootUsesVdsWebWhenBuilt() {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-static-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), 'electron-entry');
  fs.mkdirSync(path.join(publicDir, 'vds_web'));
  fs.writeFileSync(path.join(publicDir, 'vds_web', 'index.html'), 'web-entry');

  try {
    await withStaticServer(publicDir, async (port) => {
      const browser = await getHttp(port, '/', { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0' });
      assert.strictEqual(browser.statusCode, 200);
      assert.strictEqual(browser.body, 'web-entry');

      const electron = await getHttp(port, '/', { 'User-Agent': 'Mozilla/5.0 Electron/39.0.0' });
      assert.strictEqual(electron.statusCode, 200);
      assert.strictEqual(electron.body, 'electron-entry');
    });
  } finally {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
}

(async () => {
  testGenerateRoomIdAvoidsCollision();
  testValidateInboundMessageRateLimit();
  await testBrowserRootUsesVdsWebWhenBuilt();
  await testResumeTokenProtection();
  await testJoinRequiresHostMediaManifest();
  await testViewerMediaCapabilitiesAreForwarded();
  await testViewerReconnectReadyRenotifiesHost();
  await testHostGraceResumeKeepsRoom();
  await testHostGraceExpiryDestroysRoomAndToken();
  console.log('server-core tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
