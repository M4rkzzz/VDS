const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const publicPath = path.resolve(__dirname, '../../server/public');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const context = { window: { VDS: {} } };
  for (const file of ['room-client.js', 'native/native-session-controller.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(publicPath, file), 'utf8'), context, { filename: file });
  }
  const state = { generation: 0, inFlight: false, stopping: false, running: false, mediaSessionId: 'media-test', room: null };
  const calls = { starts: 0, stops: 0, failedCleanup: 0, rooms: [], leaves: [], waitingResets: 0 };
  let nativeRunning = false;
  const controller = context.window.VDS.nativeSession.createController({
    mediaEngine: {
      startHostSession: async () => { calls.starts += 1; nativeRunning = true; return { running: true }; },
      stopHostSession: async () => { calls.stops += 1; nativeRunning = false; return { running: false }; }
    },
    getHostStartGeneration: () => state.generation,
    setHostStartGeneration: (value) => { state.generation = value; },
    setHostStartInFlight: (value) => { state.inFlight = value; },
    getStopShareInFlight: () => state.stopping,
    setStopShareInFlight: (value) => { state.stopping = value; },
    setNativeHostSessionRunning: (value) => { state.running = value; },
    getMediaSessionId: () => state.mediaSessionId,
    setMediaSessionId: (value) => { state.mediaSessionId = value; },
    shouldRequestHostPreview: () => true,
    resetFailedHostStartUi: () => { calls.failedCleanup += 1; },
    getRoomSnapshot: () => state.room,
    patchRendererState: () => { state.room = null; },
    resetObsRoomUiWaitingForStream: () => { calls.waitingResets += 1; },
    sendHostCreateRoom: async (message) => { calls.rooms.push(message); return true; },
    sendLeaveRoom: (request) => {
      calls.leaves.push(context.window.VDS.roomClient.buildLeaveRoomMessage(request));
      return true;
    },
    ...overrides
  });
  return { controller, state, calls, isNativeRunning: () => nativeRunning };
}

test('a cancelled preview start cannot stop or retry over a restarted host', async () => {
  const entered = deferred();
  const preview = deferred();
  const harness = createHarness({ attachHostPreviewSurface: () => { entered.resolve(); return preview.promise; } });
  const first = harness.controller.runNativeCaptureHostStart('screen:1', { nativeHostPreviewEnabled: true });
  const cancelled = assert.rejects(first, /native-host-start-superseded/);
  await entered.promise;
  await harness.controller.runStopShare();
  assert.equal((await harness.controller.runNativeCaptureHostStart('screen:2')).started, true);
  preview.resolve({ ok: true });
  await cancelled;
  assert.equal(harness.isNativeRunning(), true);
  assert.equal(harness.state.running, true);
  assert.equal(harness.calls.starts, 2);
  assert.equal(harness.calls.stops, 1);
  assert.equal(harness.calls.failedCleanup, 0);
  assert.equal(harness.calls.rooms.length, 1);
});

test('an obsolete failure leaves a newer start in flight', async () => {
  const entered = deferred();
  const preview = deferred();
  const newUi = deferred();
  let uiCalls = 0;
  const harness = createHarness({
    ensureNativeUiReady: () => ++uiCalls === 1 ? undefined : newUi.promise,
    attachHostPreviewSurface: () => { entered.resolve(); return preview.promise; }
  });
  const first = harness.controller.runNativeCaptureHostStart('screen:1', { nativeHostPreviewEnabled: true });
  const cancelled = assert.rejects(first, /native-host-start-superseded/);
  await entered.promise;
  await harness.controller.runStopShare();
  const second = harness.controller.runNativeCaptureHostStart('screen:2');
  preview.reject(new Error('preview failed'));
  await cancelled;
  assert.equal(harness.state.inFlight, true);
  assert.equal(harness.state.running, true);
  assert.equal(harness.calls.failedCleanup, 0);
  assert.equal(harness.calls.stops, 1);
  newUi.resolve();
  assert.equal((await second).started, true);
});

