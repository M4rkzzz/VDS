const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const controllerPath = path.resolve(__dirname, '../../server/public/native/native-surface-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const hostSurfaceId = 'embedded-host-preview';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(hooks = {}) {
  const attached = new Map();
  const calls = { attach: [], detach: [], update: [] };
  const rect = { left: 10, top: 20, right: 650, bottom: 380, width: 640, height: 360 };
  const element = { id: 'video-container', getBoundingClientRect: () => rect, classList: { contains: () => false } };
  const preview = { nativeHostPreviewEnabled: true, nativeHostSessionRunning: true, hostPreviewRequested: true, attached: false };
  let timerId = 0;
  const timers = new Map();
  const context = {
    window: {
      VDS: {}, innerWidth: 1920, innerHeight: 1080, screenX: 0, screenY: 0,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: (id) => timers.delete(id),
      requestAnimationFrame: (callback) => { timers.set(++timerId, callback); return timerId; }
    }
  };
  vm.runInNewContext(controllerSource, context, { filename: controllerPath });
  const mediaEngine = {
    attachSurface: async (request) => {
      calls.attach.push(request);
      if (hooks.attach) await hooks.attach(request, calls.attach.length);
      attached.set(request.surface, request.target);
      return { surface: request.surface, target: request.target };
    },
    detachSurface: async (request) => {
      calls.detach.push(request);
      if (hooks.detach) await hooks.detach(request, calls.detach.length);
      attached.delete(request.surface);
      return { detached: true };
    },
    updateSurface: async (request) => {
      calls.update.push(request);
      if (hooks.update) await hooks.update(request, calls.update.length);
      if (!attached.has(request.surface)) throw new Error('Surface is not attached');
      return { updated: true };
    }
  };
  const controller = context.window.VDS.nativeSurface.createController({
    mediaEngine, hostPreviewElement: element, remoteVideoContainer: element,
    getHostPreviewState: () => preview,
    isHostPreviewAttached: () => preview.attached,
    setHostPreviewAttached: (value) => { preview.attached = value; },
    onSurfaceTrackingRemoved: (id) => { if (id === hostSurfaceId) preview.attached = false; },
    maxConsecutiveSyncFailures: 1
  });
  return { controller, attached, calls, element, rect, preview };
}

test('normal attach, layout updates and failure recovery keep the surface usable', async () => {
  let failUpdate = false;
  const harness = createHarness({ update: () => { if (failUpdate) throw new Error('temporary update failure'); } });
  const { controller, element, rect, calls, attached } = harness;
  assert.ok(await controller.attachSurface('viewer', 'peer-video:one', element));
  assert.equal(controller.getSurfaceCount(), 1);
  rect.left += 10;
  rect.right += 10;
  assert.equal((await controller.updateSurface('viewer')).updated, true);
  assert.equal(calls.update[0].x, 20);
  assert.equal(await controller.updateSurface('viewer'), null);
  rect.left += 10;
  rect.right += 10;
  failUpdate = true;
  await controller.syncAllSurfaces();
  assert.equal(calls.detach.length, 1);
  assert.equal(calls.attach.length, 2);
  assert.equal(controller.getSurfaceCount(), 1);
  assert.equal(attached.get('viewer'), 'peer-video:one');
});

test('detaching a preview cancels its pending first attach', async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ attach: () => { entered.resolve(); return gate.promise; } });
  const attached = harness.controller.attachHostPreviewSurface();
  await entered.promise;
  harness.preview.nativeHostSessionRunning = false;
  const detached = harness.controller.detachHostPreviewSurface();
  gate.resolve();
  assert.equal(await attached, null);
  await detached;
  assert.equal(harness.preview.attached, false);
  assert.equal(harness.controller.getSurfaceCount(), 0);
  assert.equal(harness.attached.size, 0);
});

test('an old attach cannot detach a replacement using the same surface ID', async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ attach: (_request, count) => { if (count === 1) { entered.resolve(); return gate.promise; } } });
  const oldAttach = harness.controller.attachSurface('viewer', 'peer-video:old', harness.element);
  await entered.promise;
  const replacement = harness.controller.attachSurface('viewer', 'peer-video:new', harness.element);
  gate.resolve();
  assert.equal(await oldAttach, null);
  assert.equal((await replacement).target, 'peer-video:new');
  assert.equal(harness.attached.get('viewer'), 'peer-video:new');
  assert.equal(harness.controller.getSurfaceEntry('viewer').target, 'peer-video:new');
});

test('preview stop then restart survives the old attach result and keeps its flag', async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ attach: (_request, count) => { if (count === 1) { entered.resolve(); return gate.promise; } } });
  const oldAttach = harness.controller.attachHostPreviewSurface();
  await entered.promise;
  const stopped = harness.controller.detachHostPreviewSurface();
  const restarted = harness.controller.attachHostPreviewSurface();
  gate.resolve();
  assert.equal(await oldAttach, null);
  await stopped;
  assert.ok(await restarted);
  assert.equal(harness.preview.attached, true);
  assert.equal(harness.attached.get(hostSurfaceId), 'host-capture-artifact');
  assert.equal(harness.controller.getSurfaceCount(), 1);
});

