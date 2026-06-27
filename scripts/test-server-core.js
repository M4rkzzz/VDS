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

function openWs(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function withServer(testFn, serverOptions = {}) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const instance = startServer({
    port,
    publicDir: null,
    updatesDir: null,
    maxMessagesPerWindow: 20,
    disconnectGraceMs: 80,
    ...serverOptions
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
      platform: 'desktop',
      browser: 'Chrome 126\u0000\nInjected',
      browserFamily: 'chromium',
      audioOutput: true,
      relayCapable: true,
      relayEligibilityReason: 'relay-ready\u0000\nlocal',
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw'],
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
    assert.strictEqual(joinedFirst.mediaCapabilities.browser, 'Chrome 126Injected');
    assert.strictEqual(joinedFirst.mediaCapabilities.localRelayEligibilityReason, 'relay-readylocal');
    assert.strictEqual(joinedFirst.mediaCapabilities.encodedMediaDataChannel.protocol, 'vds-media-encoded-v1');
    assert.deepStrictEqual(joinedFirst.mediaCapabilities.encodedMediaDataChannel.supportedVideoPayloadFormats, ['annexb', 'avcc']);
    assert.deepStrictEqual(joinedFirst.mediaCapabilities.encodedMediaDataChannel.supportedAudioPayloadFormats, ['opus-raw', 'raw']);
    assert.strictEqual(joinedFirst.mediaManifest.video.codec, 'h264');

    const hostNotice = await onceMessage(host);
    assert.strictEqual(hostNotice.type, 'viewer-joined');
    assert.strictEqual(hostNotice.viewerMediaCapabilities.browser, 'Chrome 126Injected');
    assert.strictEqual(hostNotice.viewerMediaCapabilities.localRelayEligibilityReason, 'relay-readylocal');
    assert.strictEqual(hostNotice.viewerMediaCapabilities.encodedMediaDataChannel.protocolVersion, 1);
    assert.deepStrictEqual(hostNotice.viewerMediaCapabilities.encodedMediaDataChannel.supportedVideoPayloadFormats, ['annexb', 'avcc']);
    assert.deepStrictEqual(hostNotice.viewerMediaCapabilities.encodedMediaDataChannel.supportedAudioPayloadFormats, ['opus-raw', 'raw']);
    assert.strictEqual(hostNotice.mediaManifest.protocol, 'vds-media-encoded-v1');

    firstViewer.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-cap-a',
      sessionToken: joinedFirst.sessionToken,
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
    assert.deepStrictEqual(connectNext.nextViewerMediaCapabilities.encodedMediaDataChannel.supportedVideoPayloadFormats, ['annexb', 'avcc']);
    assert.strictEqual(connectNext.mediaManifest.audio.codec, 'opus');

    host.close();
    firstViewer.close();
    secondViewer.close();
  });
}

