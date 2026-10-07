const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

const filename = path.resolve(__dirname, '../../vds_web/src/main.ts');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
const names = ['handleIceCandidate', 'queuePendingIceCandidate', 'flushPendingIceCandidates', 'getCandidateIceUfrag',
  'isCandidateForRemoteDescription', 'isCurrentIceCandidatePeer', 'isCurrentUpstreamPeer', 'getSignalAttemptId'];
const functions = names.map((name) => {
  const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `missing production function ${name}`);
  return node.getText(source);
}).join('\n');
const compiled = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

const description = (ufrag) => ({ type: 'offer', sdp: `v=0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:fixture-password-123456789\r\n` });
const candidate = (ufrag = '', predicted = false, port = 45001) => ({
  candidate: `candidate:fixture 1 udp 100 127.0.0.2 ${port} typ srflx${ufrag ? ` ufrag ${ufrag}` : ''}${predicted ? ' vds-predicted 1' : ''}`,
  sdpMid: 'media'
});
function peer(ufrag, apply = async () => {}) {
  const calls = [];
  return { remoteDescription: ufrag ? description(ufrag) : null,
    calls, addIceCandidate: async (value) => { calls.push(value); await apply(value); } };
}
function harness(pc = null) {
  const updates = [];
  const context = { session: { upstreamPeerId: 'host' }, upstreamPc: pc, downstreamPc: null,
    downstreamPeerId: '', upstreamEdgeAttemptId: null, downstreamEdgeAttemptId: null,
    pendingIceCandidates: new Map(), diagnostics: { update: (value) => updates.push(value), incrementCandidate() {} },
    errorToMessage: (error) => String(error) };
  vm.runInNewContext(compiled, context);
  return { context, updates, receive: (value, attemptId, fromClientId = 'host') =>
    context.handleIceCandidate({ candidate: value, attemptId, fromClientId }) };
}

test('Web candidates arriving before the offer preserve their original ICE attempt and ufrag', async () => {
  const h = harness();
  await h.receive(candidate('old-ufrag', true), 9);
  await h.receive(candidate('current-ufrag', true), 10);
  const current = peer('current-ufrag');
  h.context.upstreamPc = current;
  h.context.upstreamEdgeAttemptId = 10;
  await h.context.flushPendingIceCandidates('host', current);
  assert.equal(current.calls.length, 1);
  assert.equal(current.calls[0].candidate, candidate('current-ufrag', true).candidate);
});

test('a queued predicted candidate from stale SDP credentials is ignored even when attempt ids match', async () => {
  const current = peer();
  const h = harness(current);
  h.context.upstreamEdgeAttemptId = 10;
  await h.receive(candidate('old-ufrag', true), 10);
  current.remoteDescription = description('current-ufrag');
  await h.context.flushPendingIceCandidates('host', current);
  assert.equal(current.calls.length, 0);
});

test('Web predictions require matching credentials while ordinary legacy candidates remain compatible', async () => {
  const current = peer('current-ufrag');
  const h = harness(current);
  h.context.upstreamEdgeAttemptId = 10;
  for (const invalid of [candidate('', true), candidate('old-ufrag', true),
    { ...candidate('current-ufrag', true), usernameFragment: 'different-ufrag' },
    { ...candidate('current-ufrag', true), candidate: `${candidate('current-ufrag', true).candidate} ufrag conflicting-ufrag` }]) {
    await h.receive(invalid, 10);
  }
  assert.equal(current.calls.length, 0);
  await h.receive(candidate('current-ufrag', true), 10);
  await h.receive(candidate(), undefined);
  assert.equal(current.calls.length, 2);
});

test('a pending candidate owned by a retired browser peer cannot be flushed into a replacement', async () => {
  const retired = peer();
  const h = harness(retired);
  await h.receive(candidate('same-ufrag', true), 10);
  const current = peer('same-ufrag');
  h.context.upstreamPc = current;
  h.context.upstreamEdgeAttemptId = 10;
  await h.context.flushPendingIceCandidates('host', current);
  assert.equal(current.calls.length, 0);
});

test('replacement during an asynchronous Web candidate flush stops remaining candidates and stale diagnostics', async () => {
  let finish;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const old = peer('', async () => { entered(); await pending; throw new Error('retired peer'); });
  const h = harness(old);
  h.context.upstreamEdgeAttemptId = 10;
  await h.receive(candidate('current-ufrag', true), 10);
  await h.receive(candidate('current-ufrag', true, 45002), 10);
  old.remoteDescription = description('current-ufrag');
  const flush = h.context.flushPendingIceCandidates('host', old);
  await started;
  h.context.upstreamPc = peer('next-ufrag');
  h.context.upstreamEdgeAttemptId = 11;
  finish();
  await flush;
  assert.equal(old.calls.length, 1);
  assert.equal(h.context.upstreamPc.calls.length, 0);
  assert.equal(h.updates.length, 0);
});

test('downstream candidates match their own credentials and unrelated peer candidates are discarded', async () => {
  const upstream = peer('host-ufrag');
  const downstream = peer('viewer-ufrag');
  const h = harness(upstream);
  h.context.downstreamPc = downstream;
  h.context.downstreamPeerId = 'viewer';
  h.context.downstreamEdgeAttemptId = 20;
  await h.receive(candidate('host-ufrag', true), 20, 'viewer');
  await h.receive(candidate('viewer-ufrag', true), 20, 'viewer');
  await h.receive(candidate('host-ufrag', true), 10, 'unrelated');
  assert.equal(downstream.calls.length, 1);
  assert.equal(upstream.calls.length, 0);
});
