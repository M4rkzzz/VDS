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

function createHarness(initialState = {}, cleanup = async () => {}, extraOptions = {}) {
  const context = { window: { VDS: {} } };
  for (const file of ['room-client.js', 'native/native-room-message-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(publicPath, file), 'utf8'), context, { filename: file });
  }
  const state = {
    role: 'viewer', roomId: 'ROOM1', sessionToken: null, generation: 1, pending: true,
    hostGeneration: 1, hostRunning: initialState.role === 'host', hostStopping: false,
    mediaSessionId: 'media1', mediaManifest: { mediaSessionId: 'media1', video: { codec: 'h264' } },
    publicListing: false, obsBackend: false, obsActive: false, obsPending: false,
    ...initialState
  };
  const calls = { leaves: [], creates: [], queueClears: [], manifest: [], patches: [], joinedUi: [], cleanup: 0,
    joined: 0, armed: [], hostUi: [], hostStatus: [], viewerStatus: [], errors: [], hidden: [], viewerReset: 0,
    relayRetryClears: 0, timerClears: 0 };
  const controller = context.window.VDS.nativeRoomMessages.createController({
    roomClient: {
      createRoom: request => { calls.creates.push(request); return true; },
      clearPendingSignalingQueues: reason => calls.queueClears.push(reason),
      leaveRoom: request => {
        calls.leaves.push({ ...context.window.VDS.roomClient.buildLeaveRoomMessage(request), sendOptions: request.sendOptions });
        return true;
      }
    },
    p2pStateMachine: {
      armViewerUpstreamOfferWaitTimer: peerId => calls.armed.push(peerId),
      clearViewerUpstreamOfferWaitTimer: () => { calls.timerClears += 1; },
      clearViewerMediaWaitTimer: () => { calls.timerClears += 1; }
    },
    nativeSessionState: {
      setObsRoomCreatePending: pending => { state.obsPending = pending; },
      getObsIngestStreamActive: () => state.obsActive,
      setObsIngestStreamActive: active => { state.obsActive = active; }
    },
    getClientId: () => 'viewer-test',
    getSessionRole: () => state.role,
    getCurrentRoomId: () => state.roomId,
    getCurrentSessionToken: () => state.sessionToken,
    getCurrentHostMediaSessionId: () => state.mediaSessionId,
    getCurrentMediaManifest: () => state.mediaManifest,
    getHostStartGeneration: () => state.hostGeneration,
    isNativeHostSessionRunning: () => state.hostRunning,
    isHostStopping: () => state.hostStopping,
    getPublicRoomEnabled: () => state.publicListing,
    isObsIngestHostBackend: () => state.obsBackend,
    getViewerJoinGeneration: () => state.generation,
    isViewerJoinPending: () => state.pending,
    getHostId: () => state.hostId,
    getUpstreamPeerId: () => state.upstreamPeerId,
    getChainPosition: () => state.chainPosition,
    clearAllPeerConnections: () => { calls.cleanup += 1; return cleanup(); },
    clearAllRelayOfferRetries: () => { calls.relayRetryClears += 1; },
    resetViewerState: () => {
      calls.viewerReset += 1;
      Object.assign(state, { role: null, roomId: null, sessionToken: null, pending: false, generation: state.generation + 1 });
      return cleanup();
    },
    rememberMediaManifest: manifest => calls.manifest.push(manifest),
    setViewerRoomState: value => Object.assign(state, { ...value, role: 'viewer' }),
    setHostRoomState: value => Object.assign(state, { ...value, role: 'host' }),
    setSessionRoomState: value => Object.assign(state, value),
    setViewerResumeState: value => Object.assign(state, value),
    syncRendererAppState: (reason, patch) => calls.patches.push({ reason, patch }),
    handleViewerJoinSucceeded: () => { state.pending = false; calls.joined += 1; },
    setViewerJoinedUi: value => calls.joinedUi.push(value),
    setHostRoomActiveUi: value => calls.hostUi.push(value),
    setViewerCount: count => { state.viewerCount = count; },
    setRoomInfoHidden: hidden => calls.hidden.push(hidden),
    setHostStatus: (text, waiting) => calls.hostStatus.push({ text, waiting }),
    setViewerConnectionState: text => calls.viewerStatus.push(text),
    showError: message => calls.errors.push(message),
    ...extraOptions
  });
  return {
    controller, state, calls, context,
    cancel: () => Object.assign(state, { role: null, roomId: null, sessionToken: null, pending: false,
      generation: state.generation + 1, hostGeneration: state.hostGeneration + 1, hostRunning: false })
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

test('expired host session recreates one real room using the existing capture manifest and public setting', async () => {
  const cleanup = deferred();
  const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-host-token',
    pending: false, publicListing: true, viewerCount: 7 }, () => cleanup.promise);
  const manifest = state.mediaManifest;
  const first = controller.handleErrorMessage({ code: 'session-not-found' });
  const duplicate = controller.handleErrorMessage({ code: 'room-not-found' });
  assert.equal(state.roomId, null);
  assert.equal(state.sessionToken, '');
  assert.equal(state.hostRunning, true);
  assert.equal(state.mediaSessionId, 'media1');
  assert.equal(state.mediaManifest, manifest);
  assert.equal(state.viewerCount, 0);
  assert.deepEqual(calls.hidden, [true]);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.relayRetryClears, 1);
  assert.equal(calls.creates.length, 0);
  cleanup.resolve();
  await Promise.all([first, duplicate]);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].mediaManifest, manifest);
  assert.equal(calls.creates[0].publicListing, true);
  assert.equal(calls.creates[0].clientId, 'viewer-test');
  assert.equal(state.obsPending, true);
  await controller.handleErrorMessage({ code: 'session-not-found' });
  assert.equal(calls.creates.length, 1, 'duplicate errors before the create acknowledgement must not create another room');
  await controller.handleRoomCreatedMessage(ack({ roomId: 'AABBCC112233', sessionToken: 'new-host-token' }));
  assert.equal(state.roomId, 'AABBCC112233');
  assert.equal(state.sessionToken, 'new-host-token');
  assert.equal(state.role, 'host');
  assert.equal(state.hostRunning, true);
  assert.equal(state.obsPending, false);
  assert.equal(calls.hostUi.at(-1).roomId, 'AABBCC112233');
  assert.equal(calls.hostUi.at(-1).viewerCount, 0);
  assert.equal(calls.leaves.length, 0);
  assert.deepEqual(calls.queueClears, ['host-session-expired']);
});

