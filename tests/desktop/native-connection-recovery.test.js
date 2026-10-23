const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ isHost = false, closing = null, offering = null } = {}) {
  let now = 0, next = 1;
  const timers = new Map(), metadata = new Map(), sent = [], offers = [], closes = [];
  let room = { roomId: 'ABC234', role: isHost ? 'host' : 'viewer', clientId: 'viewer', sessionToken: 'token' };
  const setTimeout = (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; };
  const clearTimeout = id => timers.delete(id);
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(process.env.VDS_ICE_CONTROLLER_TEST_SOURCE ||
    path.resolve(__dirname, '../../server/public/native/native-peer-controller.js'), 'utf8'), context);
  const controller = context.window.VDS.nativePeer.createController({
    isHost: () => isHost, getRecoveryRoomSnapshot: () => ({ ...room }),
    getPeerMeta: id => metadata.get(id), setPeerMeta: (id, value) => metadata.set(id, value),
    deletePeerMeta: id => metadata.delete(id),
    closePeerConnection: async id => { closes.push(id); await closing?.promise; await controller.closePeerConnection(id); },
    createOffer: async (id, options) => { offers.push({ id, options }); await offering?.promise; },
    roomClient: { sendViewerReconnectReady: value => sent.push(value) },
    mediaEngine: { createPeer: async () => ({ transportGeneration: 'g' + next++ }), closePeer: async () => {} }
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const event = state => controller.handlePeerStateEvent({ peerId: 'peer', state });
  const create = async () => {
    const handle = controller.createPeerConnection('peer', isHost, isHost ? 'direct' : 'upstream');
    await controller.ensurePeerReady('peer', handle);
    event('connected');
    return handle;
  };
  const tick = async ms => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = target; await flush();
  };
  return { controller, metadata, timers, sent, offers, closes, create, event, tick, flush, leave: () => { room = {}; } };
}

for (const isHost of [false, true]) {
  test(`terminal failure after connected recovers the ${isHost ? 'host' : 'viewer'} edge without a disconnected event`, async () => {
    const h = harness({ isHost }); await h.create();
    h.event('failed'); await h.tick(1);
    assert.equal(isHost ? h.offers.length : h.sent.length, 1);
    if (isHost) assert.equal(h.offers[0].options.reconnect, true);
    else assert.equal(h.sent[0].roomId, 'ABC234');
  });
}

test('short native outage is cancelled, repeated events preserve the original grace deadline', async () => {
  const h = harness(); await h.create();
  h.event('disconnected'); await h.tick(3000); h.event('connected'); await h.tick(2000);
  assert.equal(h.sent.length, 0);
  h.event('disconnected'); await h.tick(3000); h.event('disconnected'); await h.tick(1000);
  assert.equal(h.sent.length, 1);
});

for (const isHost of [false, true]) {
  test(`closed media channel recovers ${isHost ? 'host' : 'viewer'} despite a late connected notification`, async () => {
    const h = harness({ isHost }); await h.create();
    h.event('datachannel-closed'); h.event('connected'); await h.tick(1);
    assert.equal(isHost ? h.offers.length : h.sent.length, 1);
  });
}

test('intentional peer shutdown does not restart on its media channel close', async () => {
  const h = harness(), handle = await h.create();
  handle.closed = true;
  h.event('datachannel-closed'); await h.tick(10000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.offers.length, 0);
});

test('terminal failure accelerates grace and duplicate failures do not issue parallel offers', async () => {
  const offering = deferred(), h = harness({ isHost: true, offering }); await h.create();
  h.event('disconnected'); await h.tick(500); h.event('failed'); await h.tick(1);
  assert.equal(h.offers.length, 1);
  h.event('failed'); h.event('disconnected'); await h.tick(5000);
  assert.equal(h.offers.length, 1);
  offering.resolve(); await h.flush();
});

test('a stale retry cannot clear the replacement edge recovery guard', async () => {
  const h = harness(), old = await h.create();
  h.event('disconnected');
  const retiredTimer = [...h.timers.values()][0].fn;
  const current = await h.create(); h.event('disconnected');
  assert.notEqual(old.attemptId, current.attemptId);
  await retiredTimer();
  assert.equal(h.metadata.get('peer').restartInProgress, true);
  await h.tick(4000); assert.equal(h.sent.length, 1);
});

test('late disconnect timer does not invoke recovery for a replacement handle', async () => {
  const h = harness(); await h.create();
  h.event('disconnected');
  const retiredTimer = [...h.timers.values()][0].fn;
  const handle = await h.create();
  await retiredTimer(); await h.tick(4000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.getPeerHandle('peer'), handle);
});

test('leaving the room while recovery closes cannot send a stale rejoin request', async () => {
  const closing = deferred(), h = harness({ closing }); await h.create();
  h.event('disconnected'); await h.tick(4000);
  assert.equal(h.closes.length, 1);
  h.leave(); closing.resolve(); await h.flush();
  assert.equal(h.sent.length, 0);
});

test('replacement offer during close invalidates the old recovery request', async () => {
  // Use a close callback that only waits: production close already guards its
  // captured handle. This test isolates the continuation after that await.
  const closing = deferred(), h = harness({ closing }); await h.create();
  const oldClose = h.controller.closePeerConnection;
  h.controller.closePeerConnection = async () => {};
  h.event('disconnected'); await h.tick(4000);
  await h.create(); closing.resolve(); await h.flush();
  assert.equal(h.sent.length, 0);
  h.controller.closePeerConnection = oldClose;
});
