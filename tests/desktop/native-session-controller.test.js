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
    getNativeHostSessionRunning: () => state.running,
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

test('selecting a new capture after peer attach failure drains the old owner before a new session id', async () => {
  const order = [];
  let activeId = '';
  const h = createHarness({
    mediaEngine: {
      startHostSession: async (request) => {
        order.push(`start:${request.mediaSessionId}`);
        if (activeId && activeId !== request.mediaSessionId) throw new Error('MEDIA_SESSION_ACTIVE');
        activeId = request.mediaSessionId;
        return { running: true };
      },
      stopHostSession: async () => { order.push('stop'); activeId = ''; return { running: false }; }
    }
  });
  await h.controller.runNativeCaptureHostStart('window:first');
  // A viewer cannot attach the WGC source, but the host is still active.
  assert.equal(h.state.running, true);
  await h.controller.runNativeCaptureHostStart('window:second');
  assert.equal(order.length, 3);
  assert.equal(order[1], 'stop');
  assert.notEqual(order[0], order[2]);
  assert.equal(h.state.running, true);
});

test('a partially allocated native start is stopped when its RPC rejects, so a new owner can start', async () => {
  let allocated = false, fail = true, stops = 0;
  const h = createHarness({
    mediaEngine: {
      startHostSession: async () => {
        if (allocated) throw new Error('MEDIA_SESSION_ACTIVE');
        allocated = true;
        if (fail) throw new Error('wgc-source-create-failed');
        return { running: true };
      },
      stopHostSession: async () => { allocated = false; stops++; return { running: false }; }
    }
  });
  await assert.rejects(h.controller.runNativeCaptureHostStart('window:bad'), /wgc-source-create-failed/);
  assert.equal(allocated, false);
  assert.equal(stops, 1);
  fail = false;
  assert.equal((await h.controller.runNativeCaptureHostStart('window:good')).started, true);
});

test('a failed stop blocks replacement without allocating a different native owner', async () => {
  let starts = 0;
  const h = createHarness({ mediaEngine: {
    startHostSession: async () => { starts++; return { running: true }; },
    stopHostSession: async () => { throw new Error('native-stop-failed'); }
  } });
  await h.controller.runNativeCaptureHostStart('window:first');
  const id = h.state.mediaSessionId;
  await assert.rejects(h.controller.runNativeCaptureHostStart('window:second'), /native-stop-failed/);
  assert.equal(starts, 1);
  assert.equal(h.state.mediaSessionId, id);
  assert.equal(h.state.running, true);
});

test('stopping OBS during initialization prevents a late host RPC', async () => {
  const ui = deferred();
  const h = createHarness({ ensureNativeUiReady: () => ui.promise });
  const first = h.controller.runObsIngestHostStart();
  const rejected = assert.rejects(first, /native-host-start-superseded/);
  await h.controller.runStopShare();
  ui.resolve();
  await rejected;
  assert.equal(h.calls.starts, 0);
  assert.equal(h.state.running, false);
});

test('a partial OBS start failure frees its native owner and UI before a retry', async () => {
  let allocated = false, fail = true, stops = 0;
  const h = createHarness({ mediaEngine: {
    startHostSession: async () => {
      if (allocated) throw new Error('MEDIA_SESSION_ACTIVE');
      allocated = true;
      if (fail) throw new Error('obs-listen-failed');
      return { running: true, backend: 'obs-ingest', obsIngest: { prepared: true, waiting: true } };
    },
    stopHostSession: async () => { allocated = false; stops++; return { running: false }; }
  } });
  await assert.rejects(h.controller.runObsIngestHostStart(), /obs-listen-failed/);
  assert.equal(allocated, false);
  assert.equal(h.state.running, false);
  assert.equal(h.state.inFlight, false);
  assert.equal(stops, 1);
  fail = false;
  assert.equal((await h.controller.runObsIngestHostStart()).started, true);
});

test('a delayed obsolete OBS failure cannot stop or reset a newer capture start', async () => {
  const entered = deferred(), old = deferred(), newUi = deferred();
  let calls = 0, uiCalls = 0, stops = 0;
  const h = createHarness({
    ensureNativeUiReady: () => ++uiCalls === 1 ? undefined : newUi.promise,
    mediaEngine: {
      startHostSession: async () => { if (++calls === 1) { entered.resolve(); return old.promise; } return { running: true }; },
      stopHostSession: async () => { stops++; return { running: false }; }
    }
  });
  const first = h.controller.runObsIngestHostStart();
  const rejected = assert.rejects(first, /native-host-start-superseded/);
  await entered.promise;
  await h.controller.runStopShare();
  const second = h.controller.runNativeCaptureHostStart('window:new');
  old.reject(new Error('old-obs-failure'));
  await rejected;
  assert.equal(h.state.inFlight, true);
  assert.equal(h.state.running, true);
  assert.equal(stops, 1);
  assert.equal(h.calls.failedCleanup, 0);
  newUi.resolve();
  assert.equal((await second).started, true);
});

test('a delayed audio failure stays bound to its old media owner and cannot warn over a new share', async () => {
  const entered = deferred(), audio = deferred();
  const warnings = [], requests = [];
  const h = createHarness({
    showError: (message) => warnings.push(message),
    mediaEngine: {
      startHostSession: async () => ({ running: true }),
      stopHostSession: async () => ({ running: false }),
      startAudioSession: async (request) => { requests.push(request); entered.resolve(); return audio.promise; }
    }
  });
  const first = h.controller.runNativeCaptureHostStartWithAudio('window:old', 123);
  await entered.promise;
  const oldId = h.state.mediaSessionId;
  await h.controller.runStopShare();
  await h.controller.runNativeCaptureHostStart('window:new');
  audio.reject(new Error('old-audio-failure'));
  assert.equal((await first).started, false);
  assert.equal(requests[0].mediaSessionId, oldId);
  assert.notEqual(h.state.mediaSessionId, oldId);
  assert.equal(h.state.running, true);
  assert.deepEqual(warnings, []);
});

for (const backend of ['native', 'obs-ingest']) {
  test(`a failed ${backend} rollback retains ownership until the next attempt drains it`, async () => {
    let allocated = '', failStart = true, failStop = true;
    const order = [];
    const h = createHarness({ mediaEngine: {
      startHostSession: async (request) => {
        if (allocated) throw new Error('MEDIA_SESSION_ACTIVE');
        allocated = request.mediaSessionId;
        order.push('start');
        if (failStart) throw new Error('partial-start-failed');
        return { running: true, backend, obsIngest: { prepared: true, waiting: true } };
      },
      stopHostSession: async () => {
        order.push('stop');
        if (failStop) throw new Error('rollback-stop-failed');
        allocated = '';
        return { running: false };
      }
    } });
    const start = () => backend === 'native'
      ? h.controller.runNativeCaptureHostStart('window:owned')
      : h.controller.runObsIngestHostStart();
    await assert.rejects(start(), /rollback-stop-failed/);
    const oldId = h.state.mediaSessionId;
    assert.equal(h.state.running, true);
    assert.equal(h.state.inFlight, false);
    assert.equal(h.calls.failedCleanup, 0);
    failStart = false;
    failStop = false;
    assert.equal((await start()).started, true);
    assert.notEqual(h.state.mediaSessionId, oldId);
    assert.deepEqual(order, ['start', 'stop', 'stop', 'start']);
  });
}
