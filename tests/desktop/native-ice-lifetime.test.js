const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.VDS_ICE_CONTROLLER_TEST_SOURCE ||
  path.resolve(__dirname, '../../server/public/native/native-peer-controller.js'), 'utf8');
const host = (ip = '192.0.2.10') => ({ candidate: `candidate:h 1 udp 2122260223 ${ip} 45000 typ host`, sdpMid: 'data' });
function harness(openMapping = async () => ({ ok: false, candidates: [], reason: 'unsupported' })) {
  let now = 0, nextId = 0;
  const timers = new Map(), metadata = new Map(), mapped = [], sent = [], closed = [], states = [];
  const setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  const controller = context.window.VDS.nativePeer.createController({
    isHost: () => false,
    getPeerMeta: (id) => metadata.get(id), setPeerMeta: (id, meta) => metadata.set(id, meta),
    deletePeerMeta: (id) => metadata.delete(id),
    closePeerConnection: async (id) => { closed.push(id); },
    setP2pStateForPeer: (_id, state) => states.push(state),
    roomClient: { sendSignal: (message) => sent.push(message) },
    mediaEngine: {
      createPeer: async () => ({ transportGeneration: 'native-generation' }),
      closePeer: async () => {},
      openNatMapping: async (options) => { mapped.push({ at: now, options }); return openMapping(options); }
    }
  });
  const flush = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
  async function tick(ms) {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = target; await flush();
  }
  async function create() {
    const handle = controller.createPeerConnection('peer', true);
    await controller.ensurePeerReady('peer', handle);
    controller.handlePeerStateEvent({ peerId: 'peer', state: 'connecting' });
    return handle;
  }
  return { controller, metadata, timers, mapped, sent, closed, states, tick, flush, create };
}

test('renderer does not close a live native ICE attempt at 15 seconds or after a failed mapping', async () => {
  const h = harness(); await h.create();
  h.controller.rememberLocalIceCandidate('peer', host());
  await h.tick(25000);
  assert.equal(h.closed.length, 0, 'native ICE still checking: renderer must not preempt it');
  assert.equal(h.mapped.length, 1);
  h.controller.handlePeerStateEvent({ peerId: 'peer', state: 'connected' });
  assert.equal(h.metadata.get('peer').hasConnected, true);
  assert.equal(h.timers.size, 0);
});

test('mapping races ICE before failure and cannot install a seven-second cutoff', async () => {
  const h = harness(async () => ({ ok: true, candidates: [{ candidate: 'candidate:m 1 udp 100 198.51.100.4 45000 typ srflx', sdpMid: 'data' }] }));
  await h.create(); h.controller.rememberLocalIceCandidate('peer', host());
  await h.tick(2000);
  assert.equal(h.mapped.length, 1, 'mapping starts while the native attempt is live');
  assert.equal(h.sent.length, 1);
  await h.tick(23000);
  assert.equal(h.closed.length, 0);
  assert.equal(h.mapped.length, 1, 'one mapping attempt per native generation');
});

test('fast direct connection cancels pending mapping without touching the router', async () => {
  const h = harness(); await h.create();
  h.controller.rememberLocalIceCandidate('peer', host());
  h.controller.handlePeerStateEvent({ peerId: 'peer', state: 'connected' });
  await h.tick(25000);
  assert.equal(h.mapped.length, 0);
  assert.equal(h.timers.size, 0);
});

test('mapping completed after direct connection cannot publish stale candidates or reset state', async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  await h.create(); h.controller.rememberLocalIceCandidate('peer', host());
  await h.tick(2000);
  assert.equal(h.mapped.length, 1);
  h.controller.handlePeerStateEvent({ peerId: 'peer', state: 'connected' });
  resolve({ ok: true, candidates: [host('198.51.100.4')] }); await h.flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.metadata.get('peer').natMappingInProgress, false);
  assert.equal(h.timers.size, 0);
});

test('terminal native failure closes immediately instead of mapping a dead ICE transport', async () => {
  const h = harness(); await h.create();
  h.controller.rememberLocalIceCandidate('peer', host());
  h.controller.handlePeerStateEvent({ peerId: 'peer', state: 'failed' }); await h.flush();
  assert.deepEqual(h.closed, ['peer']);
  assert.equal(h.mapped.length, 0);
  await h.tick(25000);
  assert.equal(h.mapped.length, 0);
});

test('close cancels generation-owned timers before metadata deletion', async () => {
  const h = harness(); await h.create();
  h.controller.rememberLocalIceCandidate('peer', host());
  await h.controller.closePeerConnection('peer');
  assert.equal(h.timers.size, 0);
  await h.create(); await h.tick(2000);
  assert.equal(h.mapped.length, 0, 'old generation cannot start mapping on its replacement');
});

test('IPv6 host candidates do not consume the IPv4 mapping attempt or candidate slots', async () => {
  const h = harness(); await h.create();
  for (let i = 0; i < 5; ++i) h.controller.rememberLocalIceCandidate('peer', host(`2001:db8::${i + 1}`));
  await h.tick(2000); assert.equal(h.mapped.length, 0);
  h.controller.rememberLocalIceCandidate('peer', host());
  await h.tick(2000); assert.equal(h.mapped.length, 1);
  assert.equal(h.mapped[0].options.candidates.length, 1);
  assert.match(h.mapped[0].options.candidates[0].candidate, /192\.0\.2\.10/);
});

test('router RPC timeout and a late success cannot terminate the live ICE attempt', async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  await h.create(); h.controller.rememberLocalIceCandidate('peer', host());
  await h.tick(25000);
  assert.equal(h.closed.length, 0);
  assert.equal(h.metadata.get('peer').natMappingInProgress, false);
  resolve({ ok: true, candidates: [host('198.51.100.4')] }); await h.flush();
  assert.equal(h.sent.length, 0, 'timed-out mapping cannot publish a late result');
  h.controller.handlePeerStateEvent({ peerId: 'peer', state: 'connected' });
  assert.equal(h.metadata.get('peer').hasConnected, true);
});

test('native close cancels pending connection and mapping timers', async () => {
  const h = harness(); await h.create();
  h.controller.rememberLocalIceCandidate('peer', host());
  h.controller.handlePeerStateEvent({ peerId: 'peer', state: 'closed' });
  assert.equal(h.timers.size, 0);
  await h.tick(25000);
  assert.equal(h.mapped.length, 0);
});
