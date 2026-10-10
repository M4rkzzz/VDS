const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function controller(mediaEngine) {
  const context = { window: { VDS: {} } };
  const filename = path.resolve(__dirname, '../../server/public/native/native-media-engine-controller.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.window.VDS.nativeMediaEngine.createController({ mediaEngine });
}

test('failed native startup can be retried without reloading the renderer', async () => {
  let starts = 0;
  const c = controller({ start: async () => {
    if (++starts === 1) throw new Error('media-agent-startup-timeout');
    return { available: true, running: true };
  } });
  await assert.rejects(c.ensureStarted(), /startup-timeout/);
  assert.equal(c.isStarted(), false);
  assert.equal((await c.ensureStarted()).running, true);
  assert.equal(starts, 2);
});

test('concurrent renderer callers wait for capabilities rather than seeing partial readiness', async () => {
  const capabilities = deferred();
  const entered = deferred();
  let starts = 0;
  let queries = 0;
  const c = controller({
    start: async () => { starts += 1; return { available: true, running: true }; },
    getCapabilities: () => { queries += 1; entered.resolve(); return capabilities.promise; }
  });
  const first = c.ensureStarted();
  await entered.promise;
  let secondDone = false;
  const second = c.ensureStarted().then(value => { secondDone = true; return value; });
  await Promise.resolve();
  assert.equal(c.isStarted(), false);
  assert.equal(secondDone, false);
  assert.equal(starts, 1);
  assert.equal(queries, 1);
  capabilities.resolve({ ready: true });
  await Promise.all([first, second]);
  assert.equal(c.isStarted(), true);
});

test('a failed capabilities query does not cache a successful native initialization', async () => {
  let queries = 0;
  const c = controller({
    start: async () => ({ available: true, running: true }),
    getCapabilities: async () => {
      if (++queries === 1) throw new Error('capabilities-failed');
      return {};
    }
  });
  await assert.rejects(c.ensureStarted(), /capabilities-failed/);
  assert.equal(c.isStarted(), false);
  await c.ensureStarted();
  assert.equal(c.isStarted(), true);
  assert.equal(queries, 2);
});

test('agent exit invalidates renderer readiness and allows a new start', async () => {
  let starts = 0;
  const c = controller({ start: async () => { starts += 1; return { available: true, running: true }; } });
  await c.ensureStarted();
  c.handleStatus({ state: 'stopped', running: false });
  assert.equal(c.isStarted(), false);
  await c.ensureStarted();
  assert.equal(starts, 2);
});

test('exit during capability discovery cannot restore obsolete readiness', async () => {
  const capabilities = deferred();
  const entered = deferred();
  const c = controller({
    start: async () => ({ available: true, running: true }),
    getCapabilities: () => { entered.resolve(); return capabilities.promise; }
  });
  const start = c.ensureStarted();
  const rejected = assert.rejects(start, /start-superseded/);
  await entered.promise;
  c.handleStatus({ state: 'stopped', running: false });
  capabilities.resolve({});
  await rejected;
  assert.equal(c.isStarted(), false);
});

test('the starting status does not invalidate the current startup', async () => {
  const pending = deferred();
  const c = controller({ start: () => pending.promise });
  const start = c.ensureStarted();
  c.handleStatus({ state: 'starting', running: false });
  pending.resolve({ available: true, running: true });
  await start;
  assert.equal(c.isStarted(), true);
});

test('late initial idle snapshot does not invalidate startup or capability discovery', async () => {
  const pending = deferred();
  const capabilities = deferred();
  const entered = deferred();
  const c = controller({
    start: () => pending.promise,
    getCapabilities: () => { entered.resolve(); return capabilities.promise; }
  });
  const start = c.ensureStarted();
  assert.equal(c.handleStatus({ state: 'idle', running: false, reason: 'ready-to-start' }), false);
  pending.resolve({ available: true, running: true });
  await entered.promise;
  assert.equal(c.handleStatus({ state: 'idle', running: false, reason: 'not-started' }), false);
  capabilities.resolve({ ready: true });
  assert.equal((await start).running, true);
  assert.equal(c.isStarted(), true);
});

test('explicit stop during startup still supersedes late readiness', async () => {
  const pending = deferred();
  const c = controller({ start: () => pending.promise });
  const start = c.ensureStarted();
  const rejected = assert.rejects(start, /start-superseded/);
  assert.equal(c.handleStatus({ state: 'idle', running: false, reason: 'stopped' }), true);
  pending.resolve({ available: true, running: true });
  await rejected;
  assert.equal(c.isStarted(), false);
});

test('installed native overrides retry startup without rebinding UI or caching the failed bootstrap', async () => {
  const bootstrapFailed = deferred();
  let starts = 0;
  let bindings = 0;
  let sessionOptions;
  const noop = () => {};
  const component = new Proxy({}, { get: () => noop });
  const mediaEngine = {
    start: async () => {
      if (++starts === 1) throw new Error('fixture-cold-start-failure');
      return { available: true, running: true };
    },
    getCapabilities: async () => ({ ready: true })
  };
  const context = {
    window: { isElectron: true, VDS: {}, electronAPI: { mediaEngine } },
    document: { getElementById: () => null },
    elements: {},
    showError: noop,
    console: { error: () => bootstrapFailed.resolve() }
  };
  const publicRoot = path.resolve(__dirname, '../../server/public');
  vm.runInNewContext(fs.readFileSync(path.join(publicRoot, 'native/native-media-engine-controller.js'), 'utf8'), context);
  context.window.VDS.roomClient = { registerMessageHandler: noop };
  context.window.VDS.nativeEntry = {
    setRuntimeFlags: noop,
    installLegacyOverrides: install => install({ installManagedByEntry: true }),
    createRequired: (name, method, _reason, options) => {
      if (name === 'nativeMediaEngine') return context.window.VDS.nativeMediaEngine.createController(options);
      if (name === 'nativeDiagnostics') return new Proxy({ bindMediaEngineEvents: () => { bindings += 1; } }, {
        get: (target, key) => target[key] || noop
      });
      if (name === 'nativeSession' && method === 'createController') sessionOptions = options;
      return component;
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(publicRoot, 'app-native-overrides.js'), 'utf8'), context);
  await bootstrapFailed.promise;
  assert.equal(starts, 1);
  assert.equal(bindings, 1);
  await sessionOptions.ensureNativeUiReady();
  assert.equal(starts, 2);
  assert.equal(bindings, 1);
});