async function testZeroRelayCapacityViewerIsNotSelectedAsUpstream() {
  await withServer(async (port) => {
    const noRelayCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'ios',
      browser: 'Forged Chrome 999',
      browserFamily: 'safari',
      audioOutput: true,
      relayCapable: false,
      maxDirectDownstreams: 0,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-no-relay', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-no-relay-a',
      mediaCapabilities: noRelayCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.upstreamPeerId, 'host-no-relay');
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.platform, 'ios');
    assert.strictEqual(joinedA.mediaCapabilities.audioOutput, true);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-no-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-no-relay-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-no-relay');

    const hostMessages = await collectMessages(host, 120);
    assert.ok(hostMessages.some((message) => message.type === 'viewer-joined' && message.viewerId === 'viewer-no-relay-b'));
    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testNonRelayCapableWebViewerIsNotSelectedEvenWithPositiveLimit() {
  await withServer(async (port) => {
    const misleadingCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'ios',
      browser: 'Forged Chrome 999',
      browserFamily: 'safari',
      audioOutput: true,
      relayCapable: false,
      maxDirectDownstreams: 2,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-non-relay-flag', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-non-relay-flag-a',
      mediaCapabilities: misleadingCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.audioOutput, true);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-non-relay-flag-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-non-relay-flag-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-non-relay-flag');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerRejectsInvalidMobileRelayClaims() {
  await withServer(async (port) => {
    const invalidIosRelayCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'ios',
      browser: 'Forged Chrome 999',
      browserFamily: 'safari',
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 5,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-invalid-mobile-relay', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-invalid-ios-relay-a',
      mediaCapabilities: invalidIosRelayCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.platform, 'ios');
    assert.strictEqual(joinedA.mediaCapabilities.browser, 'Safari 18.0');
    assert.strictEqual(joinedA.mediaCapabilities.browserFamily, 'safari');
    assert.strictEqual(joinedA.mediaCapabilities.androidChrome, false);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-invalid-ios-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-invalid-ios-relay-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-invalid-mobile-relay');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();

    await assertForgedIosLeaf(port, invalidIosRelayCapabilities, {
      hostId: 'host-invalid-ipados-relay',
      viewerId: 'viewer-invalid-ipados-relay',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      expectedBrowser: 'Safari 18.0'
    });
    await assertForgedIosLeaf(port, invalidIosRelayCapabilities, {
      hostId: 'host-invalid-ios-chrome-relay',
      viewerId: 'viewer-invalid-ios-chrome-relay',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
      expectedBrowser: 'Chrome iOS 126.0.0.0',
      expectedBrowserFamily: 'chromium'
    });
    await assertForgedIosLeaf(port, invalidIosRelayCapabilities, {
      hostId: 'host-invalid-ios-edge-relay',
      viewerId: 'viewer-invalid-ios-edge-relay',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.0.0 Mobile/15E148 Safari/604.1',
      expectedBrowser: 'Edge iOS 126.0.0.0',
      expectedBrowserFamily: 'chromium'
    });
  });
}

async function testWebViewerWithoutRelayCapabilityIsNotSelectedAsUpstream() {
  await withServer(async (port) => {
    const legacyLikeCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browser: 'Forged Chrome 999',
      browserFamily: 'chromium',
      androidChrome: false,
      audioOutput: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-missing-relay-flag', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port);
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-missing-relay-flag-a',
      mediaCapabilities: legacyLikeCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.androidChrome, false);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-missing-relay-flag-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-missing-relay-flag-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-missing-relay-flag');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerSkipsWebRelayCandidateWithoutCodecCapability() {
  await withServer(async (port) => {
    const missingCodecCapabilities = {
      webViewer: true,
      mobile: false,
      platform: 'desktop',
      browserFamily: 'chromium',
      androidChrome: false,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 5,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-missing-codec-capability', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-missing-codec-capability-a',
      mediaCapabilities: missingCodecCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'missing-video-codec');
    assert.deepStrictEqual(joinedA.mediaCapabilities.encodedMediaDataChannel.supportedVideoCodecs, []);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-missing-codec-capability-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-missing-codec-capability-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-missing-codec-capability');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerSkipsWebRelayCandidateWithoutPayloadFormatCapability() {
  await withServer(async (port) => {
    const missingPayloadFormatCapabilities = {
      webViewer: true,
      mobile: false,
      platform: 'desktop',
      browserFamily: 'chromium',
      androidChrome: false,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-missing-payload-capability', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-missing-payload-capability-a',
      mediaCapabilities: missingPayloadFormatCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'missing-video-payload-format');
    assert.deepStrictEqual(joinedA.mediaCapabilities.encodedMediaDataChannel.supportedVideoPayloadFormats, []);
    assert.deepStrictEqual(joinedA.mediaCapabilities.encodedMediaDataChannel.supportedAudioPayloadFormats, []);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-missing-payload-capability-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-missing-payload-capability-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-missing-payload-capability');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerSkipsWebRelayCandidateWithInvalidEncodedProtocol() {
  await withServer(async (port) => {
    const invalidProtocolCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'legacy-encoded-media',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-invalid-encoded-protocol', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-invalid-encoded-protocol-a',
      mediaCapabilities: invalidProtocolCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'invalid-encoded-protocol');
    assert.strictEqual(joinedA.mediaCapabilities.encodedMediaDataChannel.protocol, 'legacy-encoded-media');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-invalid-encoded-protocol-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-invalid-encoded-protocol-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-invalid-encoded-protocol');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerSkipsWebRelayCandidateWithoutAudioOutput() {
  await withServer(async (port) => {
    const noAudioOutputCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: false,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-missing-audio-output', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-missing-audio-output-a',
      mediaCapabilities: noAudioOutputCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.audioOutput, false);
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'missing-audio-output');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-missing-audio-output-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-missing-audio-output-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-missing-audio-output');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerUsesWebSocketUserAgentForAndroidChromeRelayClaims() {
  await withServer(async (port) => {
    const forgedAndroidChromeCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-ua-relay-claim', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 OPR/84.0.0.0'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-ua-opera-forged-relay-a',
      mediaCapabilities: forgedAndroidChromeCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.platform, 'android');
    assert.strictEqual(joinedA.mediaCapabilities.browser, 'Opera 84.0.0.0');
    assert.strictEqual(joinedA.mediaCapabilities.browserFamily, 'chromium');
    assert.strictEqual(joinedA.mediaCapabilities.androidChrome, false);
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-ua-opera-forged-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-ua-opera-forged-relay-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-ua-relay-claim');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    const viewerC = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0'
    });
    viewerC.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-ua-edge-forged-relay-c',
      mediaCapabilities: forgedAndroidChromeCapabilities
    }));
    const joinedC = await onceMessage(viewerC);
    assert.strictEqual(joinedC.type, 'room-joined');
    assert.strictEqual(joinedC.mediaCapabilities.platform, 'android');
    assert.strictEqual(joinedC.mediaCapabilities.browser, 'Edge Android 126.0.0.0');
    assert.strictEqual(joinedC.mediaCapabilities.browserFamily, 'chromium');
    assert.strictEqual(joinedC.mediaCapabilities.androidChrome, false);
    assert.strictEqual(joinedC.mediaCapabilities.relayCapable, false);

    host.close();
    viewerA.close();
    viewerB.close();
    viewerC.close();

    await assertForgedAndroidLeaf(port, forgedAndroidChromeCapabilities, {
      hostId: 'host-ua-webview-relay-claim',
      viewerId: 'viewer-ua-webview-forged-relay',
      expectedBrowser: 'Android WebView 126.0.0.0',
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.240905.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    await assertForgedAndroidLeaf(port, forgedAndroidChromeCapabilities, {
      hostId: 'host-ua-huawei-relay-claim',
      viewerId: 'viewer-ua-huawei-forged-relay',
      expectedBrowser: 'Huawei Browser 15.0.0.0',
      userAgent: 'Mozilla/5.0 (Linux; Android 15; HUAWEI) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 HuaweiBrowser/15.0.0.0'
    });
  });
}

async function assertForgedIosLeaf(port, forgedCapabilities, options) {
  const host = await openWs(port);
  host.send(JSON.stringify({ type: 'create-room', clientId: options.hostId, mediaManifest: testMediaManifest() }));
  const created = await onceMessage(host);
  assert.strictEqual(created.type, 'room-created');

  const viewer = await openWs(port, { 'User-Agent': options.userAgent });
  viewer.send(JSON.stringify({
    type: 'join-room',
    roomId: created.roomId,
    clientId: options.viewerId,
    mediaCapabilities: forgedCapabilities
  }));
  const joined = await onceMessage(viewer);
  assert.strictEqual(joined.type, 'room-joined');
  assert.strictEqual(joined.mediaCapabilities.platform, 'ios');
  assert.strictEqual(joined.mediaCapabilities.browser, options.expectedBrowser);
  assert.strictEqual(joined.mediaCapabilities.browserFamily, options.expectedBrowserFamily || 'safari');
  assert.strictEqual(joined.mediaCapabilities.androidChrome, false);
  assert.strictEqual(joined.mediaCapabilities.relayCapable, false);

  host.close();
  viewer.close();
}

async function assertForgedAndroidLeaf(port, forgedCapabilities, options) {
  const host = await openWs(port);
  host.send(JSON.stringify({ type: 'create-room', clientId: options.hostId, mediaManifest: testMediaManifest() }));
  const created = await onceMessage(host);
  assert.strictEqual(created.type, 'room-created');

  const viewer = await openWs(port, { 'User-Agent': options.userAgent });
  viewer.send(JSON.stringify({
    type: 'join-room',
    roomId: created.roomId,
    clientId: options.viewerId,
    mediaCapabilities: forgedCapabilities
  }));
  const joined = await onceMessage(viewer);
  assert.strictEqual(joined.type, 'room-joined');
  assert.strictEqual(joined.mediaCapabilities.platform, 'android');
  if (options.expectedBrowser) {
    assert.strictEqual(joined.mediaCapabilities.browser, options.expectedBrowser);
  }
  assert.strictEqual(joined.mediaCapabilities.browserFamily, 'chromium');
  assert.strictEqual(joined.mediaCapabilities.androidChrome, false);
  assert.strictEqual(joined.mediaCapabilities.relayCapable, false);

  host.close();
  viewer.close();
}

async function testServerRejectsDesktopNonChromeRelayClaims() {
  await withServer(async (port) => {
    const forgedDesktopRelayCapabilities = {
      webViewer: true,
      mobile: false,
      platform: 'desktop',
      browser: 'Forged Chrome 999',
      browserFamily: 'chromium',
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-desktop-non-chrome-relay', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-desktop-firefox-forged-relay-a',
      mediaCapabilities: forgedDesktopRelayCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.platform, 'desktop');
    assert.strictEqual(joinedA.mediaCapabilities.browser, 'Firefox 126.0');
    assert.strictEqual(joinedA.mediaCapabilities.browserFamily, 'firefox');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-desktop-firefox-forged-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-desktop-firefox-forged-relay-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-desktop-non-chrome-relay');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerRejectsAndroidChromeRelayWithoutPayloadMatrix() {
  await withServer(async (port) => {
    const incompletePayloadCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-android-payload-matrix', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-android-payload-matrix-a',
      mediaCapabilities: incompletePayloadCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'missing-android-relay-codec-matrix');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-android-payload-matrix-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-android-payload-matrix-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-android-payload-matrix');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerSkipsWebRelayCandidateWhenManifestUnsupported() {
  await withServer(async (port) => {
    const h264OnlyRelayCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-h265-web-relay-filter', mediaManifest: testMediaManifest({ videoCodec: 'h265' }) }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-h264-only-relay-a',
      mediaCapabilities: h264OnlyRelayCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.upstreamPeerId, 'host-h265-web-relay-filter');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, false);
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 0);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'missing-android-relay-codec-matrix');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-h264-only-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-h265-downstream-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-h265-web-relay-filter');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testServerAllowsWebRelayCandidateWithCodecAliases() {
  await withServer(async (port) => {
    const aliasCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 5,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['avc1.640028', 'hvc1.1.6.L120.B0'],
        supportedAudioCodecs: ['opus', 'mp4a.40.2'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-alias-web-relay', mediaManifest: testMediaManifest({ videoCodec: 'h265', audioCodec: 'aac' }) }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-alias-relay-a',
      mediaCapabilities: aliasCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 1);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-alias-web-relay');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-alias-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-alias-downstream-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-alias-relay-a');
    assert.strictEqual((await onceMessage(viewerA)).type, 'connect-to-next');

    host.close();
    viewerA.close();
    viewerB.close();
  });
}


async function testAndroidChromeRelayCapacityIsCappedToOneDownstream() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-android-cap', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const androidChromeCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: true,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 5,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-android-cap-a',
      mediaCapabilities: androidChromeCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, true);
    assert.strictEqual(joinedA.mediaCapabilities.maxDirectDownstreams, 1);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-android-cap');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');
    viewerA.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-android-cap-a', sessionToken: joinedA.sessionToken, chainPosition: 0 }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-android-cap-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-android-cap-a');
    const connectB = await onceMessage(viewerA);
    assert.strictEqual(connectB.type, 'connect-to-next');
    assert.strictEqual(connectB.nextViewerId, 'viewer-android-cap-b');
    viewerB.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-android-cap-b', sessionToken: joinedB.sessionToken, chainPosition: 1 }));

    const viewerC = await openWs(port);
    viewerC.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-android-cap-c' }));
    const joinedC = await onceMessage(viewerC);
    assert.strictEqual(joinedC.type, 'room-joined');
    assert.strictEqual(joinedC.upstreamPeerId, 'viewer-android-cap-b');
    const connectC = await onceMessage(viewerB);
    assert.strictEqual(connectC.type, 'connect-to-next');
    assert.strictEqual(connectC.nextViewerId, 'viewer-android-cap-c');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next' && message.nextViewerId === 'viewer-android-cap-c'));

    host.close();
    viewerA.close();
    viewerB.close();
    viewerC.close();
  });
}

