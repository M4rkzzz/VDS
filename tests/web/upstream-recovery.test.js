const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, ms) { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pendingCount() { return timers.size; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    }
  };
}

function loadRecovery(clock) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'vds_web/src/upstream-recovery.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const context = { exports: {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  vm.runInNewContext(code, context);
  return new context.exports.UpstreamRecovery();
}

function loadHandler(name, prelude, globals) {
  return loadHandlers([name], prelude, name, globals);
}

function loadHandlers(names, prelude, returned, globals) {
  const filename = path.join(root, 'vds_web/src/main.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declarations = names.map((name) => {
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `missing production handler ${name}`);
    return declaration.getText(source);
  });
  const code = ts.transpileModule(`${prelude}\n${declarations.join('\n')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return new Function(...Object.keys(globals), `${code}\nreturn ${returned};`)(...Object.values(globals));
}

function createJoinHarness(initialSession = null) {
  const clock = fakeClock();
  const calls = { audio: 0, connect: 0, sent: [], errors: [], updates: [], stored: [] };
  const element = () => ({ disabled: false, textContent: '', value: '', classList: { add() {}, remove() {} } });
  const flow = loadHandlers(['joinRoom', 'handleJoined', 'setJoinPending', 'startJoinAckTimer', 'clearJoinAckTimer'], `
    const capabilityDetectionComplete = true, capability = { ok: true, maxDirectDownstreams: 0 };
    let session = initialSession, restoringStoredSession = Boolean(initialSession);
    let joinPending = false, pendingJoinRoomId = '', joinAttemptSeq = 0, joinAckTimer = null;
    let viewerReadySent = false, upstreamRecoveryAttempts = 0;
    const refreshRoomsInFlight = false;
  `, `{
    joinRoom, handleJoined,
    snapshot: () => ({ session, joinPending, pendingJoinRoomId, restoringStoredSession })
  }`, {
    initialSession, clientId: 'web-client',
    window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    playback: { resumeAudio: async () => { calls.audio++; } },
    signaling: { connect: async () => { calls.connect++; }, send: (message) => calls.sent.push(message), close() {} },
    setError: (message) => calls.errors.push(message), setStatus() {},
    diagnostics: { update: (value) => calls.updates.push(value) },
    errorToMessage: (error) => error.message,
    getWebEncodedMediaCapabilities: () => ({}), getManifestCompatibilityFailure: () => null,
    upstreamRecovery: { start() {} }, requestUpstreamRecovery() {},
    sessionStorage: { setItem: (key, value) => calls.stored.push({ key, value: JSON.parse(value) }) },
    formatChainPosition: (position) => String(position),
    joinButton: element(), roomIdInput: element(), refreshRoomsButton: element(),
    lobbyTabButton: element(), directTabButton: element(), roomList: { querySelectorAll: () => [] },
    joinCard: element(), leaveButton: element(), viewerRoomId: element(), chainPositionText: element()
  });
  return { ...flow, calls, clock };
}

test('production Web join sends trimmed uppercase input and waits for the same room acknowledgement', async () => {
  const h = createJoinHarness();
  await h.joinRoom(' \tabc234\n ');
  assert.equal(h.calls.audio, 1);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].roomId, 'ABC234');
  assert.equal(h.snapshot().pendingJoinRoomId, 'ABC234');
  assert.equal(h.clock.pendingCount(), 1);

  h.handleJoined({ type: 'room-joined', roomId: 'ABC235' });
  assert.equal(h.snapshot().joinPending, true);
  assert.equal(h.snapshot().session, null);
  assert.equal(h.clock.pendingCount(), 1);

  h.handleJoined({ type: 'room-joined', roomId: 'ABC234', sessionToken: 'new-token' });
  assert.equal(h.snapshot().joinPending, false);
  assert.equal(h.snapshot().session.roomId, 'ABC234');
  assert.equal(h.calls.stored[0].value.roomId, 'ABC234');
  assert.equal(h.clock.pendingCount(), 0);
  assert.deepEqual(h.calls.errors, []);
});

test('production Web restore compares its session against the normalized room code before sending the token', async () => {
  const h = createJoinHarness({ roomId: 'ABC234', sessionToken: 'saved-token' });
  await h.joinRoom('  abc234  ');
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].roomId, 'ABC234');
  assert.equal(h.calls.sent[0].sessionToken, 'saved-token');
  assert.equal(h.snapshot().pendingJoinRoomId, 'ABC234');
  h.handleJoined({ type: 'session-resumed', roomId: 'ABC234', sessionToken: 'saved-token' });
  assert.equal(h.snapshot().restoringStoredSession, false);
  assert.equal(h.snapshot().joinPending, false);
  assert.equal(h.clock.pendingCount(), 0);
  assert.deepEqual(h.calls.errors, []);
});

test('production Web join rejects whitespace through the empty-input path without starting a join', async () => {
  const h = createJoinHarness();
  await h.joinRoom(' \r\n\t ');
  assert.deepEqual(h.calls.errors, ['请输入房间码。']);
  assert.equal(h.calls.audio, 0);
  assert.equal(h.calls.connect, 0);
  assert.deepEqual(h.calls.sent, []);
  assert.equal(h.snapshot().joinPending, false);
  assert.equal(h.snapshot().pendingJoinRoomId, '');
  assert.equal(h.clock.pendingCount(), 0);
  await h.joinRoom('abc234');
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].roomId, 'ABC234');
});

test('upstream failure in the production peer handler reaches recovery while stale/downstream failures do not', () => {
  const current = { connectionState: 'failed', iceConnectionState: 'failed' };
  const downstream = { connectionState: 'failed', iceConnectionState: 'failed' };
  const stale = { connectionState: 'failed', iceConnectionState: 'failed' };
  const states = [];
  const wire = loadHandler('wirePeerEvents', 'const session = { roomId: "room" }; const upstreamPc = current; const downstreamPc = downstream;', {
    current, downstream,
    diagnostics: { updateIce() {}, incrementCandidate() {} },
    upstreamRecovery: { stateChanged: (state) => states.push(state) },
    signaling: { send() {} }
  });
  wire(current, 'host'); wire(downstream, 'viewer'); wire(stale, 'old-host');
  stale.onconnectionstatechange();
  downstream.onconnectionstatechange();
  assert.deepEqual(states, []);
  current.onconnectionstatechange();
  current.oniceconnectionstatechange();
  assert.deepEqual(states, ['failed', 'failed']);
});

test('a short disconnect preserves playback; a sustained disconnect requests recovery once', () => {
  const clock = fakeClock();
  const recovery = loadRecovery(clock);
  const reasons = [];
  recovery.start((reason) => reasons.push(reason));
  recovery.mediaReady();
  recovery.stateChanged('disconnected');
  clock.advance(2999);
  assert.deepEqual(reasons, []);
  recovery.stateChanged('connected');
  clock.advance(3000);
  assert.deepEqual(reasons, []);
  recovery.stateChanged('disconnected');
  clock.advance(3000);
  assert.deepEqual(reasons, ['upstream-disconnected']);
  recovery.stateChanged('failed');
  clock.advance(20000);
  assert.equal(reasons.length, 1);
});

test('failed/closed peers recover immediately and stop/replacement cancels obsolete recovery', () => {
  const clock = fakeClock();
  const recovery = loadRecovery(clock);
  const reasons = [];
  recovery.start((reason) => reasons.push(`old:${reason}`));
  recovery.stateChanged('failed');
  recovery.start((reason) => reasons.push(`new:${reason}`));
  clock.advance(0);
  assert.deepEqual(reasons, []);
  recovery.stateChanged('closed');
  clock.advance(0);
  assert.deepEqual(reasons, ['new:upstream-closed']);
  recovery.start((reason) => reasons.push(reason));
  recovery.stateChanged('disconnected');
  recovery.stop();
  clock.advance(30000);
  assert.equal(reasons.length, 1);
});

test('connected ICE without a media handshake still times out; a ready channel stays usable', () => {
  const clock = fakeClock();
  const recovery = loadRecovery(clock);
  const reasons = [];
  recovery.start((reason) => reasons.push(reason));
  recovery.stateChanged('connected');
  clock.advance(29999);
  assert.deepEqual(reasons, []);
  clock.advance(1);
  assert.deepEqual(reasons, ['upstream-media-handshake-timeout']);
  recovery.start((reason) => reasons.push(reason));
  recovery.mediaReady();
  clock.advance(30000);
  assert.equal(reasons.length, 1);
});
