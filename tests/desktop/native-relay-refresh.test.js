const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('refreshing a relay viewer replaces its old transport and sends a new offer', async () => {
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  for (const file of ['native-peer-controller.js', 'native-peer-message-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../server/public/native', file), 'utf8'), context);
  }
  const sent = [], closed = [];
  let generation = 0, controller;
  controller = context.window.VDS.nativePeer.createController({
    isHost: () => false, getSessionRole: () => 'viewer', getUpstreamPeerId: () => 'host',
    getCurrentRoomId: () => 'ABC234',
    roomClient: { sendSignal: message => sent.push(message) },
    mediaEngine: {
      createPeer: async () => ({ transportGeneration: `generation-${++generation}` }),
      closePeer: async ({ peerId }) => closed.push(peerId),
      attachPeerMediaSource: async ({ peerId }) => {
        controller.handleLocalSignalEvent({
          peerId, transportGeneration: `generation-${generation}`, type: 'offer',
          sdp: { type: 'offer', sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\na=ice-ufrag:g${generation}\r\n` }
        });
      }
    }
  });
  const messages = context.window.VDS.nativePeerMessages.createController({
    nativePeerController: controller,
    createOfferToNextViewer: (...args) => controller.createRelayViewerOffer(...args)
  });
  try {
    await messages.handleConnectToNextMessage({ nextViewerId: 'web-viewer' });
    assert.equal(sent.length, 1);
    await messages.handleConnectToNextMessage({ nextViewerId: 'web-viewer' });
    assert.equal(sent.length, 1, 'duplicate initial notice keeps the existing negotiation');
    await messages.handleConnectToNextMessage({ nextViewerId: 'web-viewer', reconnect: true });
    assert.equal(generation, 2, 'a refreshed page cannot reuse its destroyed transport');
    assert.equal(sent.length, 2, 'the replacement page must receive a fresh offer');
    assert.notEqual(sent[0].sdp.sdp, sent[1].sdp.sdp);
    assert.equal(sent[1].reconnect, true);
    assert.deepEqual(closed, ['web-viewer']);
  } finally {
    await controller.closePeerConnection('web-viewer', { clearRetryState: true });
  }
});

for (const failure of ['failed', 'disconnected', 'datachannel-closed']) {
  test(`native relay ${failure} rebuilds only its downstream with a fresh relay offer`, async () => {
    let now = 0, sequence = 0, generation = 0;
    const timers = new Map(), metadata = new Map(), sent = [], closed = [], sources = [];
    const setTimeout = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; };
    const clearTimeout = id => timers.delete(id);
    const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(process.env.VDS_RELAY_RECOVERY_TEST_SOURCE ||
      path.resolve(__dirname, '../../server/public/native/native-peer-controller.js'), 'utf8'), context);
    const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
    const tick = async ms => {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    };
    let controller;
    controller = context.window.VDS.nativePeer.createController({
      isHost: () => false, getSessionRole: () => 'viewer', getUpstreamPeerId: () => 'host',
      getCurrentRoomId: () => 'ABC234',
      getRecoveryRoomSnapshot: () => ({ roomId: 'ABC234', role: 'viewer' }),
      getPeerMeta: id => metadata.get(id), setPeerMeta: (id, value) => metadata.set(id, value),
      deletePeerMeta: id => metadata.delete(id),
      roomClient: { sendSignal: message => sent.push(message) },
      mediaEngine: {
        createPeer: async () => ({ transportGeneration: `g${++generation}` }),
        closePeer: async ({ peerId }) => closed.push(peerId),
        attachPeerMediaSource: async ({ peerId, source }) => {
          sources.push(source);
          controller.handleLocalSignalEvent({ peerId,
            transportGeneration: controller.getPeerHandle(peerId).transportGeneration, type: 'offer',
            sdp: { type: 'offer', sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\na=ice-ufrag:g${generation}\r\n` }
          });
        }
      }
    });
    try {
      const upstream = controller.createPeerConnection('host', false, 'upstream');
      await controller.ensurePeerReady('host', upstream);
      controller.handlePeerStateEvent({ peerId: 'host', state: 'connected' });
      const downstream = await controller.createRelayViewerOffer('next');
      controller.handlePeerStateEvent({ peerId: 'next', state: 'connected' });
      controller.handlePeerStateEvent({ peerId: 'next', state: 'disconnected' });
      await tick(2000);
      controller.handlePeerStateEvent({ peerId: 'next', state: 'connected' });
      await tick(3000);
      assert.equal(sent.length, 1, 'a short outage keeps the relay');
      controller.handlePeerStateEvent({ peerId: 'next', state: failure });
      await tick(4000);
      assert.equal(sent.length, 2, 'the relay must send its own fresh offer');
      const replacement = controller.getPeerHandle('next');
      assert.notEqual(replacement, downstream);
      assert.equal(replacement.role, 'relay-downstream');
      assert.equal(replacement.relaySourcePeerId, 'host');
      assert.equal(sent[1].isRelay, true);
      assert.equal(sent[1].reconnect, true);
      assert.notEqual(sent[0].sdp.sdp, sent[1].sdp.sdp);
      assert.deepEqual(sources, ['peer-video:host', 'peer-video:host']);
      assert.deepEqual(closed, ['next']);
      assert.equal(controller.getPeerHandle('host'), upstream);
      assert.equal(upstream.connectionState, 'connected');
    } finally {
      await controller.closeAllPeers();
    }
    assert.equal(timers.size, 0);
  });
}