async function testServerAllowsAndroidChromeRelayWhenPayloadAndroidChromeIsFalse() {
  await withServer(async (port) => {
    const androidChromeCapabilities = {
      webViewer: true,
      mobile: true,
      platform: 'android',
      browserFamily: 'chromium',
      androidChrome: false,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-ua-android-chrome-relay', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-ua-android-chrome-relay-a',
      mediaCapabilities: androidChromeCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual(joinedA.mediaCapabilities.platform, 'android');
    assert.strictEqual(joinedA.mediaCapabilities.browserFamily, 'chromium');
    assert.strictEqual(joinedA.mediaCapabilities.androidChrome, true);
    assert.strictEqual(joinedA.mediaCapabilities.relayCapable, true);
    assert.strictEqual(joinedA.mediaCapabilities.relayEligibilityReason, 'relay-ready');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-ua-android-chrome-relay-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-ua-android-chrome-relay-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-ua-android-chrome-relay-a');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(viewerAMessages.some((message) => message.type === 'connect-to-next'));

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testHalfReadyViewerIsNotSelectedAsUpstream() {
  const instance = startServer({
    port: 0,
    publicDir: null,
    updatesDir: null,
    maxMessagesPerWindow: 20,
    disconnectGraceMs: 80
  });
  await new Promise((resolve) => instance.server.once('listening', resolve));
  const { port } = instance.server.address();
  try {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-half-ready', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port);
    viewerA.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-half-ready-a' }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-half-ready');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');

    const viewerRecord = instance.rooms.get(created.roomId).viewers[0];
    viewerRecord.mediaReady = true;
    viewerRecord.relayEstablished = false;

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-half-ready-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'host-half-ready');
    const hostMessages = await collectMessages(host, 120);
    assert.ok(hostMessages.some((message) => message.type === 'viewer-joined' && message.viewerId === 'viewer-half-ready-b'));

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next' && message.nextViewerId === 'viewer-half-ready-b'));

    host.close();
    viewerA.close();
    viewerB.close();
  } finally {
    for (const client of instance.wss.clients) {
      client.close();
    }
    await new Promise((resolve) => instance.server.close(resolve));
  }
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
      sessionToken: joinedFirst.sessionToken,
      chainPosition: 0
    }));

    const secondViewer = await openWs(port);
    secondViewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-reconnect-b' }));
    const joinedSecond = await onceMessage(secondViewer);
    assert.strictEqual(joinedSecond.type, 'room-joined');
    const connectNext = await onceMessage(firstViewer);
    assert.strictEqual(connectNext.type, 'connect-to-next');

    const hostMessagesAfterLeavePromise = collectMessages(host, 80);
    firstViewer.send(JSON.stringify({ type: 'leave-room', roomId: created.roomId, clientId: 'viewer-reconnect-a', sessionToken: joinedFirst.sessionToken }));
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
      sessionToken: joinedSecond.sessionToken,
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

