const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../server/public/native/native-peer-controller.js'), 'utf8');
const candidate = (ufrag = '', predicted = false) => ({
  candidate: `candidate:fixture 1 udp 100 127.0.0.2 45001 typ srflx${ufrag ? ` ufrag ${ufrag}` : ''}${predicted ? ' vds-predicted 1' : ''}`,
  sdpMid: 'media'
});
const description = (ufrag) => ({ type: 'offer', sdp: `v=0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:fixture-password-123456789\r\n` });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}) {
  const context = { window: { VDS: {} }, setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(source, context);
  const metadata = new Map();
  const calls = [];
  const sent = [];
  let generation = 0;
  const controller = context.window.VDS.nativePeer.createController({
    isHost: () => true,
    getPeerMeta: (id) => metadata.get(id),
    setPeerMeta: (id, value) => metadata.set(id, value),
    mediaEngine: {
      createPeer: async () => ({ peerTransport: { transportGeneration: `transport-${++generation}` } }),
      addRemoteIceCandidate: async (request) => calls.push(request),
      ...overrides
    },
    roomClient: { sendSignal: (message) => sent.push(message) }
  });
  async function create() {
    const handle = controller.createPeerConnection('peer', true);
    await controller.ensurePeerReady('peer', handle);
    return handle;
  }
  return { controller, metadata, calls, sent, create };
}

test('queued predictions retain ICE credentials and cannot cross a remote SDP generation', async () => {
  const h = harness();
  await h.controller.finalizeRemoteIceCandidate('peer', candidate('old-ufrag', true), 1);
  const handle = await h.create();
  handle.remoteDescription = description('current-ufrag');
  const result = await h.controller.flushQueuedRemoteCandidates('peer', handle);
  assert.equal(result.results[0].reason, 'stale-ice-ufrag');
  assert.equal(h.calls.length, 0);
});

test('a candidate arriving before peer creation keeps its original edge attempt', async () => {
  const h = harness();
  await h.controller.finalizeRemoteIceCandidate('peer', candidate('current-ufrag', true), 99);
  const handle = await h.create();
  handle.remoteDescription = description('current-ufrag');
  const result = await h.controller.flushQueuedRemoteCandidates('peer', handle);
  assert.equal(result.results[0].reason, 'stale-attempt');
  assert.equal(h.calls.length, 0);
});

test('predictions require an unambiguous current ufrag and ordinary legacy candidates remain usable', async () => {
  const h = harness();
  const handle = await h.create();
  handle.remoteDescription = description('current-ufrag');
  for (const invalid of [candidate('', true), candidate('old-ufrag', true),
    { ...candidate('current-ufrag', true), usernameFragment: 'different-ufrag' },
    { ...candidate('current-ufrag', true), candidate: `${candidate('current-ufrag', true).candidate} ufrag conflicting-ufrag` }]) {
    const result = await h.controller.finalizeRemoteIceCandidate('peer', invalid, handle.attemptId);
    assert.equal(result.reason, 'stale-ice-ufrag');
  }
  assert.equal(h.calls.length, 0);
  await h.controller.finalizeRemoteIceCandidate('peer', candidate('current-ufrag', true), handle.attemptId);
  await h.controller.finalizeRemoteIceCandidate('peer', candidate(), null);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((entry) => entry.transportGeneration === 'transport-1'));
});

test('pending candidates are checked again after the edge attempt changes', async () => {
  const h = harness();
  const handle = await h.create();
  await h.controller.finalizeRemoteIceCandidate('peer', candidate('current-ufrag', true), handle.attemptId);
  h.metadata.get('peer').edgeAttemptId += 1;
  handle.remoteDescription = description('current-ufrag');
  const result = await h.controller.flushQueuedRemoteCandidates('peer', handle);
  assert.equal(result.results[0].reason, 'stale-attempt');
  assert.equal(h.calls.length, 0);
});

test('obsolete native candidate events cannot borrow the replacement transport attempt', async () => {
  const h = harness();
  const handle = await h.create();
  h.controller.handleLocalSignalEventAndSend({ peerId: 'peer', type: 'candidate',
    transportGeneration: 'retired-transport', candidate: candidate('old-ufrag', true) });
  assert.equal(h.sent.length, 0);
  assert.equal(h.metadata.get('peer').localCandidateCount, 0);
  h.controller.handleLocalSignalEventAndSend({ peerId: 'peer', type: 'candidate',
    transportGeneration: handle.transportGeneration, candidate: candidate('current-ufrag', true) });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].attemptId, handle.attemptId);
});

