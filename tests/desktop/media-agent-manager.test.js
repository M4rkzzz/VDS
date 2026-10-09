const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');

const managerPath = path.resolve(__dirname, '../../desktop/media-agent-manager.js');
const managerSource = fs.readFileSync(managerPath, 'utf8');

function createHarness(options = {}) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.killCount = 0;
    child.requests = [];
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        child.requests.push(JSON.parse(String(chunk)));
        callback();
      }
    });
    child.kill = () => {
      child.killed = true;
      child.killCount += 1;
      return true;
    };
    child.reply = (request, result = {}) => {
      child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    };
    child.ready = (params = {}) => {
      child.stdout.write(JSON.stringify({ event: 'agent-ready', params }) + '\n');
    };
    child.exit = () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    };
    children.push(child);
    return child;
  };
  const module = { exports: {} };
  vm.runInNewContext(managerSource, {
    require(name) {
      if (name === 'child_process') {
        return { spawn };
      }
      if (name === 'fs') {
        return { existsSync: () => true };
      }
      return require(name);
    },
    module,
    __dirname: path.dirname(managerPath),
    process,
    console,
    setTimeout,
    clearTimeout
  }, { filename: managerPath });
  const manager = new module.exports.MediaAgentManager({
    logger: { log() {}, warn() {}, error() {} },
    defaultInvokeTimeoutMs: 1000,
    pingTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    ...options
  });
  return { manager, children };
}

async function startReady(harness) {
  const started = harness.manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  const child = harness.children.at(-1);
  child.ready();
  await Promise.resolve();
  child.reply(child.requests[0], { ok: true });
  await started;
  return child;
}

async function stopAndExit(manager, child) {
  const stopped = manager.stop();
  child.exit();
  await stopped;
}