async function testViewerReconnectReselectsUpstreamWithFanoutLimit() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-fanout', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port);
    viewerA.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-fanout-a' }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-fanout');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');
    viewerA.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-fanout-a', sessionToken: joinedA.sessionToken, chainPosition: 0 }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-fanout-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-fanout-a');
    const connectB = await onceMessage(viewerA);
    assert.strictEqual(connectB.type, 'connect-to-next');
    assert.strictEqual(connectB.nextViewerId, 'viewer-fanout-b');
    viewerB.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-fanout-b', sessionToken: joinedB.sessionToken, chainPosition: 1 }));

    const viewerC = await openWs(port);
    viewerC.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-fanout-c' }));
    const joinedC = await onceMessage(viewerC);
    assert.strictEqual(joinedC.upstreamPeerId, 'viewer-fanout-b');
    const connectC = await onceMessage(viewerB);
    assert.strictEqual(connectC.type, 'connect-to-next');
    assert.strictEqual(connectC.nextViewerId, 'viewer-fanout-c');

    viewerC.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-fanout-c',
      sessionToken: joinedC.sessionToken,
      chainPosition: 2,
      upstreamPeerId: 'viewer-fanout-b',
      failedUpstreamPeerId: 'viewer-fanout-b'
    }));
    const hostReconnect = await onceMessage(host);
    assert.strictEqual(hostReconnect.type, 'viewer-joined');
    assert.strictEqual(hostReconnect.viewerId, 'viewer-fanout-c');
    assert.strictEqual(hostReconnect.reconnect, true);

    const staleMessages = await collectMessages(viewerB, 80);
    assert.ok(!staleMessages.some((message) => message.type === 'connect-to-next' && message.nextViewerId === 'viewer-fanout-c'));

    host.close();
    viewerA.close();
    viewerB.close();
    viewerC.close();
  });
}

