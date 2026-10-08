const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const controllerPath = path.resolve(__dirname, '../../server/public/source-selection.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const windowSource = (pid = 100) => ({ id: `window:${pid}:0`, title: `Window ${pid}`, kind: 'window', pid, audioCandidates: [] });
const screenSource = () => ({ id: 'screen:0:0', title: '屏幕 1', kind: 'display', pid: null, audioCandidates: [] });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.attributes = new Map();
    this.textContent = '';
    this.disabled = false;
    this.checked = false;
    this.isConnected = true;
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, enabled) => {
        const add = enabled === undefined ? !this.classes.has(name) : Boolean(enabled);
        if (add) this.classes.add(name); else this.classes.delete(name);
        return add;
      }
    };
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set innerHTML(_value) {
    for (const child of this.children) child.disconnect();
    this.children = [];
  }
  get innerHTML() { return ''; }
  appendChild(child) {
    child.parentElement = this;
    child.isConnected = this.isConnected;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) { this.innerHTML = ''; children.forEach(child => this.appendChild(child)); }
  disconnect() { this.isConnected = false; this.children.forEach(child => child.disconnect()); }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  dispatch(name) {
    const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    for (const handler of this.listeners.get(name) || []) handler(event);
  }
  click() { this.dispatch('click'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const matches = element => selectors.some(value => {
      if (value.startsWith('.')) return value.slice(1).split('.').every(name => element.classList.contains(name));
      if (value.startsWith('#')) return element.id === value.slice(1);
      return element.tagName.toLowerCase() === value.toLowerCase();
    });
    const found = [];
    const visit = element => {
      for (const child of element.children) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createHarness(t, hooks = {}) {
  const modal = new Element();
  modal.classList.add('hidden');
  const sourceList = new Element();
  const elements = Object.fromEntries([
    'sourceAudioEnabled', 'sourceAudioSummary', 'sourceAudioProcessList',
    'btnConfirmQuality', 'btnConfirmSource', 'btnRefreshSources'
  ].map(name => [name, new Element()]));
  modal.appendChild(sourceList);
  for (const name of ['sourceAudioEnabled', 'sourceAudioSummary', 'sourceAudioProcessList']) modal.appendChild(elements[name]);
  const calls = { platform: 0, permission: 0, processes: 0, captureTargets: 0, starts: [], errors: [], logs: [], resets: 0, marked: 0 };
  const sources = hooks.sources || [windowSource()];
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const document = {
    getElementById: id => id === 'source-modal' ? modal : id === 'source-list' ? sourceList : null,
    createElement: tagName => new Element(tagName),
    querySelectorAll: selector => modal.querySelectorAll(selector),
    querySelector: selector => modal.querySelector(selector)
  };
  const context = {
    window: {}, document, console,
    setTimeout: (callback, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timer.unref();
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
  };
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  vm.runInNewContext(controllerSource, context, { filename: controllerPath });
  const mediaEngine = {
    listCaptureTargets: async () => {
      calls.captureTargets += 1;
      return hooks.listCaptureTargets ? hooks.listCaptureTargets(calls.captureTargets) : sources;
    },
    audio: {
      isPlatformSupported: async () => {
        calls.platform += 1;
        return hooks.isPlatformSupported ? hooks.isPlatformSupported(calls.platform) : true;
      },
      checkPermission: async () => {
        calls.permission += 1;
        return hooks.checkPermission ? hooks.checkPermission(calls.permission) : { status: 'authorized' };
      },
      getProcessList: async () => {
        calls.processes += 1;
        return hooks.getProcessList ? hooks.getProcessList(calls.processes) : (hooks.processes || []);
      }
    }
  };
  const recordStart = async (source, pid) => {
    const request = { sourceId: source.id, mode: pid ? 'audio' : 'video', pid: pid || null };
    calls.starts.push(request);
    if (hooks.start) await hooks.start(request);
  };
  const controller = context.window.VDS.sourceSelection.createController({
    elements, getMediaEngine: () => mediaEngine,
    showError: message => calls.errors.push(message),
    debugLog: (...message) => calls.logs.push(message),
    startScreenShareWithSource: source => recordStart(source),
    startScreenShareWithAudio: (source, pid) => recordStart(source, pid),
    resetShareStartPendingUi: () => { calls.resets += 1; },
    markShareStartInFlight: () => { calls.marked += 1; }
  });
  // This is the same change binding used by app.js.
  elements.sourceAudioEnabled.addEventListener('change', () => controller.updateSourceAudioUi());
  const selectedItem = () => sourceList.children.find(item => item.classList.contains('selected'));
  const candidates = () => JSON.parse(selectedItem().dataset.audioCandidates || '[]');
  const chooseProcess = pid => {
    const row = elements.sourceAudioProcessList.children.find(item => new RegExp(`(?:^|\\D)${pid}(?:\\D|$)`).test(item.textContent));
    assert.ok(row, `audio process ${pid} must be available for manual selection`);
    row.click();
  };
  const toggleAudio = enabled => {
    elements.sourceAudioEnabled.checked = enabled;
    elements.sourceAudioEnabled.dispatch('change');
  };
  return { controller, elements, modal, sourceList, calls, candidates, selectedItem, chooseProcess, toggleAudio };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('opening the picker starts discovery immediately and shows a loading state before confirmation', async t => {
  const pending = deferred();
  const h = createHarness(t, { getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.equal(h.calls.processes, 1);
  assert.equal(h.controller.getSnapshot().audioDiscoveryStatus, 'loading');
  assert.match(h.elements.sourceAudioSummary.textContent, /加载|探测|检测|发现|查询|读取|获取/);
  assert.equal(h.calls.starts.length, 0);
  pending.resolve([]);
  await opening;
  await settle();
  assert.equal(h.controller.getSnapshot().audioDiscoveryStatus, 'ready');
});

test('a silent window remains directly capturable through its PID without an active audio session', async t => {
  const h = createHarness(t);
  await h.controller.showSourceSelection();
  await settle();
  assert.equal(h.calls.processes, 1);
  assert.ok(h.candidates().some(candidate => candidate.pid === 100));
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'window:100:0', mode: 'audio', pid: 100 }]);
});

test('a valid window PID can start immediately while discovery is still pending', async t => {
  const pending = deferred();
  const h = createHarness(t, { getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const confirming = h.controller.confirmSourceAndShare();
  await settle();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'window:100:0', mode: 'audio', pid: 100 }]);
  pending.resolve([{ pid: 999, name: 'Other application' }]);
  await Promise.all([opening, confirming]);
  await settle();
  assert.equal(h.calls.starts.length, 1);
});

test('switching windows reuses the in-flight list and preserves the new default process tree', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [windowSource(100), windowSource(200)], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  h.sourceList.children[1].click();
  await settle();
  assert.equal(h.calls.processes, 1);
  assert.equal(h.selectedItem().dataset.id, 'window:200:0');
  pending.resolve([{ pid: 300, name: 'Other active application' }]);
  await opening;
  await settle();
  assert.ok(h.candidates().some(candidate => candidate.pid === 200));
  assert.ok(h.candidates().some(candidate => candidate.pid === 300));
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'window:200:0', mode: 'audio', pid: 200 }]);
  assert.equal(h.calls.processes, 1);
});