for (const change of ['stop', 'generation', 'media-session']) {
  test(`host recovery cancelled by ${change} during old-peer cleanup cannot recreate a room`, async () => {
    const cleanup = deferred();
    const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-token', pending: false }, () => cleanup.promise);
    const recovery = controller.handleErrorMessage({ code: 'session-not-found' });
    if (change === 'stop') {
      state.hostStopping = true;
      controller.cancelRoomRecovery('host-stopping');
    } else if (change === 'generation') {
      state.hostGeneration += 1;
    } else {
      state.mediaSessionId = 'new-media-session';
    }
    cleanup.resolve();
    await recovery;
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.hostUi.length, 0);
    assert.equal(calls.errors.length, 0);
    assert.equal(state.obsPending, false);
  });
}

test('stopping an already-requested recovery releases a late room-created acknowledgement', async () => {
  const harness = createHarness({ role: 'host', sessionToken: 'old-token', pending: false });
  await harness.controller.handleErrorMessage({ code: 'session-not-found' });
  assert.equal(harness.calls.creates.length, 1);
  harness.controller.cancelRoomRecovery('host-stopping');
  harness.state.hostStopping = true;
  await harness.controller.handleRoomCreatedMessage(ack({ roomId: 'AABBCC112233', sessionToken: 'late-host-token' }));
  assert.equal(harness.state.roomId, null);
  assert.equal(harness.calls.hostUi.length, 0);
  assert.equal(harness.calls.leaves.length, 1);
  assert.equal(harness.calls.leaves[0].roomId, 'AABBCC112233');
  assert.equal(harness.calls.leaves[0].sessionToken, 'late-host-token');
  assert.equal(harness.calls.leaves[0].sendOptions.queueIfDisconnected, false);
  assert.deepEqual(harness.calls.queueClears, ['host-session-expired', 'host-stopping']);
});

test('a recovery room acknowledgement cannot revive a superseded host generation', async () => {
  const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-token', pending: false });
  await controller.handleErrorMessage({ code: 'session-not-found' });
  state.hostGeneration += 1;
  await controller.handleRoomCreatedMessage(ack({ roomId: 'AABBCC112233', sessionToken: 'late-token' }));
  assert.equal(state.roomId, null);
  assert.equal(calls.hostUi.length, 0);
  assert.equal(calls.leaves[0].sessionToken, 'late-token');
});

test('OBS recovery retains the active ingest and does not create a room while its source is inactive', async () => {
  for (const active of [true, false]) {
    const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-token', pending: false,
      obsBackend: true, obsActive: active });
    await controller.handleErrorMessage({ code: 'session-not-found' });
    assert.equal(state.obsActive, active);
    assert.equal(state.hostRunning, true);
    assert.equal(calls.creates.length, active ? 1 : 0);
    assert.equal(state.obsPending, active);
    if (!active) assert.equal(calls.hostStatus.at(-1).text, '等待 OBS 推流...');
  }
});

