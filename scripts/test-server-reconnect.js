const assert = require('assert');
const { once } = require('events');
const WebSocket = require('ws');
const { startServer } = require('../server/server-core');

const manifest = {
  protocol: 'vds-media-encoded-v1', protocolVersion: 1,
  mediaSessionId: 'reconnect-test', manifestVersion: 1,
  video: { codec: 'h264', payloadFormat: 'annexb', width: 1280, height: 720, fps: 30 },
  audio: { codec: 'opus', payloadFormat: 'opus-raw', sampleRate: 48000, channels: 2 }
};
const leaf = { webViewer: true, platform: 'ios', browserFamily: 'safari', relayCapable: false, maxDirectDownstreams: 0 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, description) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(5);
  }
}

async function connect(port, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const readers = [];
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const index = readers.findIndex((reader) => reader.matches(message));
    if (index < 0) messages.push(message);
    else readers.splice(index, 1)[0].resolve(message);
  });
  await once(ws, 'open');
  return {
    id, ws, messages,
    send(data) { ws.send(JSON.stringify(data)); },
    take(matches, timeoutMs = 1000) {
      const index = messages.findIndex(matches);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const reader = { matches, resolve: (message) => { clearTimeout(timer); resolve(message); } };
        const timer = setTimeout(() => {
          readers.splice(readers.indexOf(reader), 1);
          reject(new Error(`Message timeout for ${id}`));
        }, timeoutMs);
        readers.push(reader);
      });
    }
  };
}

async function withServer(test, options = {}) {
  const instance = startServer({ port: 0, disconnectGraceMs: 2000, ...options });
  await once(instance.server, 'listening');
  try { await test(instance, instance.server.address().port); }
  finally {
    for (const ws of instance.wss.clients) ws.terminate();
    await new Promise((resolve) => instance.wss.close(resolve));
    await new Promise((resolve) => instance.server.close(resolve));
    for (const room of instance.rooms.values()) {
      for (const participant of [room.host, ...room.viewers]) clearTimeout(participant.disconnectTimer);
    }
  }
}

async function createHost(port) {
  const host = await connect(port, 'host');
  host.send({ type: 'create-room', clientId: host.id, mediaManifest: manifest });
  host.session = await host.take((message) => message.type === 'room-created');
  return host;
}

async function join(port, host, id, mediaCapabilities) {
  const peer = await connect(port, id);
  peer.send({ type: 'join-room', roomId: host.session.roomId, clientId: id, mediaCapabilities });
  peer.session = await peer.take((message) => message.type === 'room-joined');
  return peer;
}

function viewer(instance, peer) {
  return instance.rooms.get(peer.session.roomId).viewers.find((entry) => entry.clientId === peer.id);
}

async function ready(instance, peer) {
  peer.send({ type: 'viewer-ready', roomId: peer.session.roomId, clientId: peer.id,
    sessionToken: peer.session.sessionToken, chainPosition: viewer(instance, peer).chainPosition });
  await until(() => viewer(instance, peer).mediaReady, `${peer.id} ready`);
}

async function rebind(port, peer, mode, needsMediaReconnect) {
  const replacement = await connect(port, peer.id);
  replacement.send({ type: mode === 'join' ? 'join-room' : 'resume-session',
    roomId: peer.session.roomId, clientId: peer.id, role: 'viewer',
    sessionToken: peer.session.sessionToken, needsMediaReconnect });
  replacement.session = await replacement.take((message) => message.type === (mode === 'join' ? 'room-joined' : 'session-resumed'));
  return replacement;
}

async function testConfiguredLimit(limit, mode) {
  await withServer(async (instance, port) => {
    const host = await createHost(port);
    let target;
    if (limit === 1) {
      const relay = await join(port, host, 'relay');
      await ready(instance, relay);
      target = await join(port, host, 'target');
      assert.strictEqual(target.session.upstreamPeerId, relay.id);
      relay.ws.close();
      await until(() => !viewer(instance, relay).ws, 'relay signaling disconnected');
    } else {
      await join(port, host, 'leaf-a', leaf);
      await join(port, host, 'leaf-b', leaf);
      target = await join(port, host, 'target');
      assert.strictEqual(target.session.upstreamPeerId, host.id);
    }
    const replacement = await rebind(port, target, mode, true);
    const room = instance.rooms.get(host.session.roomId);
    const direct = room.viewers.filter((entry) => entry.upstreamPeerId === host.id).length;
    assert.ok(direct <= limit, `configured fanout ${limit} exceeded: ${direct}`);
    if (limit === 1) assert.strictEqual(viewer(instance, replacement).upstreamPeerId, 'relay');
    else {
      assert.strictEqual(viewer(instance, replacement).upstreamPeerId, host.id, 'configured third host slot was lost during rebind');
      await host.take((message) => message.type === 'viewer-joined' && message.viewerId === target.id && message.reconnect);
    }
  }, { maxDownstreamsPerUpstream: limit });
}

