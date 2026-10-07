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
  const filename = path.join(root, 'vds_web/src/main.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `missing production handler ${name}`);
  const code = ts.transpileModule(`${prelude}\n${declaration.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return new Function(...Object.keys(globals), `${code}\nreturn ${name};`)(...Object.values(globals));
}

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