test('concurrent starts wait for the same successful ping', async () => {
  const harness = createHarness();
  const firstStart = harness.manager.start();
  let secondStartCompleted = false;
  const secondStart = harness.manager.start().then((status) => {
    secondStartCompleted = true;
    return status;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondStartCompleted, false);
  assert.equal(harness.children.length, 1);
  const child = harness.children[0];
  child.ready();
  await Promise.resolve();
  child.reply(child.requests[0], { ok: true });
  const statuses = await Promise.all([firstStart, secondStart]);
  assert.ok(statuses.every((status) => status.running));
  await stopAndExit(harness.manager, child);
});

test('restart waits for an in-flight stop and duplicate stops share cleanup', async () => {
  const harness = createHarness();
  const firstChild = await startReady(harness);
  const firstStop = harness.manager.stop();
  const secondStop = harness.manager.stop();
  const restarted = harness.manager.start();
  await Promise.resolve();
  assert.equal(harness.children.length, 1);
  assert.equal(firstChild.killCount, 1);
  firstChild.exit();
  await Promise.all([firstStop, secondStop]);
  const secondChild = harness.children[1];
  assert.ok(secondChild);
  secondChild.ready();
  await Promise.resolve();
  secondChild.reply(secondChild.requests[0], { ok: true });
  assert.equal((await restarted).running, true);
  assert.equal(harness.manager.child, secondChild);
  await stopAndExit(harness.manager, secondChild);
});

test('late exit and stream errors after an RPC timeout cannot erase the replacement process', async () => {
  const harness = createHarness();
  const firstChild = await startReady(harness);
  const timedOut = harness.manager.invoke('getStats');
  await assert.rejects(timedOut, { code: 'MEDIA_AGENT_INVOKE_TIMEOUT' });
  assert.equal(firstChild.__vdsExpectedExitReason, 'invoke-timeout');
  firstChild.exit();
  await Promise.resolve();
  const secondChild = await startReady(harness);
  const request = harness.manager.invoke('getCapabilities');
  await Promise.resolve();
  firstChild.stderr.write('stale process error');
  firstChild.stdin.emit('error', new Error('late stdin error'));
  firstChild.emit('error', new Error('late child error'));
  firstChild.stdout.write(JSON.stringify({ event: 'agent-ready', params: { stale: true } }) + '\n');
  firstChild.exit();
  assert.equal(harness.manager.child, secondChild);
  assert.equal(harness.manager.getStatus().running, true);
  assert.equal(harness.manager.recentStderrLines.length, 0);
  secondChild.reply(secondChild.requests.at(-1), { current: true });
  assert.equal((await request).current, true);
  await stopAndExit(harness.manager, secondChild);
});

test('stopping during startup readiness allows a clean replacement startup', async () => {
  const harness = createHarness();
  const initialStart = harness.manager.start();
  const rejectedStart = assert.rejects(initialStart, /media-agent-stopped/);
  const firstChild = harness.children[0];
  const stopped = harness.manager.stop();
  const restarted = harness.manager.start();
  firstChild.exit();
  await stopped;
  await rejectedStart;
  const secondChild = harness.children[1];
  assert.ok(secondChild);
  secondChild.ready();
  await Promise.resolve();
  secondChild.reply(secondChild.requests[0], { ok: true });
  await restarted;
  assert.equal(secondChild.killCount, 0);
  assert.equal(harness.manager.child, secondChild);
  await stopAndExit(harness.manager, secondChild);
});

test('capabilities calls wait for readiness and ping before entering the RPC queue', async () => {
  const harness = createHarness();
  const started = harness.manager.start();
  const capabilities = harness.manager.invoke('getCapabilities');
  const child = harness.children[0];
  assert.equal(harness.manager.getStatus().state, 'starting');
  assert.equal(harness.manager.getStatus().running, false);
  assert.equal(child.requests.length, 0);
  child.ready({ implementation: 'fixture' });
  await Promise.resolve();
  assert.deepEqual(child.requests.map((request) => request.method), ['ping']);
  child.reply(child.requests[0], { ok: true });
  await started;
  await Promise.resolve();
  assert.deepEqual(child.requests.map((request) => request.method), ['ping', 'getCapabilities']);
  child.reply(child.requests[1], { ready: true });
  assert.equal((await capabilities).ready, true);
  await stopAndExit(harness.manager, child);
});

test('cold initialization time does not consume the RPC ping timeout', async () => {
  const harness = createHarness({ startupTimeoutMs: 3000 });
  const started = harness.manager.start();
  const child = harness.children[0];
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(child.killCount, 0);
  assert.equal(child.requests.length, 0);
  child.ready();
  await Promise.resolve();
  child.reply(child.requests[0], { ok: true });
  assert.equal((await started).running, true);
  await stopAndExit(harness.manager, child);
});

test('a startup timeout retains the native stage and waits for retirement before retry', async () => {
  const harness = createHarness();
  const initialStart = harness.manager.start();
  const child = harness.children[0];
  const capabilities = harness.manager.invoke('getCapabilities');
  child.stderr.write('[media-agent breadcrumb] runtime-probe:waiting-for-driver\n');
  const results = await Promise.allSettled([initialStart, capabilities]);
  assert.ok(results.every((result) => result.status === 'rejected' &&
    result.reason.code === 'MEDIA_AGENT_STARTUP_TIMEOUT' &&
    result.reason.message.includes('runtime-probe:waiting-for-driver')));
  assert.equal(harness.manager.getStatus().state, 'failed');
  assert.equal(harness.manager.getStatus().reason, 'startup-timeout');
  assert.equal(harness.manager.pendingRequests.size, 0);
  const restarted = harness.manager.start();
  await Promise.resolve();
  assert.equal(harness.children.length, 1);
  child.exit();
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = harness.children[1];
  assert.ok(replacement);
  replacement.ready();
  await Promise.resolve();
  replacement.reply(replacement.requests[0], { ok: true });
  assert.equal((await restarted).running, true);
  assert.equal(harness.manager.getStatus().lastError, null);
  await stopAndExit(harness.manager, replacement);
});

test('a broken startup input pipe cannot leave a live process that bypasses retry', async () => {
  const harness = createHarness();
  const started = harness.manager.start();
  const child = harness.children[0];
  const rejectedStart = assert.rejects(started, /fixture stdin failed/);
  child.stdin.emit('error', new Error('fixture stdin failed'));
  await rejectedStart;
  assert.equal(harness.manager.child, null);
  assert.equal(harness.manager.getStatus().reason, 'stdin-error');
  const restarted = harness.manager.start();
  child.exit();
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = harness.children[1];
  replacement.ready();
  await Promise.resolve();
  replacement.reply(replacement.requests[0], { ok: true });
  await restarted;
  await stopAndExit(harness.manager, replacement);
});

test('agent-ready alone cannot release queued work when the startup ping is unresponsive', async () => {
  const harness = createHarness();
  const started = harness.manager.start();
  const capabilities = harness.manager.invoke('getCapabilities');
  const child = harness.children[0];
  child.stderr.write('[media-agent breadcrumb] startup-ready\n');
  child.ready();
  await Promise.resolve();
  assert.equal(harness.manager.getStatus().running, false);
  assert.deepEqual(child.requests.map((request) => request.method), ['ping']);
  const results = await Promise.allSettled([started, capabilities]);
  assert.ok(results.every((result) => result.status === 'rejected' &&
    result.reason.code === 'MEDIA_AGENT_INVOKE_TIMEOUT' &&
    result.reason.message.includes('startup-ready')));
  assert.equal(harness.manager.getStatus().reason, 'invoke-timeout');
  assert.equal(child.killCount, 1);
  child.exit();
  await harness.manager.stop();
});

test('failed retirement blocks replacements until the old process actually exits', async () => {
  const harness = createHarness();
  const started = harness.manager.start();
  const child = harness.children[0];
  await assert.rejects(started, { code: 'MEDIA_AGENT_STARTUP_TIMEOUT' });
  await assert.rejects(harness.manager.stopPromise, { code: 'MEDIA_AGENT_STOP_TIMEOUT' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.manager.retiringChild, child);
  assert.equal(harness.manager.getStatus().reason, 'stop-failed');
  await assert.rejects(harness.manager.start(), { code: 'MEDIA_AGENT_STOP_TIMEOUT' });
  assert.equal(harness.children.length, 1);
  child.exit();
  const replacement = await startReady(harness);
  assert.notEqual(replacement, child);
  assert.equal(harness.manager.retiringChild, null);
  await stopAndExit(harness.manager, replacement);
});

test('a failed process kill does not report successful stop or allow an overlap', async () => {
  const harness = createHarness();
  const child = await startReady(harness);
  child.kill = () => { throw new Error('fixture termination denied'); };
  await assert.rejects(harness.manager.stop(), /fixture termination denied/);
  assert.equal(harness.manager.retiringChild, child);
  assert.equal(harness.manager.getStatus().running, false);
  await assert.rejects(harness.manager.start(), { code: 'MEDIA_AGENT_STOP_TIMEOUT' });
  assert.equal(harness.children.length, 1);
  child.exit();
  const replacement = await startReady(harness);
  await stopAndExit(harness.manager, replacement);
});

test('unexpected current-process exit rejects pending RPCs and allows recovery', async () => {
  const harness = createHarness();
  const firstChild = await startReady(harness);
  const request = harness.manager.invoke('getStats');
  const rejectedRequest = assert.rejects(request, /media-agent-exited/);
  await Promise.resolve();
  firstChild.exit();
  await rejectedRequest;
  assert.equal(harness.manager.pendingRequests.size, 0);
  const secondChild = await startReady(harness);
  assert.equal(harness.manager.getStatus().running, true);
  await stopAndExit(harness.manager, secondChild);
});