async function testStaleViewerReconnectReadyDoesNotReselectCurrentUpstream() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-stale-reconnect', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port);
    viewerA.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-stale-reconnect-a' }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-stale-reconnect');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');
    viewerA.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-stale-reconnect-a', sessionToken: joinedA.sessionToken, chainPosition: 0 }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-stale-reconnect-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-stale-reconnect-a');
    assert.strictEqual((await onceMessage(viewerA)).type, 'connect-to-next');
    viewerB.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-stale-reconnect-b', sessionToken: joinedB.sessionToken, chainPosition: 1 }));

    const viewerC = await openWs(port);
    viewerC.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-stale-reconnect-c' }));
    const joinedC = await onceMessage(viewerC);
    assert.strictEqual(joinedC.upstreamPeerId, 'viewer-stale-reconnect-b');
    assert.strictEqual((await onceMessage(viewerB)).type, 'connect-to-next');

    viewerC.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-stale-reconnect-c',
      sessionToken: joinedC.sessionToken,
      chainPosition: 2,
      upstreamPeerId: 'viewer-stale-reconnect-b',
      failedUpstreamPeerId: 'viewer-stale-reconnect-b'
    }));
    const firstReconnect = await onceMessage(host);
    assert.strictEqual(firstReconnect.type, 'viewer-joined');
    assert.strictEqual(firstReconnect.viewerId, 'viewer-stale-reconnect-c');
    assert.strictEqual(firstReconnect.reconnect, true);

    viewerC.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-stale-reconnect-c',
      sessionToken: joinedC.sessionToken,
      chainPosition: 2,
      upstreamPeerId: 'viewer-stale-reconnect-b',
      failedUpstreamPeerId: 'viewer-stale-reconnect-b'
    }));
    const staleMessages = await collectMessages(host, 80);
    assert.ok(!staleMessages.some((message) => message.type === 'viewer-joined' && message.viewerId === 'viewer-stale-reconnect-c'));

    host.close();
    viewerA.close();
    viewerB.close();
    viewerC.close();
  });
}

async function testViewerReconnectReportsUnavailableWhenFanoutIsFull() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-capacity', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port);
    viewerA.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-capacity-a' }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-capacity');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');
    viewerA.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-capacity-a', sessionToken: joinedA.sessionToken, chainPosition: 0 }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-capacity-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-capacity-a');
    assert.strictEqual((await onceMessage(viewerA)).type, 'connect-to-next');
    viewerB.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-capacity-b', sessionToken: joinedB.sessionToken, chainPosition: 1 }));

    const viewerC = await openWs(port);
    viewerC.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-capacity-c' }));
    const joinedC = await onceMessage(viewerC);
    assert.strictEqual(joinedC.upstreamPeerId, 'viewer-capacity-b');
    assert.strictEqual((await onceMessage(viewerB)).type, 'connect-to-next');

    viewerC.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-capacity-c',
      sessionToken: joinedC.sessionToken,
      chainPosition: 2,
      upstreamPeerId: 'viewer-capacity-b',
      failedUpstreamPeerId: 'viewer-capacity-b'
    }));
    const unavailable = await onceMessage(viewerC);
    assert.strictEqual(unavailable.type, 'error');
    assert.strictEqual(unavailable.code, 'upstream-capacity-unavailable');

    const hostMessages = await collectMessages(host, 80);
    const viewerBMessages = await collectMessages(viewerB, 80);
    assert.ok(!hostMessages.some((message) => message.type === 'viewer-joined' && message.viewerId === 'viewer-capacity-c'));
    assert.ok(!viewerBMessages.some((message) => message.type === 'connect-to-next' && message.nextViewerId === 'viewer-capacity-c'));

    host.close();
    viewerA.close();
    viewerB.close();
    viewerC.close();
  }, { maxDownstreamsPerUpstream: 1 });
}

async function testViewerCapabilityLimitsDirectDownstreams() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-capability', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port);
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-capability-a',
      mediaCapabilities: {
        webViewer: true,
        maxDirectDownstreams: 1,
        platform: 'desktop',
        browserFamily: 'chromium',
        audioOutput: true,
        relayCapable: true,
        encodedMediaDataChannel: {
          protocol: 'vds-media-encoded-v1',
          protocolVersion: 1,
          supportedVideoCodecs: ['h264'],
          supportedAudioCodecs: ['opus'],
          supportedVideoPayloadFormats: ['annexb', 'avcc'],
          supportedAudioPayloadFormats: ['opus-raw', 'raw'],
          maxFrameBytes: 2097152,
          bootstrapRequired: true
        }
      }
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.upstreamPeerId, 'host-capability');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');
    viewerA.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-capability-a', sessionToken: joinedA.sessionToken, chainPosition: 0 }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-capability-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-capability-a');
    assert.strictEqual((await onceMessage(viewerA)).type, 'connect-to-next');
    viewerB.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-capability-b', sessionToken: joinedB.sessionToken, chainPosition: 1 }));

    const viewerC = await openWs(port);
    viewerC.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-capability-c' }));
    const joinedC = await onceMessage(viewerC);
    assert.strictEqual(joinedC.upstreamPeerId, 'viewer-capability-b');
    assert.strictEqual((await onceMessage(viewerB)).type, 'connect-to-next');
    viewerC.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-capability-c',
      sessionToken: joinedC.sessionToken,
      chainPosition: 2,
      upstreamPeerId: 'viewer-capability-b',
      failedUpstreamPeerId: 'viewer-capability-b'
    }));
    const hostReconnect = await onceMessage(host);
    assert.strictEqual(hostReconnect.type, 'viewer-joined');
    assert.strictEqual(hostReconnect.viewerId, 'viewer-capability-c');
    viewerC.send(JSON.stringify({ type: 'viewer-ready', roomId: created.roomId, clientId: 'viewer-capability-c', sessionToken: joinedC.sessionToken, chainPosition: 2 }));

    const viewerD = await openWs(port);
    viewerD.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-capability-d' }));
    const joinedD = await onceMessage(viewerD);
    assert.strictEqual(joinedD.upstreamPeerId, 'viewer-capability-c');
    assert.strictEqual((await onceMessage(viewerC)).type, 'connect-to-next');
    viewerD.send(JSON.stringify({
      type: 'viewer-reconnect-ready',
      roomId: created.roomId,
      clientId: 'viewer-capability-d',
      sessionToken: joinedD.sessionToken,
      chainPosition: 3,
      upstreamPeerId: 'viewer-capability-c',
      failedUpstreamPeerId: 'viewer-capability-c'
    }));
    const fallbackToB = await onceMessage(viewerB);
    assert.strictEqual(fallbackToB.type, 'connect-to-next');
    assert.strictEqual(fallbackToB.nextViewerId, 'viewer-capability-d');

    const viewerAMessages = await collectMessages(viewerA, 80);
    assert.ok(!viewerAMessages.some((message) => message.type === 'connect-to-next' && message.nextViewerId === 'viewer-capability-d'));

    host.close();
    viewerA.close();
    viewerB.close();
    viewerC.close();
    viewerD.close();
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