test('early native events wait for the RPC transport identity and discard a retired identity', async () => {
  const ready = deferred();
  const h = harness({ createPeer: () => ready.promise });
  const handle = h.controller.createPeerConnection('peer', true);
  for (const transportGeneration of ['retired-transport', 'current-transport']) {
    h.controller.handleLocalSignalEventAndSend({ peerId: 'peer', type: 'candidate',
      transportGeneration, candidate: candidate('current-ufrag', true) });
  }
  assert.equal(h.sent.length, 0);
  ready.resolve({ transportGeneration: 'current-transport' });
  await h.controller.ensurePeerReady('peer', handle);
  assert.equal(h.sent.length, 1);
  assert.equal(h.metadata.get('peer').localCandidateCount, 1);
});

test('an in-flight candidate flush cannot mutate or continue on a replacement peer', async () => {
  const applied = deferred();
  const entered = deferred();
  const h = harness({ addRemoteIceCandidate: async (request) => { entered.resolve(); await applied.promise; } });
  const old = await h.create();
  await h.controller.finalizeRemoteIceCandidate('peer', candidate('current-ufrag', true), old.attemptId);
  await h.controller.finalizeRemoteIceCandidate('peer', { ...candidate('current-ufrag', true),
    candidate: candidate('current-ufrag', true).candidate.replace('45001', '45002') }, old.attemptId);
  old.remoteDescription = description('current-ufrag');
  const flush = h.controller.flushQueuedRemoteCandidates('peer', old);
  await entered.promise;
  old.closed = true;
  const replacement = await h.create();
  replacement.remoteDescription = description('next-ufrag');
  applied.resolve();
  const result = await flush;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].reason, 'stale-peer');
  assert.equal(h.metadata.get('peer').remoteCandidateKeys.size, 0);
});

test('early and retired native state events cannot connect or fail the current transport', async () => {
  const ready = deferred();
  const h = harness({ createPeer: () => ready.promise });
  const handle = h.controller.createPeerConnection('peer', true);
  const early = h.controller.applyPeerStateEvent({ peerId: 'peer', state: 'connected', transportGeneration: 'current-transport' });
  assert.equal(early.handled, false);
  assert.equal(h.metadata.get('peer').hasConnected, false);
  ready.resolve({ transportGeneration: 'current-transport' });
  await h.controller.ensurePeerReady('peer', handle);
  assert.equal(h.controller.applyPeerStateEvent({ peerId: 'peer', state: 'connected', transportGeneration: 'current-transport' }).handled, true);
  assert.equal(h.controller.applyPeerStateEvent({ peerId: 'peer', state: 'failed', transportGeneration: 'retired-transport' }).handled, false);
  assert.equal(handle.connectionState, 'connected');
});

test('remote description and close RPCs carry the transport identity confirmed by createPeer', async () => {
  const descriptions = [];
  const closes = [];
  const h = harness({ setRemoteDescription: async (request) => descriptions.push(request),
    closePeer: async (request) => closes.push(request) });
  const handle = await h.create();
  await h.controller.setRemoteDescription('peer', handle, description('current-ufrag'));
  await h.controller.closePeerConnection('peer');
  assert.equal(descriptions[0].transportGeneration, 'transport-1');
  assert.equal(closes[0].transportGeneration, 'transport-1');
});

test('closing during create waits for its actual identity before issuing a close RPC', async () => {
  const ready = deferred();
  const closes = [];
  const h = harness({ createPeer: () => ready.promise, closePeer: async (request) => closes.push(request) });
  const handle = h.controller.createPeerConnection('peer', true);
  const closing = h.controller.closePeerConnection('peer');
  assert.equal(closes.length, 0);
  ready.resolve({ peerTransport: { transportGeneration: 'creating-transport' } });
  await closing;
  assert.equal(closes.length, 1);
  assert.equal(closes[0].transportGeneration, 'creating-transport');
});

test('a delayed old close cannot erase the replacement handle or its metadata', async () => {
  const detached = deferred();
  const entered = deferred();
  const closes = [];
  const h = harness({ detachPeerMediaSource: async () => { entered.resolve(); await detached.promise; },
    closePeer: async (request) => closes.push(request) });
  const old = await h.create();
  const closing = h.controller.closePeerConnection('peer');
  await entered.promise;
  const current = await h.create();
  detached.resolve();
  await closing;
  assert.equal(h.controller.getPeerHandle('peer'), current);
  assert.equal(h.metadata.get('peer').attemptId, current.attemptId);
  assert.equal(closes[0].transportGeneration, old.transportGeneration);
});
