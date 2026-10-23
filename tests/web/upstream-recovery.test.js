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
  const code = ts.transpileModule(fs.readFileSync(process.env.VDS_UPSTREAM_RECOVERY_TEST_SOURCE || path.join(root, 'vds_web/src/upstream-recovery.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const context = { exports: {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  vm.runInNewContext(code, context);
  return new context.exports.UpstreamRecovery();
}

function loadSignalingRecovery(clock, resume) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'vds_web/src/signaling-recovery.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const context = { exports: {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  vm.runInNewContext(code, context);
  return new context.exports.SignalingRecovery(resume);
}

test('signaling recovery serializes failures, waits for acknowledgement and cancels all retired work', async () => {
  const clock = fakeClock(); let calls = 0, finish;
  const recovery = loadSignalingRecovery(clock, async current => {
    calls++;
    if (calls === 1) throw new Error('offline');
    if (calls === 3) await new Promise(resolve => { finish = () => resolve(current()); });
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  recovery.start(); recovery.start(); await flush();
  assert.equal(calls, 1);
  clock.advance(249); await flush(); assert.equal(calls, 1);
  clock.advance(1); await flush(); assert.equal(calls, 2);
  clock.advance(10000); await flush(); assert.equal(calls, 2, 'socket open still needs an acknowledged session');
  clock.advance(500); await flush(); assert.equal(calls, 3);
  recovery.stop(); assert.equal(finish(), undefined); await flush();
  clock.advance(60000); assert.equal(calls, 3);
  assert.equal(clock.pendingCount(), 0);
});

function createSignalingResumeHarness(connect = async () => {}) {
  const clock = fakeClock(), calls = { sent: [], reset: 0, closes: 0, statuses: [], errors: [], restores: 0 };
  const peer = { connectionState: 'connected', close() { calls.closes++; this.connectionState = 'closed'; } };
  let flow;
  const recovery = loadSignalingRecovery(clock, current => flow.resumeSignalingSession(current));
  const upstream = loadRecovery(clock);
  flow = loadHandlers(['handleSignalingStatus', 'resumeSignalingSession', 'handleSignalingResumed',
    'hasUsableUpstreamMedia', 'retireUpstreamMedia', 'requestUpstreamRecovery', 'isCurrentUpstreamPeer', 'waitForUpstreamOffer'], `
    let session = { roomId: 'ABC234', clientId: 'web-client', sessionToken: 'token', hostId: 'host', upstreamPeerId: 'host', chainPosition: 0 };
    let upstreamPc = peer, upstreamMediaChannel = { readyState: 'open' }, viewerReadySent = true;
    let joinPending = false, restoringStoredSession = false, resumeNeedsMediaReconnect = false;
    let upstreamEdgeAttemptId = 1, lastVideoKeyframeForRelay = null, lastBootstrapFrameId = '', upstreamRecoveryAttempts = 0;
    const pendingIceCandidates = new Map();
    function resetLocalViewerSession() { signalingRecovery.stop(); retireUpstreamMedia(); session = null; }
    function leaveCurrentRoom() { resetLocalViewerSession(); }
  `, `{
    handleSignalingStatus, resumeSignalingSession, handleSignalingResumed,
    mediaFailed: () => requestUpstreamRecovery(upstreamPc, 'host', 'datachannel-closed'),
    leave: resetLocalViewerSession, snapshot: () => ({ session, upstreamPc, viewerReadySent })
  }`, {
    peer, clientId: 'web-client', signalingRecovery: recovery, upstreamRecovery: upstream,
    signaling: { connect, send: message => calls.sent.push(message) },
    playback: { resetMedia() { calls.reset++; } },
    setStatus: status => calls.statuses.push(status), setError: error => calls.errors.push(error), clearError() {},
    restoreWatchingStatusAfterRelay: () => calls.restores++, diagnostics: { update() {} },
    sessionStorage: { setItem() {} }, chainPositionText: {}, formatChainPosition: String,
    getManifestCompatibilityFailure: () => null, errorToMessage: error => error.message
  });
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const ack = () => flow.handleSignalingResumed({ type: 'session-resumed', roomId: 'ABC234', role: 'viewer',
    hostId: 'host', upstreamPeerId: 'host', chainPosition: 0 });
  return { ...flow, calls, clock, peer, recovery, flush, ack };
}

test('signaling-only outage resumes the same room without closing live media', async () => {
  const h = createSignalingResumeHarness();
  h.handleSignalingStatus('closed'); await h.flush();
  assert.equal(h.calls.sent[0].type, 'resume-session');
  assert.equal(h.calls.sent[0].needsMediaReconnect, false);
  assert.equal(h.calls.reset, 0); assert.equal(h.calls.closes, 0);
  h.ack();
  assert.equal(h.snapshot().upstreamPc, h.peer);
  assert.equal(h.snapshot().session.sessionToken, 'token');
  assert.equal(h.calls.restores, 1);
  assert.equal(h.clock.pendingCount(), 0);
});

test('production signaling close callback retains an authenticated live session', () => {
  const filename = process.env.VDS_SIGNALING_MAIN_TEST_SOURCE || path.join(root, 'vds_web/src/main.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const registration = source.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'signaling.onStatus');
  assert.ok(registration);
  const handler = registration.expression.arguments[0];
  const declaration = ts.isIdentifier(handler) ? source.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === handler.text).getText(source) : '';
  const script = ts.transpileModule(`${declaration}\nconst callback = ${handler.getText(source)}; callback('closed');`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const calls = { resets: 0, recoveries: 0 };
  vm.runInNewContext(script, { session: { roomId: 'ABC234', sessionToken: 'token' }, joinPending: false,
    restoringStoredSession: false, setStatus() {}, setError() {},
    resetLocalViewerSession: () => calls.resets++,
    signalingRecovery: { disconnected: () => calls.recoveries++ } });
  assert.equal(calls.resets, 0, 'control-plane loss must not destroy working media');
  assert.equal(calls.recoveries, 1);
});

test('a replacement signaling socket dying before ack retries promptly without parallel resume work', async () => {
  const h = createSignalingResumeHarness();
  h.handleSignalingStatus('closed'); await h.flush();
  h.handleSignalingStatus('closed'); await h.flush();
  assert.equal(h.calls.sent.length, 1);
  h.clock.advance(250); await h.flush();
  assert.equal(h.calls.sent.length, 2);
  h.ack(); h.clock.advance(30000); await h.flush();
  assert.equal(h.calls.sent.length, 2);
  assert.equal(h.calls.closes, 0);
  assert.equal(h.clock.pendingCount(), 0);
});

test('media failing while signaling reconnects is deferred until the resumed socket is bound', async () => {
  let connected;
  const h = createSignalingResumeHarness(() => new Promise(resolve => { connected = resolve; }));
  h.handleSignalingStatus('closed'); h.mediaFailed();
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.snapshot().session.roomId, 'ABC234');
  connected(); await h.flush();
  assert.equal(h.calls.sent[0].needsMediaReconnect, true);
  h.ack();
  assert.equal(h.calls.sent.length, 1, 'resume already asks the server to restart media');
  assert.equal(h.clock.pendingCount(), 1, 'replacement offer has a media readiness deadline');
});

test('media loss between resume request and acknowledgement requests one fresh offer', async () => {
  const h = createSignalingResumeHarness();
  h.handleSignalingStatus('closed'); await h.flush(); h.mediaFailed(); h.ack();
  assert.deepEqual(h.calls.sent.map(m => m.type), ['resume-session', 'viewer-reconnect-ready']);
  assert.equal(h.snapshot().session.roomId, 'ABC234');
});

test('leaving during signaling reconnection cannot send a late resume or arm another retry', async () => {
  let connected;
  const h = createSignalingResumeHarness(() => new Promise(resolve => { connected = resolve; }));
  h.handleSignalingStatus('closed'); h.leave(); connected(); await h.flush();
  h.clock.advance(60000); await h.flush();
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(h.snapshot().session, null);
});

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

function createJoinHarness(initialSession = null, options = {}) {
  const clock = fakeClock();
  const calls = { audio: 0, connect: 0, sent: [], errors: [], updates: [], stored: [] };
  const element = () => ({ disabled: false, textContent: '', value: '', classList: { add() {}, remove() {} } });
  const flow = loadHandlers(['joinRoom', 'handleJoined', 'setJoinPending', 'startJoinAckTimer', 'clearJoinAckTimer', 'unlockAudioFromUserGesture'], `
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
    navigator: { userActivation: { isActive: options.userActivation !== false } },
    window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    playback: { resumeAudio: () => { calls.audio++; return options.resumeAudio?.() || Promise.resolve(); } },
    signaling: { connect: async () => { calls.connect++; }, send: (message) => calls.sent.push(message), close() {} },
    setError: (message) => calls.errors.push(message), setStatus() {},
    diagnostics: { update: (value) => calls.updates.push(value) },
    errorToMessage: (error) => error.message,
    getWebEncodedMediaCapabilities: () => ({}), getManifestCompatibilityFailure: () => null,
    upstreamRecovery: { start() {} }, requestUpstreamRecovery() {}, waitForUpstreamOffer() {},
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

test('repeated disconnect notifications and buffered playback cannot postpone recovery', () => {
  const clock = fakeClock(), recovery = loadRecovery(clock), reasons = [];
  recovery.start(reason => reasons.push(reason));
  recovery.mediaReady();
  recovery.stateChanged('disconnected', 'ice');
  for (let i = 0; i < 3; i++) {
    clock.advance(999);
    recovery.stateChanged('disconnected', 'ice');
    recovery.mediaReady();
  }
  clock.advance(3);
  assert.deepEqual(reasons, ['upstream-disconnected']);
});

test('healthy ICE cannot mask a disconnected aggregate transport or a closed data channel', () => {
  const clock = fakeClock(), recovery = loadRecovery(clock), reasons = [];
  recovery.start(reason => reasons.push(reason));
  recovery.mediaReady();
  recovery.stateChanged('disconnected', 'connection');
  clock.advance(2000);
  recovery.stateChanged('completed', 'ice');
  clock.advance(1000);
  assert.deepEqual(reasons, ['upstream-disconnected']);
  recovery.start(reason => reasons.push(reason));
  recovery.stateChanged('closed', 'datachannel');
  recovery.stateChanged('connected', 'connection');
  recovery.stateChanged('connected', 'ice');
  recovery.mediaReady();
  clock.advance(0);
  assert.deepEqual(reasons, ['upstream-disconnected', 'upstream-closed']);
});

test('duplicate connected notifications cannot keep a peer without media alive indefinitely', () => {
  const clock = fakeClock(), recovery = loadRecovery(clock), reasons = [];
  recovery.start(reason => reasons.push(reason));
  recovery.stateChanged('connected', 'ice');
  clock.advance(20000);
  recovery.stateChanged('connected', 'connection');
  clock.advance(10000);
  assert.deepEqual(reasons, ['upstream-media-handshake-timeout']);
});

test('both layers recover during grace without rebuilding a healthy peer', () => {
  const clock = fakeClock(), recovery = loadRecovery(clock), reasons = [];
  recovery.start(reason => reasons.push(reason));
  recovery.mediaReady();
  recovery.stateChanged('disconnected', 'connection');
  recovery.stateChanged('disconnected', 'ice');
  clock.advance(2000);
  recovery.stateChanged('connected', 'ice');
  assert.equal(clock.pendingCount(), 1);
  recovery.stateChanged('connected', 'connection');
  clock.advance(30000);
  assert.deepEqual(reasons, []);
  assert.equal(clock.pendingCount(), 0);
});

test('an established path still checking is not healed by an unrelated healthy layer', () => {
  const clock = fakeClock(), recovery = loadRecovery(clock), reasons = [];
  recovery.start(reason => reasons.push(reason)); recovery.mediaReady();
  recovery.stateChanged('disconnected', 'ice');
  clock.advance(1000);
  recovery.stateChanged('checking', 'ice');
  recovery.stateChanged('connected', 'connection');
  recovery.mediaReady();
  clock.advance(2000);
  assert.deepEqual(reasons, ['upstream-disconnected']);
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

test('production join sends signaling while a gesture unlock remains indefinitely suspended', async () => {
  let resume;
  const audioWait = new Promise((resolve) => { resume = resolve; });
  const h = createJoinHarness(null, { resumeAudio: () => audioWait });
  const joined = h.joinRoom('ABC234');
  const completed = await Promise.race([joined.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
  assert.equal(completed, true, 'AudioContext.resume must not hold signaling hostage');
  assert.equal(h.calls.audio, 1);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.sent[0].type, 'join-room');
  h.handleJoined({ type: 'room-joined', roomId: 'ABC234' });
  assert.equal(h.snapshot().session.roomId, 'ABC234');
  resume();
  await joined;
});

test('automatic session restoration does not create or resume audio outside a user gesture', async () => {
  const h = createJoinHarness({ roomId: 'ABC234', sessionToken: 'saved-token' }, { userActivation: false });
  await h.joinRoom('ABC234');
  assert.equal(h.calls.audio, 0);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.sent[0].type, 'join-room');
  assert.equal(h.calls.sent[0].sessionToken, 'saved-token');
  h.handleJoined({ type: 'session-resumed', roomId: 'ABC234' });
  assert.equal(h.clock.pendingCount(), 0);
});

function createRecoveryHarness() {
  const clock = fakeClock();
  const recovery = loadRecovery(clock);
  const calls = { sent: [], errors: [], statuses: [], closes: 0, resets: 0 };
  const flow = loadHandlers(['waitForUpstreamOffer', 'requestUpstreamRecovery', 'isCurrentUpstreamPeer', 'retireUpstreamMedia'], `
    let session = { roomId: 'ABC234', hostId: 'host-peer', upstreamPeerId: 'host-peer', chainPosition: 0 };
    let upstreamPc = null, upstreamMediaChannel = null, upstreamRecoveryAttempts = 0;
    let upstreamEdgeAttemptId = 1, viewerReadySent = false, lastVideoKeyframeForRelay = null, lastBootstrapFrameId = '';
    const pendingIceCandidates = new Map();
    function leaveCurrentRoom() { session = null; upstreamRecovery.stop(); calls.closes += 1; }
  `, `{
    waitForUpstreamOffer, requestUpstreamRecovery,
    attach: (pc) => { upstreamPc = pc; },
    replaceSession: () => { session = { ...session, upstreamPeerId: 'replacement' }; },
    snapshot: () => ({ session, upstreamPc, upstreamRecoveryAttempts })
  }`, {
    calls, clientId: 'web-client', upstreamRecovery: recovery, signalingRecovery: { active: false },
    signaling: { send: (message) => calls.sent.push(message) },
    playback: { resetMedia: () => { calls.resets += 1; } },
    diagnostics: { update() {} }, setStatus: (status) => calls.statuses.push(status),
    setError: (error) => calls.errors.push(error), errorToMessage: (error) => error.message
  });
  return { ...flow, calls, clock, recovery };
}

test('production upstream recovery keeps waiting for a replacement offer and releases a failed session for manual join', () => {
  const h = createRecoveryHarness();
  h.waitForUpstreamOffer();
  h.clock.advance(30000);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].type, 'viewer-reconnect-ready');
  assert.equal(h.clock.pendingCount(), 1, 'a missing replacement offer must retain a recovery deadline');
  h.clock.advance(60000);
  assert.equal(h.calls.sent.length, 3);
  assert.equal(h.calls.errors.length, 0);
  h.clock.advance(30000);
  assert.equal(h.calls.closes, 1);
  assert.equal(h.snapshot().session, null, 'the rejoin instruction must leave the UI able to rejoin');
  assert.equal(h.clock.pendingCount(), 0);
  assert.deepEqual(h.calls.errors, ['上游连接恢复失败，请重新加入房间。']);
});

test('a stale offer wait cannot retire a new session or an already created peer', () => {
  const h = createRecoveryHarness();
  h.waitForUpstreamOffer();
  h.replaceSession();
  h.clock.advance(30000);
  assert.equal(h.calls.sent.length, 0);
  h.waitForUpstreamOffer();
  const peer = {};
  h.attach(peer);
  h.clock.advance(30000);
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.snapshot().upstreamPc, peer);
});

test('an SDP answer is still connecting; only active video playback reports watching', async () => {
  const calls = { statuses: [], sent: [], state: 'waiting-media' };
  const pc = {
    localDescription: null,
    async setRemoteDescription() {}, async createAnswer() { return { type: 'answer', sdp: 'answer' }; },
    async setLocalDescription(answer) { this.localDescription = answer; }
  };
  const flow = loadHandlers(['handleOffer', 'handlePlaybackState', 'restoreWatchingStatusAfterRelay'], `
    const session = { roomId: 'ABC234', upstreamPeerId: 'host-peer' }, upstreamPc = pc;
    let upstreamEdgeAttemptId = 1, downstreamDataChannelReady = false, downstreamRelayForwarding = false;
  `, `{ handleOffer, handlePlaybackState, restoreWatchingStatusAfterRelay,
    relay: (value) => { downstreamDataChannelReady = value; } }`, {
    pc, diagnostics: {
      update: (value) => { if (value.playbackState) calls.state = value.playbackState; },
      getSnapshot: () => ({ playbackState: calls.state, encodedFramesReceived: 500, webDecodedVideoFrames: 400 })
    },
    ensureUpstreamPeer: () => pc, normalizeDescription: () => ({ type: 'offer', sdp: 'offer' }),
    isEncodedDataChannelOffer: () => true, getManifestCompatibilityFailure: () => null,
    getSignalAttemptId: () => 1, flushPendingIceCandidates: async () => {},
    signaling: { send: (message) => calls.sent.push(message) },
    setStatus: (status) => calls.statuses.push(status), clearError() {}, setError() {}, markRelayUnsupported() {},
    upstreamRecovery: { mediaReady() {} },
    waitingMessage: { classList: { remove() {} } }
  });
  await flow.handleOffer({ type: 'offer', fromClientId: 'host-peer' });
  assert.equal(calls.sent[0].type, 'answer');
  assert.deepEqual(calls.statuses, ['连接上游中']);
  flow.restoreWatchingStatusAfterRelay();
  assert.equal(calls.statuses.at(-1), '等待上游', 'historical decoded counters cannot mark a replacement peer as watching');
  flow.handlePlaybackState('decoding');
  assert.equal(calls.statuses.at(-1), '解码中');
  flow.handlePlaybackState('playing');
  assert.equal(calls.statuses.at(-1), '观看中');
  flow.relay(true);
  const count = calls.statuses.length;
  flow.handlePlaybackState('playing');
  assert.equal(calls.statuses.length, count, 'local playback must preserve an active relay status');
});

test('suspended audio is a nonfatal hint and clears when browser audio is running', () => {
  const snapshot = { status: '观看中', playbackState: 'playing' };
  const statusText = { textContent: '' }, statusBadge = { textContent: '' };
  const titles = [];
  const flow = loadHandlers(['handleAudioOutputState', 'setStatus'], `
    const session = { roomId: 'ABC234' }; let audioOutputState = '';
  `, `{ handleAudioOutputState }`, {
    statusText, statusBadge, diagnostics: { update: (partial) => Object.assign(snapshot, partial), getSnapshot: () => snapshot },
    muteButton: { setAttribute: (name, value) => titles.push([name, value]) }, playerVolumeInput: { value: '100' }
  });
  flow.handleAudioOutputState('suspended');
  assert.equal(snapshot.status, '观看中');
  assert.equal(snapshot.playbackState, 'playing');
  assert.equal(snapshot.lastError, undefined);
  assert.match(statusText.textContent, /点击画面开启声音/);
  flow.handleAudioOutputState('running');
  assert.equal(statusText.textContent, '观看中');
  assert.deepEqual(titles.at(-1), ['title', '静音']);
});

test('production console diagnostics redact session tokens including nested signal data', () => {
  const format = loadHandler('toConsoleJson', '', {});
  const source = { sessionToken: 'private-token', nested: { sessionToken: 'another-private-token' }, roomId: 'ABC234' };
  const output = format(source);
  assert.doesNotMatch(output, /private-token/);
  assert.equal(JSON.parse(output).sessionToken, '[redacted]');
  assert.equal(source.sessionToken, 'private-token', 'redaction must not damage a live session credential');
});

test('retired inbound channel cannot feed media or fail its replacement on the same peer', () => {
  const calls = { frames: [], states: [], errors: [], sent: [] };
  const flow = loadHandlers(['attachInboundDataChannel'], `
    const upstreamPc = {}; let upstreamMediaChannel = null;
  `, `{ attachInboundDataChannel, current: () => upstreamMediaChannel }`, {
    ENCODED_MEDIA_CHANNEL_LABEL: 'vds-encoded-media', ENCODED_MEDIA_PROTOCOL: 'vds-media-encoded-v1',
    ENCODED_MEDIA_PROTOCOL_VERSION: 1, isCurrentUpstreamPeer: () => true,
    diagnostics: { update() {} }, parseControlMessage: JSON.parse, getControlManifestFailure: () => null,
    getCurrentManifest: () => ({}), helloAckMessage: () => ({ type: 'hello-ack' }), maybeSendViewerReady() {},
    handleInboundEncodedFrame: frame => calls.frames.push(frame),
    markRelayUnsupported: error => calls.errors.push(error),
    upstreamRecovery: { stateChanged: state => calls.states.push(state) }
  });
  const channel = () => ({ label: 'vds-encoded-media', send: value => calls.sent.push(value) });
  const old = channel(), current = channel();
  flow.attachInboundDataChannel(old, 'host');
  flow.attachInboundDataChannel(current, 'host');
  old.onmessage({ data: new ArrayBuffer(1) });
  old.onmessage({ data: JSON.stringify({ type: 'hello', protocolVersion: 1 }) });
  old.onerror(); old.onclose();
  assert.deepEqual(calls, { frames: [], states: [], errors: [], sent: [] });
  assert.equal(flow.current(), current);
  const frame = new ArrayBuffer(2); current.onmessage({ data: frame });
  assert.equal(calls.frames[0], frame);
  current.onerror(); current.onclose();
  assert.deepEqual(calls.states, ['failed', 'closed']);
  assert.equal(flow.current(), null);
});

test('production hello with no presented video keeps first-frame recovery active', () => {
  const clock = fakeClock();
  const recovery = loadRecovery(clock);
  const reasons = [], sent = [];
  const pc = {};
  const channel = { label: 'vds-encoded-media', send: (value) => sent.push(JSON.parse(value)) };
  const handlers = loadHandlers(['attachInboundDataChannel', 'handlePlaybackState'], `
    const session = { roomId: 'ABC234' }, upstreamPc = pc;
    let upstreamMediaChannel = null, downstreamDataChannelReady = false, downstreamRelayForwarding = false;
  `, `{ attachInboundDataChannel, handlePlaybackState }`, {
    pc, ENCODED_MEDIA_CHANNEL_LABEL: channel.label, ENCODED_MEDIA_PROTOCOL: 'vds-media-encoded-v1',
    ENCODED_MEDIA_PROTOCOL_VERSION: 1, upstreamRecovery: recovery,
    parseControlMessage: JSON.parse, getControlManifestFailure: () => null,
    getCurrentManifest: () => ({}), helloAckMessage: () => ({ type: 'hello-ack' }),
    isCurrentUpstreamPeer: () => true, maybeSendViewerReady() {},
    handleInboundEncodedFrame() {}, diagnostics: { update() {} }, setStatus() {}, markRelayUnsupported() {},
    waitingMessage: { classList: { remove() {} } }
  });
  const hello = () => channel.onmessage({ data: JSON.stringify({ type: 'hello', protocolVersion: 1 }) });
  recovery.start((reason) => reasons.push(reason));
  recovery.stateChanged('connected');
  handlers.attachInboundDataChannel(channel, 'host-peer');
  hello();
  assert.equal(sent[0].type, 'hello-ack');
  assert.equal(clock.pendingCount(), 1);
  clock.advance(30000);
  assert.deepEqual(reasons, ['upstream-media-handshake-timeout']);

  recovery.start((reason) => reasons.push(reason));
  recovery.stateChanged('connected');
  hello();
  handlers.handlePlaybackState('decoding');
  channel.onmessage({ data: new ArrayBuffer(4) });
  assert.equal(clock.pendingCount(), 1, 'encoded input and decoder startup do not prove video presentation');
  handlers.handlePlaybackState('playing');
  assert.equal(clock.pendingCount(), 0);
  clock.advance(24 * 60 * 60 * 1000);
  assert.equal(reasons.length, 1, 'normal connected playback has no total-duration timer');
});