async function testHostMediaManifestUpdateReselectsIncompatibleWebRelay() {
  await withServer(async (port) => {
    const h264OnlyRelayCapabilities = {
      webViewer: true,
      mobile: false,
      platform: 'desktop',
      browserFamily: 'chromium',
      androidChrome: false,
      audioOutput: true,
      relayCapable: true,
      maxDirectDownstreams: 1,
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw'],
        maxFrameBytes: 2097152,
        bootstrapRequired: true
      }
    };

    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-manifest-reselect', mediaManifest: testMediaManifest({ videoCodec: 'h264' }) }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewerA = await openWs(port, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    viewerA.send(JSON.stringify({
      type: 'join-room',
      roomId: created.roomId,
      clientId: 'viewer-manifest-reselect-a',
      mediaCapabilities: h264OnlyRelayCapabilities
    }));
    const joinedA = await onceMessage(viewerA);
    assert.strictEqual(joinedA.type, 'room-joined');
    assert.strictEqual((await onceMessage(host)).type, 'viewer-joined');
    viewerA.send(JSON.stringify({
      type: 'viewer-ready',
      roomId: created.roomId,
      clientId: 'viewer-manifest-reselect-a',
      sessionToken: joinedA.sessionToken,
      chainPosition: 0
    }));

    const viewerB = await openWs(port);
    viewerB.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-manifest-reselect-b' }));
    const joinedB = await onceMessage(viewerB);
    assert.strictEqual(joinedB.type, 'room-joined');
    assert.strictEqual(joinedB.upstreamPeerId, 'viewer-manifest-reselect-a');
    assert.strictEqual((await onceMessage(viewerA)).type, 'connect-to-next');

    host.send(JSON.stringify({
      type: 'host-media-manifest',
      roomId: created.roomId,
      clientId: 'host-manifest-reselect',
      sessionToken: created.sessionToken,
      mediaManifest: testMediaManifest({ videoCodec: 'h265', mediaSessionId: 'media-h265-reselect' })
    }));
    const ack = await onceMessage(host);
    assert.strictEqual(ack.type, 'host-media-manifest-ack');
    assert.strictEqual(ack.mediaSessionId, 'media-h265-reselect');
    const reconnect = await onceMessage(viewerB);
    assert.strictEqual(reconnect.type, 'chain-reconnect');
    assert.strictEqual(reconnect.upstreamPeerId, 'host-manifest-reselect');
    assert.strictEqual(reconnect.mediaManifest.video.codec, 'h265');

    host.close();
    viewerA.close();
    viewerB.close();
  });
}

async function testOldHostSocketCannotForwardAfterResume() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-rebind', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');

    const viewer = await openWs(port);
    viewer.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, clientId: 'viewer-rebind' }));
    const joined = await onceMessage(viewer);
    assert.strictEqual(joined.type, 'room-joined');
    await onceMessage(host);

    const resumedHost = await openWs(port);
    resumedHost.send(JSON.stringify({
      type: 'resume-session',
      roomId: created.roomId,
      clientId: 'host-rebind',
      role: 'host',
      sessionToken: created.sessionToken
    }));
    const resumed = await onceMessage(resumedHost);
    assert.strictEqual(resumed.type, 'session-resumed');

    const viewerMessagesPromise = collectMessages(viewer, 120);
    host.send(JSON.stringify({ type: 'offer', targetId: 'viewer-rebind', sdp: 'stale-offer' }));
    resumedHost.send(JSON.stringify({ type: 'offer', targetId: 'viewer-rebind', sdp: 'fresh-offer' }));
    const viewerMessages = await viewerMessagesPromise;
    assert.ok(!viewerMessages.some((message) => message.sdp === 'stale-offer'));
    assert.ok(viewerMessages.some((message) => message.sdp === 'fresh-offer'));

    host.close();
    viewer.close();
    resumedHost.close();
  });
}

