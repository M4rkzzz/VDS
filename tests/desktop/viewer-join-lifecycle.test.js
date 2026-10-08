const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../server/public/app.js'), 'utf8');

// Exercise the existing viewer flow with its DOM and native IPC boundaries replaced.
function readFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `missing renderer function: ${name}`);
  const rest = source.slice(start);
  const end = rest.search(/^}/m);
  assert.notEqual(end, -1, `missing renderer function end: ${name}`);
  return rest.slice(0, end + 1);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness() {
  const timers = new Map();
  const prefs = [];
  const calls = { joins: [], leaves: [], errors: [], patches: [], cleanup: 0 };
  let timerId = 0;
  const element = () => ({ classList: { add() {}, remove() {} }, dataset: {}, textContent: '', value: '' });
  const context = {
    window: {
      isElectron: true,
      electronAPI: { mediaEngine: { setViewerAudioDelay: () => { const request = deferred(); prefs.push(request); return request.promise; } } },
      VDS: { roomClient: { joinRoomById: data => calls.joins.push(data), leaveRoom: data => calls.leaves.push(data) } }
    },
    elements: Object.fromEntries(['roomIdInput', 'joinForm', 'viewerStatus', 'btnLeave', 'remoteVideo', 'waitingMessage', 'connectionStatus', 'viewerP2pStatus', 'viewerReceiveFps', 'viewerRenderFps'].map(name => [name, element()])),
    clientId: 'viewer-test', viewerPlaybackPrefs: { audioDelayMs: 70 }, wsConnected: true,
    viewerJoinPending: false, viewerPendingJoinSource: null, viewerJoinPendingTimer: null,
    viewerJoinGeneration: 0, VIEWER_JOIN_PENDING_TIMEOUT_MS: 10000,
    currentRoomId: null, currentSessionToken: null, sessionRole: null,
    viewerAudioDelayApplyTimer: null, viewerAudioDelayApplySeq: 0,
    hostId: null, upstreamPeerId: null, myChainPosition: -1,
    viewerReadySent: false, videoStarted: false, upstreamConnected: false, relayPc: null, relayStream: null,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    showError: message => calls.errors.push(message), debugLog() {},
    syncAppState: (patch, metadata) => calls.patches.push({ patch, metadata }),
    updatePublicRoomsPollingState() {}, renderViewerPlaybackPrefsUi() {}, renderViewerJoinUi() {},
    removePendingMessages() {}, cancelPublicRoomsRefresh() {}, clearPendingSignalingQueues() {},
    clearAllPeerConnections: async () => { calls.cleanup += 1; },
    setViewerJoinMode() {}, refreshPublicRooms: async () => []
  };
  vm.createContext(context);
  const functions = ['applyNativeViewerPlaybackPrefs', 'setViewerJoinPending', 'cancelPendingViewerJoin', 'joinRoomById', 'leaveRoom', 'resetViewerState', 'handleViewerJoinFailure'];
  for (const name of functions) vm.runInContext(readFunction(name), context, { filename: `app.js:${name}` });
  const succeeded = source.match(/window\.__vdsHandleViewerJoinSucceeded = \(\) => \{[\s\S]*?^\};/m);
  assert.ok(succeeded, 'missing renderer join acknowledgement hook');
  vm.runInContext(succeeded[0], context);
  return {
    context, prefs, calls, timers,
    join: roomId => context.joinRoomById(roomId),
    cancel: () => context.cancelPendingViewerJoin(),
    leave: () => context.leaveRoom(),
    runJoinTimeout: async () => {
      const [id, timer] = Array.from(timers.entries()).find(([, value]) => value.delay === 10000);
      timers.delete(id);
      timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('cancelling while native playback preferences are pending prevents a late join', async () => {
  const { join, cancel, prefs, calls, context } = createHarness();
  const joining = join(' room1 ');
  cancel();
  prefs[0].resolve();
  await joining;
  assert.equal(calls.joins.length, 0);
  assert.equal(context.currentRoomId, null);
  assert.equal(context.sessionRole, null);
  assert.equal(context.viewerJoinPending, false);
});

test('leaving during native playback setup prevents a late room request', async () => {
  const { join, leave, prefs, calls, context } = createHarness();
  const joining = join('ROOM1');
  await leave();
  prefs[0].resolve();
  await joining;
  assert.equal(calls.joins.length, 0);
  assert.equal(calls.leaves.length, 0);
  assert.equal(calls.cleanup, 1);
  assert.equal(context.currentRoomId, null);
});

test('join timeout invalidates native playback setup before it completes', async () => {
  const harness = createHarness();
  const joining = harness.join('ROOM1');
  await harness.runJoinTimeout();
  harness.prefs[0].resolve();
  await joining;
  assert.equal(harness.calls.joins.length, 0);
  assert.equal(harness.context.viewerJoinPending, false);
  assert.equal(harness.context.sessionRole, null);
  assert.equal(harness.calls.errors.length, 1);
});

test('an obsolete join cannot overwrite or unlock a newer pending join', async () => {
  const { join, cancel, prefs, calls, context } = createHarness();
  const first = join('ROOM1');
  cancel();
  const second = join('ROOM2');
  prefs[0].resolve();
  await first;
  assert.equal(calls.joins.length, 0);
  assert.equal(context.viewerJoinPending, true);
  prefs[1].resolve();
  await second;
  assert.deepEqual(calls.joins.map(data => data.roomId), ['ROOM2']);
  assert.equal(context.currentRoomId, 'ROOM2');
});

test('normal join applies preferences, sends its normalized request, and acknowledges success', async () => {
  const { join, prefs, calls, context, timers, leave } = createHarness();
  const joining = join(' room1 ');
  assert.equal(calls.joins.length, 0);
  prefs[0].resolve();
  await joining;
  assert.equal(calls.joins.length, 1);
  assert.equal(calls.joins[0].roomId, 'ROOM1');
  assert.equal(calls.joins[0].clientId, 'viewer-test');
  assert.equal(calls.joins[0].viewerAudioDelayMs, 70);
  assert.equal(context.currentRoomId, 'ROOM1');
  assert.equal(context.sessionRole, 'viewer');
  context.window.__vdsHandleViewerJoinSucceeded();
  assert.equal(context.viewerJoinPending, false);
  assert.equal(timers.size, 0);
  context.currentSessionToken = 'session-token';
  await leave();
  assert.equal(calls.leaves.length, 1);
  assert.equal(calls.leaves[0].sessionToken, 'session-token');
  assert.equal(context.currentRoomId, null);
});

test('a current preference failure remains best effort and still joins normally', async () => {
  const { join, prefs, calls, context } = createHarness();
  const joining = join('ROOM1');
  prefs[0].reject(new Error('native preferences unavailable'));
  await joining;
  assert.equal(calls.joins.length, 1);
  assert.equal(context.sessionRole, 'viewer');
});

test('expired viewer cleanup cannot overwrite a newer join or its UI after awaiting old peers', async () => {
  const { context, join, prefs, calls } = createHarness();
  const cleanup = deferred();
  context.clearAllPeerConnections = () => cleanup.promise;
  const resetting = context.resetViewerState();
  const joining = join('NEWROOM');
  prefs[0].resolve();
  await joining;
  context.elements.connectionStatus.textContent = '新会话正在连接';
  cleanup.resolve();
  await resetting;
  assert.equal(context.currentRoomId, 'NEWROOM');
  assert.equal(context.sessionRole, 'viewer');
  assert.equal(context.viewerJoinPending, true);
  assert.equal(context.elements.connectionStatus.textContent, '新会话正在连接');
  assert.deepEqual(calls.joins.map(message => message.roomId), ['NEWROOM']);
});

test('expired viewer cleanup cannot reset the UI after the user starts hosting', async () => {
  const { context } = createHarness();
  const cleanup = deferred();
  context.clearAllPeerConnections = () => cleanup.promise;
  const resetting = context.resetViewerState();
  context.sessionRole = 'host';
  context.currentRoomId = 'HOSTROOM';
  context.elements.connectionStatus.textContent = '房主已就绪';
  cleanup.resolve();
  await resetting;
  assert.equal(context.currentRoomId, 'HOSTROOM');
  assert.equal(context.elements.connectionStatus.textContent, '房主已就绪');
});

test('a delayed join error cannot toast or rerender after a new join supersedes cleanup', async () => {
  const { context, join, prefs, calls } = createHarness();
  const cleanup = deferred();
  context.clearAllPeerConnections = () => cleanup.promise;
  const failing = context.handleViewerJoinFailure('旧房间不存在');
  const joining = join('NEWROOM');
  prefs[0].resolve();
  await joining;
  cleanup.resolve();
  await failing;
  assert.equal(context.currentRoomId, 'NEWROOM');
  assert.deepEqual(calls.errors, []);
});
