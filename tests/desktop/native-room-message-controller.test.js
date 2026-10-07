const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const publicPath = path.resolve(__dirname, '../../server/public');

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function createHarness(initialState = {}, cleanup = async () => {}) {
  const context = { window: { VDS: {} } };
  for (const file of ['room-client.js', 'native/native-room-message-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(publicPath, file), 'utf8'), context, { filename: file });
  }
  const state = { role: 'viewer', roomId: 'ROOM1', sessionToken: null, generation: 1, pending: true, ...initialState };
  const calls = { leaves: [], manifest: [], patches: [], joinedUi: [], cleanup: 0, joined: 0, armed: [], hostUi: [] };
  const controller = context.window.VDS.nativeRoomMessages.createController({
    roomClient: {
      leaveRoom: request => {
        calls.leaves.push({ ...context.window.VDS.roomClient.buildLeaveRoomMessage(request), sendOptions: request.sendOptions });
        return true;
      }
    },
    p2pStateMachine: { armViewerUpstreamOfferWaitTimer: peerId => calls.armed.push(peerId) },
    getClientId: () => 'viewer-test',
    getSessionRole: () => state.role,
    getCurrentRoomId: () => state.roomId,
    getCurrentSessionToken: () => state.sessionToken,
    getViewerJoinGeneration: () => state.generation,
    isViewerJoinPending: () => state.pending,
    getHostId: () => state.hostId,
    getUpstreamPeerId: () => state.upstreamPeerId,
    getChainPosition: () => state.chainPosition,
    clearAllPeerConnections: () => { calls.cleanup += 1; return cleanup(); },
    rememberMediaManifest: manifest => calls.manifest.push(manifest),
    setViewerRoomState: value => Object.assign(state, { ...value, role: 'viewer' }),
    setSessionRoomState: value => Object.assign(state, value),
    setViewerResumeState: value => Object.assign(state, value),
    syncRendererAppState: (reason, patch) => calls.patches.push({ reason, patch }),
    handleViewerJoinSucceeded: () => { state.pending = false; calls.joined += 1; },
    setViewerJoinedUi: value => calls.joinedUi.push(value),
    setHostRoomActiveUi: value => calls.hostUi.push(value)
  });
  return {
    controller, state, calls,
    cancel: () => Object.assign(state, { role: null, roomId: null, sessionToken: null, pending: false, generation: state.generation + 1 })
  };
}

function ack(overrides = {}) {
  return { roomId: 'ROOM1', clientId: 'viewer-test', sessionToken: 'ack-token', hostId: 'host1', upstreamPeerId: 'host1', chainPosition: 0, mediaManifest: { mediaSessionId: 'media1' }, ...overrides };
}

function assertNoViewerCommit(calls) {
  assert.equal(calls.manifest.length, 0);
  assert.equal(calls.patches.length, 0);
  assert.equal(calls.joinedUi.length, 0);
  assert.equal(calls.joined, 0);
  assert.equal(calls.armed.length, 0);
}

test('normal requested room acknowledgement commits the viewer session and waiting UI', async () => {
  const { controller, state, calls } = createHarness();
  await controller.handleRoomJoinedMessage(ack());
  assert.equal(state.roomId, 'ROOM1');
  assert.equal(state.sessionToken, 'ack-token');
  assert.equal(state.pending, false);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.joined, 1);
  assert.equal(calls.manifest.length, 1);
  assert.deepEqual(calls.armed, ['host1']);
  assert.equal(calls.leaves.length, 0);
});

test('an acknowledgement received after cancellation cannot revive the room and releases its own token', async () => {
  const harness = createHarness();
  harness.cancel();
  await harness.controller.handleRoomJoinedMessage(ack());
  assert.equal(harness.state.roomId, null);
  assert.equal(harness.calls.cleanup, 0);
  assertNoViewerCommit(harness.calls);
  assert.equal(harness.calls.leaves.length, 1);
  assert.equal(harness.calls.leaves[0].roomId, 'ROOM1');
  assert.equal(harness.calls.leaves[0].sessionToken, 'ack-token');
  assert.equal(harness.calls.leaves[0].sendOptions.queueIfDisconnected, false);
});

test('cancellation during peer cleanup prevents all delayed acknowledgement commits', async () => {
  const cleanup = deferred();
  const harness = createHarness({}, () => cleanup.promise);
  const joined = harness.controller.handleRoomJoinedMessage(ack());
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.manifest.length, 0);
  harness.cancel();
  cleanup.resolve();
  await joined;
  assert.equal(harness.state.roomId, null);
  assertNoViewerCommit(harness.calls);
  assert.equal(harness.calls.leaves.length, 1);
});