test('screen sharing presents all active processes for explicit selection before confirmation', async t => {
  const h = createHarness(t, {
    sources: [screenSource()],
    processes: [{ pid: 201, name: 'VLC' }, { pid: 202, name: 'Music player' }, { pid: 203, name: 'Browser' }]
  });
  await h.controller.showSourceSelection();
  await settle();
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.deepEqual(h.candidates().map(candidate => candidate.pid), [201, 202, 203]);
  h.chooseProcess(202);
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'audio', pid: 202 }]);
});

test('screen audio never automatically selects an unrelated active application', async t => {
  const h = createHarness(t, { sources: [screenSource()], processes: [{ pid: 201, name: 'Voice call' }] });
  await h.controller.showSourceSelection();
  await settle();
  assert.ok(h.candidates().some(candidate => candidate.pid === 201));
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'video', pid: null }]);
});

test('window audio keeps its PID default, removes duplicate PIDs and allows an explicit process override', async t => {
  const h = createHarness(t, { processes: [{ pid: 100, name: 'Same window' }, { pid: 202, name: 'Actual child or another application' }] });
  await h.controller.showSourceSelection();
  await settle();
  assert.equal(h.candidates().filter(candidate => candidate.pid === 100).length, 1);
  h.chooseProcess(202);
  h.controller.updateSourceAudioUi();
  await settle();
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'window:100:0', mode: 'audio', pid: 202 }]);
});

test('discovery failures remain visible and a window PID still supports direct capture', async t => {
  const h = createHarness(t, { getProcessList: () => { throw new Error('native-audio-probe-failed'); } });
  await h.controller.showSourceSelection();
  await settle();
  assert.equal(h.controller.getSnapshot().audioDiscoveryStatus, 'error');
  assert.match(h.controller.getSnapshot().audioDiscoveryError, /native-audio-probe-failed/);
  assert.match(h.elements.sourceAudioSummary.textContent, /native-audio-probe-failed|失败|错误/);
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.ok(h.candidates().some(candidate => candidate.pid === 100));
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'window:100:0', mode: 'audio', pid: 100 }]);
});