async function testRelayResumeWakesPending(mode) {
  await withServer(async (instance, port) => {
    const host = await createHost(port);
    const relay = await join(port, host, 'relay');
    await ready(instance, relay);
    const target = await join(port, host, 'target');
    assert.strictEqual(target.session.upstreamPeerId, relay.id);
    await ready(instance, target);
    await relay.take((message) => message.type === 'connect-to-next' && message.nextViewerId === target.id);
    relay.ws.close();
    await until(() => !viewer(instance, relay).ws, 'relay signaling disconnected');
    target.send({ type: 'viewer-reconnect-ready', roomId: host.session.roomId, clientId: target.id,
      sessionToken: target.session.sessionToken, chainPosition: target.session.chainPosition });
    await until(() => !viewer(instance, target).mediaReady, 'downstream waiting for relay');
    assert.strictEqual(viewer(instance, target).upstreamPeerId, relay.id);
    assert.strictEqual(viewer(instance, target).connectRequestPending, false);
    const replacement = await rebind(port, relay, mode, false);
    assert.strictEqual(viewer(instance, replacement).mediaReady, true);
    await replacement.take((message) => message.type === 'connect-to-next' && message.nextViewerId === target.id);
    assert.strictEqual(viewer(instance, target).connectRequestPending, true);
    await exchange(replacement, target, `resumed-relay-${mode}`);
    await ready(instance, target);
    assert.strictEqual(viewer(instance, target).relayEstablished, true);
  }, { maxDownstreamsPerUpstream: 1 });
}

async function exchange(upstream, downstream, prefix) {
  upstream.send({ type: 'offer', targetId: downstream.id, sdp: `${prefix}-offer` });
  const offer = await downstream.take((message) => message.type === 'offer' && message.sdp === `${prefix}-offer`);
  assert.strictEqual(offer.fromClientId, upstream.id);
  downstream.send({ type: 'answer', targetId: upstream.id, sdp: `${prefix}-answer` });
  const answer = await upstream.take((message) => message.type === 'answer' && message.sdp === `${prefix}-answer`);
  assert.strictEqual(answer.fromClientId, downstream.id);
  downstream.send({ type: 'ice-candidate', targetId: upstream.id, candidate: `${prefix}-ice` });
  const ice = await upstream.take((message) => message.type === 'ice-candidate' && message.candidate === `${prefix}-ice`);
  assert.strictEqual(ice.fromClientId, downstream.id);
}

async function testRelayTimeoutRecovery() {
  await withServer(async (instance, port) => {
    const host = await createHost(port);
    const relay = await join(port, host, 'relay');
    await host.take((message) => message.type === 'viewer-joined' && message.viewerId === relay.id);
    await exchange(host, relay, 'initial-host-relay');
    await ready(instance, relay);
    const target = await join(port, host, 'target');
    assert.strictEqual(target.session.upstreamPeerId, relay.id);
    await relay.take((message) => message.type === 'connect-to-next' && message.nextViewerId === target.id);
    await exchange(relay, target, 'initial-relay-target');
    await ready(instance, target);
    relay.ws.close();
    const reconnect = await target.take((message) => message.type === 'chain-reconnect');
    assert.strictEqual(reconnect.upstreamPeerId, host.id);
    assert.strictEqual(reconnect.newChainPosition, 0);
    target.send({ type: 'viewer-reconnect-ready', roomId: host.session.roomId, clientId: target.id,
      sessionToken: target.session.sessionToken, chainPosition: reconnect.newChainPosition });
    await host.take((message) => message.type === 'viewer-joined' && message.viewerId === target.id && message.reconnect);
    await exchange(host, target, 'recovered-host-target');
    await ready(instance, target);
    assert.strictEqual(instance.rooms.get(host.session.roomId).viewers.length, 1);
    assert.strictEqual(viewer(instance, target).upstreamPeerId, host.id);
    assert.strictEqual(viewer(instance, target).mediaReady, true);
  }, { disconnectGraceMs: 40, maxDownstreamsPerUpstream: 1 });
}

async function testMalformedMessagesAreLimited() {
  await withServer(async (instance, port) => {
    const peer = await connect(port, 'invalid-client');
    const closed = once(peer.ws, 'close');
    peer.ws.send('{');
    peer.ws.send('null');
    peer.ws.send('{}');
    peer.send({ type: 'create-room', clientId: peer.id, mediaManifest: manifest });
    await peer.take((message) => message.code === 'message-rate-limit');
    const [code] = await closed;
    assert.strictEqual(code, 1008);
    assert.strictEqual(instance.rooms.size, 0, 'invalid messages must consume the same allowance as valid ones');
  }, { maxMessagesPerWindow: 3 });
}