test('a retired relay offer cannot overwrite or close its replacement after a late media RPC', async () => {
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  for (const file of ['native-peer-controller.js', 'native-peer-message-controller.js']) {
    const override = file === 'native-peer-controller.js' ? process.env.VDS_RELAY_RECOVERY_TEST_SOURCE : process.env.VDS_RELAY_MESSAGES_TEST_SOURCE;
    vm.runInNewContext(fs.readFileSync(override || path.resolve(__dirname, '../../server/public/native', file), 'utf8'), context);
  }
  const sent = [], closed = [];
  let generation = 0, releaseOld, enteredOld;
  const entered = new Promise(resolve => { enteredOld = resolve; });
  const held = new Promise(resolve => { releaseOld = resolve; });
  let controller;
  controller = context.window.VDS.nativePeer.createController({
    isHost: () => false, getSessionRole: () => 'viewer', getUpstreamPeerId: () => 'host',
    getCurrentRoomId: () => 'ABC234',
    roomClient: { sendSignal: message => sent.push(message) },
    mediaEngine: {
      createPeer: async () => ({ transportGeneration: `g${++generation}` }),
      closePeer: async ({ peerId }) => closed.push(peerId),
      attachPeerMediaSource: async ({ peerId }) => {
        const currentGeneration = generation;
        controller.handleLocalSignalEvent({ peerId, transportGeneration: `g${currentGeneration}`, type: 'offer',
          sdp: { type: 'offer', sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\na=ice-ufrag:g${currentGeneration}\r\n` }
        });
        if (currentGeneration === 1) { enteredOld(); await held; }
      }
    }
  });
  const messages = context.window.VDS.nativePeerMessages.createController({
    nativePeerController: controller,
    createOfferToNextViewer: (...args) => controller.createRelayViewerOffer(...args),
    closePeerConnection: (...args) => controller.closePeerConnection(...args)
  });
  const old = messages.handleConnectToNextMessage({ nextViewerId: 'next' });
  try {
    await entered;
    await messages.handleConnectToNextMessage({ nextViewerId: 'next', reconnect: true });
    const replacement = controller.getPeerHandle('next');
    assert.equal(sent.length, 1);
    const sdp = replacement.localDescription.sdp;
    releaseOld(); await old;
    assert.equal(sent.length, 1, 'old SDP must not be sent under a replacement attempt ID');
    assert.equal(controller.getPeerHandle('next'), replacement);
    assert.equal(replacement.closed, false, 'stale-offer handling must not close the current edge');
    assert.equal(replacement.localDescription.sdp, sdp);
    assert.deepEqual(closed, ['next']);
    assert.equal(controller.getPeerReconnectState('next').timerId, null);
  } finally {
    releaseOld(); await old;
    await controller.closeAllPeers();
  }
});

test('an answer resolved just before peer replacement cannot mutate the new handle', async () => {
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(process.env.VDS_RELAY_RECOVERY_TEST_SOURCE ||
    path.resolve(__dirname, '../../server/public/native/native-peer-controller.js'), 'utf8'), context);
  let generation = 0;
  const controller = context.window.VDS.nativePeer.createController({
    mediaEngine: { createPeer: async () => ({ transportGeneration: `g${++generation}` }), closePeer: async () => {} }
  });
  const old = controller.createPeerConnection('peer', false, 'upstream');
  await controller.ensurePeerReady('peer', old);
  const result = controller.prepareAnswerSignal('peer', old).then(() => null, error => error);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  controller.enqueueSignal({ peerId: 'peer', type: 'answer', sdp: { type: 'answer', sdp: 'old-answer' } });
  const replacement = controller.createPeerConnection('peer', false, 'upstream');
  try {
    const error = await result;
    assert.match(error?.message || '', /native-peer-stale/);
    assert.equal(replacement.localDescription, null);
  } finally {
    await controller.closeAllPeers();
  }
});

test('replacing a peer cancels its pending signal wait immediately and preserves the new waiter', async () => {
  let next = 1;
  const timers = new Map();
  const setTimeout = (fn, delay) => { const id = next++; timers.set(id, { fn, delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  const context = { window: { VDS: {}, setTimeout, clearTimeout }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(process.env.VDS_RELAY_RECOVERY_TEST_SOURCE ||
    path.resolve(__dirname, '../../server/public/native/native-peer-controller.js'), 'utf8'), context);
  const controller = context.window.VDS.nativePeer.createController({
    mediaEngine: { createPeer: async () => ({}), closePeer: async () => {} }
  });
  controller.createPeerConnection('peer', false, 'upstream');
  let oldError;
  controller.waitForSignal('peer', 'answer').catch(error => { oldError = error; });
  assert.equal(timers.size, 1);
  controller.createPeerConnection('peer', false, 'upstream');
  const current = controller.waitForSignal('peer', 'answer');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(oldError?.message || '', /native-peer-stale/, 'do not wait 15 seconds for a retired operation');
  assert.equal(timers.size, 1, 'only the replacement waiter retains a deadline');
  controller.enqueueSignal({ peerId: 'peer', type: 'answer', sdp: { type: 'answer', sdp: 'new-answer' } });
  assert.equal((await current).sdp.sdp, 'new-answer');
  await controller.closeAllPeers();
  assert.equal(timers.size, 0);
});