test('missing host manifest fails visibly without restarting or stopping the capture', async () => {
  const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-token', pending: false, mediaManifest: null });
  await controller.handleErrorMessage({ code: 'session-not-found' });
  assert.equal(calls.creates.length, 0);
  assert.equal(state.roomId, null);
  assert.equal(state.hostRunning, true);
  assert.equal(state.obsPending, false);
  assert.match(calls.errors[0], /重新开始/);
});

test('stale room acknowledgements cannot unlock a pending OBS recovery', async () => {
  const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-token', pending: false,
    obsBackend: true, obsActive: true });
  await controller.handleErrorMessage({ code: 'session-not-found' });
  await controller.handleRoomCreatedMessage(ack({ roomId: 'STALE', mediaManifest: { mediaSessionId: 'old-media' } }));
  assert.equal(state.roomId, null);
  assert.equal(state.obsPending, true);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.leaves.length, 1);
  await controller.handleRoomCreatedMessage(ack({ roomId: 'AABBCC112233', sessionToken: 'new-token' }));
  assert.equal(state.roomId, 'AABBCC112233');
  assert.equal(state.obsPending, false);
});

test('recovery creation errors clear pending retries and leave a persistent failure state', async () => {
  const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'old-token', pending: false });
  await controller.handleErrorMessage({ code: 'session-not-found' });
  await controller.handleErrorMessage({ code: 'room-limit-reached', message: 'Server room limit reached' });
  assert.equal(state.hostRunning, true);
  assert.equal(state.roomId, null);
  assert.equal(state.obsPending, false);
  assert.equal(calls.creates.length, 1);
  assert.deepEqual(calls.queueClears, ['host-session-expired', 'host-room-create-failed']);
  assert.match(calls.hostStatus.at(-1).text, /恢复失败/);
  assert.equal(calls.errors.at(-1), 'Server room limit reached');
});

for (const code of ['session-not-found', 'room-not-found', 'session-token-invalid']) {
  test(`viewer ${code} clears the expired session and asks for an explicit new join`, async () => {
    const { controller, state, calls } = createHarness({ sessionToken: 'old-viewer-token', pending: false });
    await controller.handleErrorMessage({ code });
    assert.equal(state.role, null);
    assert.equal(state.roomId, null);
    assert.equal(state.sessionToken, null);
    assert.equal(calls.viewerReset, 1);
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.timerClears, 2);
    assert.deepEqual(calls.queueClears, ['viewer-session-expired']);
    assert.match(calls.viewerStatus[0], /重新加入/);
    assert.match(calls.errors[0], /新的房间号/);
    await controller.handleErrorMessage({ code });
    assert.equal(calls.viewerReset, 1, 'expired sessions must not retry or reset indefinitely');
  });
}

test('viewer recovery cleanup cannot overwrite a newly selected room', async () => {
  const cleanup = deferred();
  const { controller, state, calls } = createHarness({ sessionToken: 'old-token', pending: false }, () => cleanup.promise);
  const reset = controller.handleErrorMessage({ code: 'session-not-found' });
  Object.assign(state, { role: 'viewer', roomId: 'NEWROOM', generation: state.generation + 1, pending: true });
  cleanup.resolve();
  await reset;
  assert.equal(state.roomId, 'NEWROOM');
  assert.equal(calls.viewerStatus.length, 0);
  assert.equal(calls.errors.length, 0);
});

test('late host resume acknowledgements cannot restore a stopped, replaced or recovering room', async () => {
  for (const change of ['stop', 'room', 'token', 'media-session', 'recovery']) {
    const { controller, state, calls } = createHarness({ role: 'host', sessionToken: 'host-token', pending: false });
    if (change === 'stop') state.hostStopping = true;
    if (change === 'room') state.roomId = 'NEWROOM';
    if (change === 'token') state.sessionToken = 'new-token';
    if (change === 'media-session') state.mediaSessionId = 'new-media-session';
    if (change === 'recovery') await controller.handleErrorMessage({ code: 'session-not-found' });
    const expectedRoomId = state.roomId;
    const expectedToken = state.sessionToken;
    await controller.handleSessionResumedMessage(ack({ role: 'host', sessionToken: 'host-token' }));
    assert.equal(state.roomId, expectedRoomId, change);
    assert.equal(state.sessionToken, expectedToken, change);
    assert.equal(calls.hostUi.length, 0, change);
    assert.equal(calls.patches.filter(entry => entry.reason === 'session-resumed').length, 0, change);
  }
});