async function testDuplicateCreateRoomOnSameSocketIsRejected() {
  const instance = startServer({
    port: 0,
    publicDir: null,
    updatesDir: null,
    maxRooms: 2,
    maxMessagesPerWindow: 20,
    disconnectGraceMs: 80
  });
  await new Promise((resolve) => instance.server.once('listening', resolve));
  const { port } = instance.server.address();
  try {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-duplicate-a', mediaManifest: testMediaManifest() }));
    const created = await onceMessage(host);
    assert.strictEqual(created.type, 'room-created');
    assert.strictEqual(instance.rooms.size, 1);

    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-duplicate-b', mediaManifest: testMediaManifest() }));
    const rejected = await onceMessage(host);
    assert.strictEqual(rejected.code, 'socket-already-bound');
    assert.strictEqual(instance.rooms.size, 1);

    host.close();
  } finally {
    for (const client of instance.wss.clients) {
      client.close();
    }
    await new Promise((resolve) => instance.server.close(resolve));
  }
}

async function testBoundViewerSocketCannotJoinAnotherRoom() {
  const instance = startServer({
    port: 0,
    publicDir: null,
    updatesDir: null,
    maxRooms: 4,
    maxMessagesPerWindow: 20,
    disconnectGraceMs: 80
  });
  await new Promise((resolve) => instance.server.once('listening', resolve));
  const { port } = instance.server.address();
  try {
    const hostA = await openWs(port);
    hostA.send(JSON.stringify({ type: 'create-room', clientId: 'host-bound-a', mediaManifest: testMediaManifest({ mediaSessionId: 'media-bound-a' }) }));
    const roomA = await onceMessage(hostA);
    assert.strictEqual(roomA.type, 'room-created');

    const hostB = await openWs(port);
    hostB.send(JSON.stringify({ type: 'create-room', clientId: 'host-bound-b', mediaManifest: testMediaManifest({ mediaSessionId: 'media-bound-b' }) }));
    const roomB = await onceMessage(hostB);
    assert.strictEqual(roomB.type, 'room-created');

    const viewer = await openWs(port);
    viewer.send(JSON.stringify({ type: 'join-room', roomId: roomA.roomId, clientId: 'viewer-bound' }));
    const joined = await onceMessage(viewer);
    assert.strictEqual(joined.type, 'room-joined');

    viewer.send(JSON.stringify({ type: 'join-room', roomId: roomB.roomId, clientId: 'viewer-bound-other' }));
    const rejected = await onceMessage(viewer);
    assert.strictEqual(rejected.code, 'socket-already-bound');
    assert.strictEqual(instance.rooms.get(roomA.roomId).viewers.length, 1);
    assert.strictEqual(instance.rooms.get(roomB.roomId).viewers.length, 0);

    hostA.close();
    hostB.close();
    viewer.close();
  } finally {
    for (const client of instance.wss.clients) {
      client.close();
    }
    await new Promise((resolve) => instance.server.close(resolve));
  }
}

async function testHostCanCreateNewRoomAfterLeavingPreviousRoom() {
  await withServer(async (port) => {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-recreate', mediaManifest: testMediaManifest({ mediaSessionId: 'media-first' }) }));
    const firstCreated = await onceMessage(host);
    assert.strictEqual(firstCreated.type, 'room-created');

    host.send(JSON.stringify({ type: 'leave-room', roomId: firstCreated.roomId, clientId: 'host-recreate', sessionToken: firstCreated.sessionToken }));
    await wait(20);

    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-recreate', mediaManifest: testMediaManifest({ mediaSessionId: 'media-second' }) }));
    const secondCreated = await onceMessage(host);
    assert.strictEqual(secondCreated.type, 'room-created');
    assert.notStrictEqual(secondCreated.roomId, firstCreated.roomId);
    assert.strictEqual(secondCreated.mediaManifest.mediaSessionId, 'media-second');

    host.close();
  });
}

async function testStaleLeaveRoomCannotRemoveCurrentRoom() {
  const instance = startServer({
    port: 0,
    publicDir: null,
    updatesDir: null,
    maxMessagesPerWindow: 20,
    disconnectGraceMs: 80
  });
  await new Promise((resolve) => instance.server.once('listening', resolve));
  const { port } = instance.server.address();
  try {
    const host = await openWs(port);
    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-stale-leave', mediaManifest: testMediaManifest({ mediaSessionId: 'media-old-leave' }) }));
    const oldRoom = await onceMessage(host);
    assert.strictEqual(oldRoom.type, 'room-created');

    host.send(JSON.stringify({ type: 'leave-room', roomId: oldRoom.roomId, clientId: 'host-stale-leave', sessionToken: oldRoom.sessionToken }));
    await wait(20);

    host.send(JSON.stringify({ type: 'create-room', clientId: 'host-stale-leave', mediaManifest: testMediaManifest({ mediaSessionId: 'media-current-leave' }) }));
    const currentRoom = await onceMessage(host);
    assert.strictEqual(currentRoom.type, 'room-created');

    host.send(JSON.stringify({ type: 'leave-room', roomId: oldRoom.roomId, clientId: 'host-stale-leave', sessionToken: oldRoom.sessionToken }));
    await wait(20);

    assert.strictEqual(instance.rooms.has(currentRoom.roomId), true);
    const currentHostSocket = instance.rooms.get(currentRoom.roomId).host.ws;
    assert.strictEqual(currentHostSocket.roomId, currentRoom.roomId);
    assert.strictEqual(currentHostSocket.clientId, 'host-stale-leave');
    assert.strictEqual(currentHostSocket.role, 'host');

    host.close();
  } finally {
    for (const client of instance.wss.clients) {
      client.close();
    }
    await new Promise((resolve) => instance.server.close(resolve));
  }
}