test('stopping during initialization prevents a late capture RPC', async () => {
  const ui = deferred();
  const harness = createHarness({ ensureNativeUiReady: () => ui.promise });
  const started = harness.controller.runNativeCaptureHostStart('screen:1', { nativeHostPreviewEnabled: true });
  const cancelled = assert.rejects(started, /native-host-start-superseded/);
  await harness.controller.runStopShare();
  ui.resolve();
  await cancelled;
  assert.equal(harness.calls.starts, 0);
  assert.equal(harness.calls.stops, 1);
  assert.equal(harness.state.running, false);
});

test('a late room acknowledgement cannot complete a stopped start', async () => {
  const roomSent = deferred();
  const ack = deferred();
  const harness = createHarness({
    sendHostCreateRoom: () => { roomSent.resolve(); return true; },
    waitForHostRoomCreated: () => ack.promise
  });
  const started = harness.controller.runNativeCaptureHostStart('screen:1');
  const cancelled = assert.rejects(started, /native-host-start-superseded/);
  await roomSent.promise;
  await harness.controller.runStopShare();
  ack.resolve({ roomId: 'ROOM1' });
  await cancelled;
  assert.equal(harness.calls.stops, 1);
  assert.equal(harness.state.running, false);
});

test('stopping while signaling reconnects prevents a late room create', async () => {
  const entered = deferred();
  const connection = deferred();
  const harness = createHarness({
    waitForWsConnected: () => { entered.resolve(); return connection.promise; }
  });
  const started = harness.controller.runNativeCaptureHostStart('screen:1');
  const cancelled = assert.rejects(started, /native-host-start-superseded/);
  await entered.promise;
  await harness.controller.runStopShare();
  connection.resolve();
  await cancelled;
  assert.equal(harness.calls.rooms.length, 0);
  assert.equal(harness.calls.stops, 1);
  assert.equal(harness.state.running, false);
});

test('a current preview failure still retries without preview', async () => {
  const harness = createHarness({ attachHostPreviewSurface: async () => { throw new Error('preview unavailable'); } });
  assert.equal((await harness.controller.runNativeCaptureHostStart('screen:1', { nativeHostPreviewEnabled: true })).started, true);
  assert.equal(harness.calls.starts, 2);
  assert.equal(harness.calls.stops, 1);
  assert.equal(harness.calls.rooms.length, 1);
  assert.equal(harness.isNativeRunning(), true);
});

test('OBS teardown uses the room snapshot and keeps the listening media session', async () => {
  const harness = createHarness();
  harness.state.room = { role: 'host', roomId: 'ROOM1', clientId: 'HOST1', sessionToken: 'TOKEN1' };
  await harness.controller.teardownObsHostRoom({ reason: 'obs-ingest-ended' });
  const leave = harness.calls.leaves[0];
  assert.equal(leave.roomId, 'ROOM1');
  assert.equal(leave.clientId, 'HOST1');
  assert.equal(leave.sessionToken, 'TOKEN1');
  assert.equal(harness.state.room, null);
  assert.equal(harness.state.mediaSessionId, 'media-test');
  assert.equal(harness.calls.waitingResets, 1);
  await harness.controller.ensureObsHostRoomCreated({ videoCodec: 'h264' }, { clientId: 'HOST1' });
  assert.equal(harness.calls.rooms[0].mediaManifest.mediaSessionId, 'media-test');
});

test('OBS teardown skips leave before a room exists and clears local state on send failure', async () => {
  const harness = createHarness();
  await harness.controller.teardownObsHostRoom({ reason: 'obs-ingest-ended' });
  assert.equal(harness.calls.leaves.length, 0);
  assert.equal(harness.state.mediaSessionId, 'media-test');

  const failing = createHarness({ sendLeaveRoom: () => { throw new Error('socket closed'); } });
  failing.state.room = { role: 'host', roomId: 'ROOM1', clientId: 'HOST1', sessionToken: 'TOKEN1' };
  await assert.rejects(failing.controller.teardownObsHostRoom(), /socket closed/);
  assert.equal(failing.state.room, null);
  assert.equal(failing.state.mediaSessionId, 'media-test');
  assert.equal(failing.calls.waitingResets, 1);
});