test('a different-room acknowledgement cannot clear peers or overwrite the current join', async () => {
  const { controller, state, calls } = createHarness({ roomId: 'NEWROOM' });
  await controller.handleRoomJoinedMessage(ack());
  assert.equal(state.roomId, 'NEWROOM');
  assert.equal(state.pending, true);
  assert.equal(calls.cleanup, 0);
  assertNoViewerCommit(calls);
  assert.equal(calls.leaves[0].roomId, 'ROOM1');
  assert.equal(calls.leaves[0].sessionToken, 'ack-token');
});

test('a new room joined during old peer cleanup survives the old acknowledgement', async () => {
  const cleanup = deferred();
  const { controller, state, calls } = createHarness({}, () => cleanup.promise);
  const joined = controller.handleRoomJoinedMessage(ack());
  Object.assign(state, { roomId: 'NEWROOM', sessionToken: 'new-token', pending: false, generation: 2 });
  cleanup.resolve();
  await joined;
  assert.equal(state.roomId, 'NEWROOM');
  assert.equal(state.sessionToken, 'new-token');
  assertNoViewerCommit(calls);
  assert.equal(calls.leaves[0].roomId, 'ROOM1');
  assert.equal(calls.leaves[0].sessionToken, 'ack-token');
});

for (const pending of [true, false]) {
  test(`same-room replacement (${pending ? 'pending' : 'active'}) is never released by the old acknowledgement`, async () => {
    const cleanup = deferred();
    const { controller, state, calls } = createHarness({}, () => cleanup.promise);
    const joined = controller.handleRoomJoinedMessage(ack());
    Object.assign(state, { sessionToken: pending ? null : 'new-token', pending, generation: 2 });
    cleanup.resolve();
    await joined;
    assert.equal(state.roomId, 'ROOM1');
    assert.equal(state.sessionToken, pending ? null : 'new-token');
    assert.equal(state.pending, pending);
    assertNoViewerCommit(calls);
    assert.equal(calls.leaves.length, 0);
  });
}

test('stale cleanup never sends the current session token even for a different room', async () => {
  const { controller, calls } = createHarness({ roomId: 'NEWROOM', sessionToken: 'ack-token', pending: false });
  await controller.handleRoomJoinedMessage(ack());
  assertNoViewerCommit(calls);
  assert.equal(calls.leaves.length, 0);
});

test('normal viewer session resume restores room state after peer cleanup', async () => {
  const cleanup = deferred();
  const { controller, state, calls } = createHarness({ sessionToken: 'ack-token', pending: false }, () => cleanup.promise);
  const resumed = controller.handleSessionResumedMessage(ack({ role: 'viewer', chainPosition: 2 }));
  assert.equal(calls.patches.length, 0);
  cleanup.resolve();
  await resumed;
  assert.equal(state.role, 'viewer');
  assert.equal(state.sessionToken, 'ack-token');
  assert.equal(state.chainPosition, 2);
  assert.equal(calls.joinedUi.length, 1);
  assert.equal(calls.leaves.length, 0);
});

test('viewer resume cancelled during peer cleanup cannot restore a departed session', async () => {
  const cleanup = deferred();
  const harness = createHarness({ sessionToken: 'ack-token', pending: false }, () => cleanup.promise);
  const resumed = harness.controller.handleSessionResumedMessage(ack({ role: 'viewer' }));
  harness.cancel();
  cleanup.resolve();
  await resumed;
  assert.equal(harness.state.roomId, null);
  assertNoViewerCommit(harness.calls);
  assert.equal(harness.calls.leaves[0].sessionToken, 'ack-token');
});

test('stale viewer resume is rejected before touching state or peer resources', async () => {
  const harness = createHarness();
  harness.cancel();
  await harness.controller.handleSessionResumedMessage(ack({ role: 'viewer' }));
  assert.equal(harness.state.roomId, null);
  assert.equal(harness.calls.cleanup, 0);
  assertNoViewerCommit(harness.calls);
  assert.equal(harness.calls.leaves.length, 1);
});

test('normal host session resume still restores the host room UI', async () => {
  const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'host-token', pending: false });
  await controller.handleSessionResumedMessage(ack({ role: 'host', sessionToken: 'host-token' }));
  assert.equal(state.role, 'host');
  assert.equal(state.sessionToken, 'host-token');
  assert.equal(calls.hostUi.length, 1);
  assert.equal(calls.cleanup, 0);
  assert.equal(calls.leaves.length, 0);
});