test('detaching during recovery prevents the cancelled surface from reappearing', async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ detach: (_request, count) => { if (count === 1) { entered.resolve(); return gate.promise; } } });
  await harness.controller.attachSurface('viewer', 'peer-video:one', harness.element);
  const recovering = harness.controller.recoverSurface('viewer', harness.controller.getSurfaceEntry('viewer'));
  await entered.promise;
  const stopped = harness.controller.detachSurface('viewer');
  gate.resolve();
  assert.equal(await recovering, null);
  await stopped;
  assert.equal(harness.calls.attach.length, 1);
  assert.equal(harness.controller.getSurfaceCount(), 0);
  assert.equal(harness.attached.size, 0);
});

test('a missing native surface is recreated and subsequent layout updates succeed', async () => {
  const harness = createHarness();
  await harness.controller.attachHostPreviewSurface();
  harness.attached.delete(hostSurfaceId);
  harness.rect.left += 10;
  harness.rect.right += 10;
  assert.ok(await harness.controller.updateSurface(hostSurfaceId));
  assert.equal(harness.attached.get(hostSurfaceId), 'host-capture-artifact');
  assert.equal(harness.controller.getSurfaceCount(), 1);
  assert.equal(harness.preview.attached, true);
  assert.equal(harness.calls.attach.length, 2);
  harness.rect.left += 10;
  harness.rect.right += 10;
  assert.equal((await harness.controller.updateSurface(hostSurfaceId)).updated, true);
  assert.equal(harness.calls.update.length, 2);
});

test('detaching during a missing-surface reattach cancels that recovery', async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ attach: (_request, count) => { if (count === 2) { entered.resolve(); return gate.promise; } } });
  await harness.controller.attachSurface('viewer', 'peer-video:one', harness.element);
  harness.attached.delete('viewer');
  harness.rect.left += 10;
  harness.rect.right += 10;
  const updating = harness.controller.updateSurface('viewer');
  const phase = await Promise.race([
    entered.promise.then(() => 'recovery-entered'),
    updating.then(() => 'update-finished')
  ]);
  assert.equal(phase, 'recovery-entered');
  const stopped = harness.controller.detachSurface('viewer');
  gate.resolve();
  assert.equal(await updating, null);
  await stopped;
  assert.equal(harness.controller.getSurfaceCount(), 0);
  assert.equal(harness.attached.size, 0);
});

for (const message of ['Surface is not attached', 'temporary update failure']) {
  test(`a stale update error (${message}) cannot remove or recover a replacement`, async () => {
    const entered = deferred();
    const gate = deferred();
    const harness = createHarness({ update: () => { entered.resolve(); return gate.promise; } });
    await harness.controller.attachSurface('viewer', 'peer-video:old', harness.element);
    harness.rect.left += 10;
    harness.rect.right += 10;
    const syncing = harness.controller.syncAllSurfaces();
    await entered.promise;
    const stopped = harness.controller.detachSurface('viewer');
    const restarted = harness.controller.attachSurface('viewer', 'peer-video:new', harness.element);
    gate.reject(new Error(message));
    await Promise.all([syncing, stopped, restarted]);
    assert.equal(harness.calls.attach.length, 2);
    assert.equal(harness.attached.get('viewer'), 'peer-video:new');
    assert.equal(harness.controller.getSurfaceEntry('viewer').target, 'peer-video:new');
  });
}

test('an attach failure does not block the queued replacement', async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ attach: (_request, count) => { if (count === 1) { entered.resolve(); return gate.promise; } } });
  const failed = harness.controller.attachSurface('viewer', 'peer-video:old', harness.element);
  const rejected = assert.rejects(failed, /attach failed/);
  await entered.promise;
  const restarted = harness.controller.attachSurface('viewer', 'peer-video:new', harness.element);
  gate.reject(new Error('attach failed'));
  await rejected;
  assert.ok(await restarted);
  assert.equal(harness.attached.get('viewer'), 'peer-video:new');
  assert.equal(harness.controller.getSurfaceCount(), 1);
});

test('a pending attach does not block a different surface ID', { timeout: 1000 }, async () => {
  const entered = deferred();
  const gate = deferred();
  const harness = createHarness({ attach: (request) => { if (request.surface === 'slow') { entered.resolve(); return gate.promise; } } });
  const slow = harness.controller.attachSurface('slow', 'peer-video:slow', harness.element);
  await entered.promise;
  try {
    assert.ok(await harness.controller.attachSurface('fast', 'peer-video:fast', harness.element));
    assert.equal(harness.attached.has('slow'), false);
    assert.equal(harness.attached.get('fast'), 'peer-video:fast');
  } finally {
    gate.resolve();
  }
  await slow;
});