test('a failed screen probe can continue with video and differs from a successful empty probe', async t => {
  const failing = createHarness(t, { sources: [screenSource()], getProcessList: () => { throw new Error('enumeration-failed'); } });
  const empty = createHarness(t, { sources: [screenSource()] });
  await Promise.all([failing.controller.showSourceSelection(), empty.controller.showSourceSelection()]);
  await settle();
  assert.equal(failing.controller.getSnapshot().audioDiscoveryStatus, 'error');
  assert.equal(empty.controller.getSnapshot().audioDiscoveryStatus, 'ready');
  assert.notEqual(failing.elements.sourceAudioSummary.textContent, empty.elements.sourceAudioSummary.textContent);
  await failing.controller.confirmSourceAndShare();
  assert.deepEqual(failing.calls.starts, [{ sourceId: 'screen:0:0', mode: 'video', pid: null }]);
});

test('disabling audio bypasses a pending process probe and toggling reuses the same picker discovery', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  h.toggleAudio(false);
  h.toggleAudio(true);
  h.toggleAudio(false);
  const confirming = h.controller.confirmSourceAndShare();
  await settle();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'video', pid: null }]);
  assert.equal(h.calls.processes, 1);
  pending.resolve([{ pid: 201, name: 'VLC' }]);
  await Promise.all([opening, confirming]);
  await settle();
  assert.equal(h.calls.starts.length, 1);
});

test('duplicate confirmation remains single-flight while the process list is pending', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const first = h.controller.confirmSourceAndShare();
  const second = h.controller.confirmSourceAndShare();
  await settle();
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.equal(h.calls.starts.length, 0);
  pending.resolve([]);
  await Promise.all([opening, first, second]);
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'video', pid: null }]);
});

test('newly discovered screen audio returns pending confirmation to the visible picker for a real selection', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const confirming = h.controller.confirmSourceAndShare();
  await settle();
  pending.resolve([{ pid: 201, name: 'Voice call' }, { pid: 202, name: 'Movie player' }]);
  await Promise.all([opening, confirming]);
  await settle();
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.equal(h.controller.getSnapshot().sourceConfirmInFlight, false);
  assert.equal(h.elements.btnConfirmSource.disabled, false);
  h.chooseProcess(202);
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'audio', pid: 202 }]);
});

test('turning audio off invalidates a pending confirmation and a fresh video-only confirmation starts immediately', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const oldConfirmation = h.controller.confirmSourceAndShare();
  await settle();
  h.toggleAudio(false);
  const currentConfirmation = h.controller.confirmSourceAndShare();
  await settle();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'video', pid: null }]);
  pending.resolve([{ pid: 201, name: 'Late active application' }]);
  await Promise.all([opening, oldConfirmation, currentConfirmation]);
  await settle();
  assert.equal(h.calls.starts.length, 1);
});

test('cancelling during pending confirmation prevents a late share', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const confirming = h.controller.confirmSourceAndShare();
  await settle();
  h.controller.cancelSourceSelection();
  assert.equal(h.modal.classList.contains('hidden'), true);
  pending.resolve([{ pid: 201, name: 'VLC' }]);
  await Promise.all([opening, confirming]);
  await settle();
  assert.equal(h.calls.starts.length, 0);
});

test('switching source during pending confirmation invalidates that request and permits a new one', async t => {
  const pending = deferred();
  const h = createHarness(t, { sources: [screenSource(), windowSource(200)], getProcessList: () => pending.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const staleConfirmation = h.controller.confirmSourceAndShare();
  await settle();
  h.sourceList.children[1].click();
  const currentConfirmation = h.controller.confirmSourceAndShare();
  await settle();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'window:200:0', mode: 'audio', pid: 200 }]);
  pending.resolve([{ pid: 201, name: 'VLC' }]);
  await Promise.all([opening, staleConfirmation, currentConfirmation]);
  await settle();
  assert.equal(h.calls.starts.length, 1);
});

test('an old picker discovery cannot overwrite a reopened picker or start an old confirmation', async t => {
  const oldProbe = deferred();
  const newProbe = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: call => call === 1 ? oldProbe.promise : newProbe.promise });
  const oldOpening = h.controller.showSourceSelection();
  await settle();
  const oldConfirmation = h.controller.confirmSourceAndShare();
  await settle();
  h.controller.cancelSourceSelection();
  const newOpening = h.controller.showSourceSelection();
  await settle();
  assert.equal(h.calls.processes, 2);
  oldProbe.resolve([{ pid: 201, name: 'Stale process' }]);
  await Promise.all([oldOpening, oldConfirmation]);
  await settle();
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.equal(h.controller.getSnapshot().audioDiscoveryStatus, 'loading');
  assert.ok(!h.candidates().some(candidate => candidate.pid === 201));
  newProbe.resolve([{ pid: 301, name: 'Current process' }]);
  await newOpening;
  await settle();
  assert.deepEqual(h.candidates().map(candidate => candidate.pid), [301]);
  h.chooseProcess(301);
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'audio', pid: 301 }]);
});