async function testStartServerSupportsRandomPort() {
  const instance = startServer({
    port: 0,
    publicDir: null,
    updatesDir: null
  });
  try {
    await new Promise((resolve) => instance.server.once('listening', resolve));
    const address = instance.server.address();
    assert.ok(address && typeof address === 'object');
    assert.ok(address.port > 0);
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
  }
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

function testServerSupportsOptionalHttpsForLanMobileWeb() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/server-core.js'), 'utf8');
  const entry = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');
  assert.match(source, /const https = require\('https'\)/);
  assert.match(source, /resolveHttpsOptions\(options\)/);
  assert.match(source, /process\.env\.VDS_HTTPS_KEY_PATH/);
  assert.match(source, /process\.env\.VDS_HTTPS_CERT_PATH/);
  assert.match(source, /https\.createServer\(httpsOptions, app\)/);
  assert.match(source, /logServerInfo\(`Server running on \$\{serverProtocol\}:\/\/localhost:\$\{actualPort\}`\)/);
  assert.match(entry, /catch \(error\) \{/);
}

function testAdminDashboardShowsMobileWebCapabilities() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/public/admin.html'), 'utf8');
  assert.match(source, /function viewerCapabilitySummary\(mediaCapabilities\)/);
  assert.match(source, /function viewerCapabilityPills\(mediaCapabilities\)/);
  assert.match(source, /mediaCapabilities\.browser \|\| mediaCapabilities\.browserFamily/);
  assert.match(source, /mediaCapabilities\.relayCapable === true \? 'web relay' : 'web leaf'/);
  assert.match(source, /mediaCapabilities\.relayEligibilityReason/);
  assert.match(source, /mediaCapabilities\.localRelayEligibilityReason/);
  assert.match(source, /mediaCapabilities\.androidChrome === true/);
  assert.match(source, /mediaCapabilities\.audioOutput === true \? 'audio out' : 'no audio out'/);
  assert.match(source, /encoded\.supportedVideoCodecs/);
  assert.match(source, /encoded\.supportedAudioCodecs/);
  assert.match(source, /encoded\.supportedVideoPayloadFormats/);
  assert.match(source, /encoded\.supportedAudioPayloadFormats/);
  assert.match(source, /vf \$\{videoFormats\}/);
  assert.match(source, /af \$\{audioFormats\}/);
  assert.match(source, /node-row-capability/);
}

async function testBrowserRootUsesVdsWebWhenBuilt() {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-static-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), 'electron-entry');
  fs.mkdirSync(path.join(publicDir, 'vds_web'));
  fs.writeFileSync(path.join(publicDir, 'vds_web', 'index.html'), 'web-entry');

  try {
    await withStaticServer(publicDir, async (port) => {
      const browserUserAgents = [
        'Mozilla/5.0 Chrome/120.0.0.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/126.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (Android 15; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0'
      ];
      for (const userAgent of browserUserAgents) {
        const browser = await getHttp(port, '/', { 'User-Agent': userAgent });
        assert.strictEqual(browser.statusCode, 200);
        assert.strictEqual(browser.body, 'web-entry');
      }

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
  testServerSupportsOptionalHttpsForLanMobileWeb();
  testAdminDashboardShowsMobileWebCapabilities();
  await testBrowserRootUsesVdsWebWhenBuilt();
  await testResumeTokenProtection();
  await testJoinRequiresHostMediaManifest();
  await testHostMediaManifestUpdateReselectsIncompatibleWebRelay();
  await testOldHostSocketCannotForwardAfterResume();
  await testDuplicateCreateRoomOnSameSocketIsRejected();
  await testBoundViewerSocketCannotJoinAnotherRoom();
  await testHostCanCreateNewRoomAfterLeavingPreviousRoom();
  await testStaleLeaveRoomCannotRemoveCurrentRoom();
  await testStartServerSupportsRandomPort();
  await testViewerMediaCapabilitiesAreForwarded();
  await testZeroRelayCapacityViewerIsNotSelectedAsUpstream();
  await testNonRelayCapableWebViewerIsNotSelectedEvenWithPositiveLimit();
  await testServerRejectsInvalidMobileRelayClaims();
  await testWebViewerWithoutRelayCapabilityIsNotSelectedAsUpstream();
  await testServerSkipsWebRelayCandidateWithoutCodecCapability();
  await testServerSkipsWebRelayCandidateWithoutPayloadFormatCapability();
  await testServerSkipsWebRelayCandidateWithInvalidEncodedProtocol();
  await testServerSkipsWebRelayCandidateWithoutAudioOutput();
  await testServerUsesWebSocketUserAgentForAndroidChromeRelayClaims();
  await testServerRejectsDesktopNonChromeRelayClaims();
  await testServerRejectsAndroidChromeRelayWithoutPayloadMatrix();
  await testServerSkipsWebRelayCandidateWhenManifestUnsupported();
  await testServerAllowsWebRelayCandidateWithCodecAliases();
  await testAndroidChromeRelayCapacityIsCappedToOneDownstream();
  await testServerAllowsAndroidChromeRelayWhenPayloadAndroidChromeIsFalse();
  await testHalfReadyViewerIsNotSelectedAsUpstream();
  await testViewerReconnectReadyRenotifiesHost();
  await testViewerReconnectReselectsUpstreamWithFanoutLimit();
  await testStaleViewerReconnectReadyDoesNotReselectCurrentUpstream();
  await testViewerReconnectReportsUnavailableWhenFanoutIsFull();
  await testViewerCapabilityLimitsDirectDownstreams();
  await testHostGraceResumeKeepsRoom();
  await testHostGraceExpiryDestroysRoomAndToken();
  console.log('server-core tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
