const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');

const managerPath = path.resolve(__dirname, '../../desktop/media-agent-manager.js');
const managerSource = fs.readFileSync(managerPath, 'utf8');

function createHarness() {
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
    pingTimeoutMs: 1000
  });
  return { manager, children };
}

async function startReady(harness) {
  const started = harness.manager.start();
  const child = harness.children.at(-1);
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
  const secondChild = await startReady(harness);
  const request = harness.manager.invoke('getCapabilities');
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

test('stopping during the startup ping allows a clean replacement startup', async () => {
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
  secondChild.reply(secondChild.requests[0], { ok: true });
  await restarted;
  assert.equal(secondChild.killCount, 0);
  assert.equal(harness.manager.child, secondChild);
  await stopAndExit(harness.manager, secondChild);
});

test('unexpected current-process exit rejects pending RPCs and allows recovery', async () => {
  const harness = createHarness();
  const firstChild = await startReady(harness);
  const request = harness.manager.invoke('getStats');
  const rejectedRequest = assert.rejects(request, /media-agent-exited/);
  firstChild.exit();
  await rejectedRequest;
  assert.equal(harness.manager.pendingRequests.size, 0);
  const secondChild = await startReady(harness);
  assert.equal(harness.manager.getStatus().running, true);
  await stopAndExit(harness.manager, secondChild);
});