test('replacing the modal with the same source ID still invalidates the old confirmation and discovery', async t => {
  const oldProbe = deferred();
  const newProbe = deferred();
  const h = createHarness(t, { sources: [screenSource()], getProcessList: call => call === 1 ? oldProbe.promise : newProbe.promise });
  const opening = h.controller.showSourceSelection();
  await settle();
  const staleConfirmation = h.controller.confirmSourceAndShare();
  await settle();
  h.controller.showSourceModal([{ ...screenSource(), title: 'Same screen in a new picker' }]);
  await settle();
  assert.equal(h.calls.processes, 2);
  oldProbe.resolve([{ pid: 201, name: 'Old session process' }]);
  await Promise.all([opening, staleConfirmation]);
  await settle();
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.modal.classList.contains('hidden'), false);
  assert.equal(h.controller.getSnapshot().audioDiscoveryStatus, 'loading');
  assert.ok(!h.candidates().some(candidate => candidate.pid === 201));
  newProbe.resolve([{ pid: 301, name: 'New session process' }]);
  await settle();
  h.chooseProcess(301);
  await h.controller.confirmSourceAndShare();
  assert.deepEqual(h.calls.starts, [{ sourceId: 'screen:0:0', mode: 'audio', pid: 301 }]);
});

test('cancelling a pending refresh releases its UI and an old completion cannot release a newer refresh', async t => {
  const oldRefresh = deferred();
  const currentRefresh = deferred();
  const h = createHarness(t, {
    listCaptureTargets: call => {
      if (call === 1) return [windowSource(100)];
      if (call === 2) return oldRefresh.promise;
      if (call === 3) return [windowSource(200)];
      if (call === 4) return currentRefresh.promise;
      throw new Error(`unexpected capture target enumeration: ${call}`);
    }
  });
  await h.controller.showSourceSelection();
  await settle();
  const oldRefreshing = h.controller.refreshSources();
  await settle();
  assert.equal(h.controller.getSnapshot().sourceListRefreshInFlight, true);
  assert.equal(h.elements.btnRefreshSources.disabled, true);
  assert.ok(h.elements.btnRefreshSources.style.animation.length > 0);

  h.controller.cancelSourceSelection();
  assert.equal(h.controller.getSnapshot().sourceListRefreshInFlight, false);
  assert.equal(h.elements.btnRefreshSources.style.animation, '');
  assert.equal(h.elements.btnRefreshSources.disabled, false);
  assert.equal(h.elements.btnConfirmSource.disabled, false);
  assert.equal(h.modal.classList.contains('hidden'), true);

  await h.controller.showSourceSelection();
  await settle();
  assert.equal(h.selectedItem().dataset.id, 'window:200:0');
  const currentRefreshing = h.controller.refreshSources();
  await settle();
  const currentAnimation = h.elements.btnRefreshSources.style.animation;
  assert.ok(currentAnimation.length > 0);
  assert.equal(h.controller.getSnapshot().sourceListRefreshInFlight, true);
  assert.equal(h.elements.btnRefreshSources.disabled, true);
  assert.equal(h.elements.btnConfirmSource.disabled, true);

  oldRefresh.resolve([windowSource(300)]);
  await oldRefreshing;
  await settle();
  assert.equal(h.selectedItem().dataset.id, 'window:200:0');
  assert.equal(h.controller.getSnapshot().sourceListRefreshInFlight, true);
  assert.equal(h.elements.btnRefreshSources.style.animation, currentAnimation);
  assert.equal(h.elements.btnRefreshSources.disabled, true);
  assert.equal(h.elements.btnConfirmSource.disabled, true);

  currentRefresh.resolve([windowSource(400)]);
  await currentRefreshing;
  await settle();
  assert.equal(h.selectedItem().dataset.id, 'window:400:0');
  assert.equal(h.controller.getSnapshot().sourceListRefreshInFlight, false);
  assert.equal(h.elements.btnRefreshSources.style.animation, '');
  assert.equal(h.elements.btnRefreshSources.disabled, false);
  assert.equal(h.elements.btnConfirmSource.disabled, false);
});