async function testFreshPageJoinRebuildsMedia() {
  await withServer(async (instance, port) => {
    const host = await createHost(port);
    const target = await join(port, host, 'target');
    await host.take((message) => message.type === 'viewer-joined' && message.viewerId === target.id);
    await ready(instance, target);
    const replacement = await rebind(port, target, 'join', true);
    assert.strictEqual(viewer(instance, replacement).mediaReady, false, 'fresh page must not inherit closed page media readiness');
    await host.take((message) => message.type === 'viewer-joined' && message.viewerId === target.id && message.reconnect);
    await exchange(host, replacement, 'fresh-page');
    await ready(instance, replacement);
  });
}

async function testChangedUpstreamWaitsForAcknowledgement(occupyHost = false) {
  await withServer(async (instance, port) => {
    const host = await createHost(port);
    const relayA = await join(port, host, 'relay-a');
    await ready(instance, relayA);
    const relayB = await join(port, host, 'relay-b');
    await ready(instance, relayB);
    const target = await join(port, host, 'target');
    assert.strictEqual(target.session.upstreamPeerId, relayB.id);
    await relayB.take((message) => message.type === 'connect-to-next' && message.nextViewerId === target.id);
    if (occupyHost) await join(port, host, 'host-leaf', leaf);
    const nextUpstream = occupyHost ? relayA : host;
    const isConnectionRequest = (message) => occupyHost
      ? message.type === 'connect-to-next' && message.nextViewerId === target.id
      : message.type === 'viewer-joined' && message.viewerId === target.id;
    target.send({ type: 'viewer-reconnect-ready', roomId: host.session.roomId, clientId: target.id,
      sessionToken: target.session.sessionToken, chainPosition: target.session.chainPosition, failedUpstreamPeerId: relayB.id });
    const changed = await target.take((message) => message.type === 'chain-reconnect');
    assert.strictEqual(changed.upstreamPeerId, nextUpstream.id);
    assert.strictEqual(viewer(instance, target).upstreamPeerId, nextUpstream.id);
    assert.strictEqual(nextUpstream.messages.filter(isConnectionRequest).length, 0,
      'new upstream must wait until the viewer updates its session');
    target.send({ type: 'viewer-reconnect-ready', roomId: host.session.roomId, clientId: target.id,
      sessionToken: target.session.sessionToken, chainPosition: changed.newChainPosition, upstreamPeerId: changed.upstreamPeerId });
    await nextUpstream.take(isConnectionRequest);
    await exchange(nextUpstream, target, 'changed-upstream');
    await ready(instance, target);
    assert.strictEqual(viewer(instance, target).upstreamPeerId, nextUpstream.id, 'acknowledgement must retain the selected replacement');
    assert.strictEqual(target.messages.filter((message) => message.type === 'chain-reconnect').length, 0);
    assert.strictEqual(nextUpstream.messages.filter(isConnectionRequest).length, 0);
  });
}

async function testSameUpstreamStartsOneReconnect() {
  await withServer(async (instance, port) => {
    const host = await createHost(port);
    const target = await join(port, host, 'target');
    await host.take((message) => message.type === 'viewer-joined' && message.viewerId === target.id);
    await ready(instance, target);
    target.send({ type: 'viewer-reconnect-ready', roomId: host.session.roomId, clientId: target.id,
      sessionToken: target.session.sessionToken, chainPosition: target.session.chainPosition });
    await host.take((message) => message.type === 'viewer-joined' && message.viewerId === target.id && message.reconnect);
    await exchange(host, target, 'same-upstream');
    await ready(instance, target);
    assert.strictEqual(target.messages.filter((message) => message.type === 'chain-reconnect').length, 0);
    assert.strictEqual(host.messages.filter((message) => message.type === 'viewer-joined' && message.viewerId === target.id).length, 0);
  });
}

const tests = {
  'limit1-resume': () => testConfiguredLimit(1, 'resume'),
  'limit1-join': () => testConfiguredLimit(1, 'join'),
  'limit3-resume': () => testConfiguredLimit(3, 'resume'),
  'limit3-join': () => testConfiguredLimit(3, 'join'),
  'relay-resume': () => testRelayResumeWakesPending('resume'),
  'relay-join': () => testRelayResumeWakesPending('join'),
  'relay-timeout': testRelayTimeoutRecovery,
  'malformed-rate': testMalformedMessagesAreLimited,
  'fresh-page': testFreshPageJoinRebuildsMedia,
  'changed-upstream': () => testChangedUpstreamWaitsForAcknowledgement(),
  'changed-to-relay': () => testChangedUpstreamWaitsForAcknowledgement(true),
  'same-upstream': testSameUpstreamStartsOneReconnect
};

async function main() {
  const selection = process.argv[2];
  if (selection && !tests[selection]) throw new Error(`Unknown test: ${selection}`);
  for (const [name, test] of Object.entries(tests)) {
    if (selection && selection !== name) continue;
    await test();
    console.log(`${name} passed`);
  }
  console.log('server reconnect tests passed (local signaling only)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
