const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function createHarness() {
  let now = 0;
  let nextTimer = 1;
  let serializations = 0;
  const timers = new Map();
  const clock = {
    get now() { return now; },
    get size() { return timers.size; },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    }
  };
  const json = Object.create(JSON);
  json.stringify = (...args) => {
    serializations += 1;
    return JSON.stringify(...args);
  };
  const context = vm.createContext({ window: clock, JSON: json });
  const filename = path.resolve(__dirname, '../../vds_web/src/diagnostics.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = {};
  vm.runInContext(`(function (exports) { ${code}\n })`, context)(exports);
  const capability = {
    browser: 'test', platform: 'windows', reasons: [],
    supportedVideoCodecs: ['h264'], supportedAudioCodecs: ['aac']
  };
  return {
    store: new exports.DiagnosticsStore(capability, 'diagnostics-test-client'),
    clock,
    get serializations() { return serializations; }
  };
}

test('a frame burst updates snapshots and explicit exports immediately but renders one batch', () => {
  const h = createHarness();
  const reports = [];
  const unsubscribe = h.store.subscribe(() => reports.push(JSON.parse(h.store.format())));
  for (let index = 0; index < 1000; index += 1) {
    h.store.incrementCounter('webDecodedVideoFrames');
    h.store.incrementCounter('webDecodedAudioBlocks', 2);
  }
  h.store.incrementCandidate('upstream', 'local');
  h.store.update({ status: 'playing', sessionToken: '123456-secret' });
  assert.equal(h.store.getSnapshot().webDecodedVideoFrames, 1000);
  assert.equal(h.store.getSnapshot().webDecodedAudioBlocks, 2000);
  assert.equal(h.store.getSnapshot().candidateCounts.upstream.local, 1);
  const exported = JSON.parse(h.store.format());
  assert.equal(exported.webDecodedVideoFrames, 1000);
  assert.equal(exported.sessionToken, '123456...');
  assert.equal(exported.diagnosticsSchemaVersion, 2);
  assert.equal(h.serializations, 1, 'explicit copy/export reads current data');
  assert.equal(h.clock.size, 1, 'one pending notification for the whole burst');
  h.clock.advance(249);
  assert.equal(reports.length, 0);
  h.clock.advance(1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'playing');
  assert.equal(reports[0].webDecodedAudioBlocks, 2000);
  assert.equal(h.serializations, 2);
  assert.equal(h.clock.size, 0);
  unsubscribe();
});

test('continuous updates notify and serialize at most four times per second', () => {
  const h = createHarness();
  const notifications = [];
  const unsubscribe = h.store.subscribe(() => {
    h.store.format();
    notifications.push(h.clock.now);
  });
  h.store.incrementCounter('dataChannelFramesReceived');
  for (let index = 0; index < 1000; index += 1) {
    h.clock.advance(1);
    h.store.incrementCounter('dataChannelFramesReceived');
  }
  assert.equal(h.store.getSnapshot().dataChannelFramesReceived, 1001);
  assert.deepEqual(notifications, [250, 500, 750, 1000]);
  assert.equal(h.serializations, 4);
  unsubscribe();
  assert.equal(h.clock.size, 0, 'the pending trailing notification is cancelled');
  h.clock.advance(1000);
  assert.equal(notifications.length, 4);
});

test('unobserved updates have no timers and the last unsubscribe cancels pending work', () => {
  const h = createHarness();
  h.store.incrementCounter('webDecodedVideoFrames', 5);
  assert.equal(h.clock.size, 0);
  let firstNotifications = 0;
  let secondNotifications = 0;
  const unsubscribeFirst = h.store.subscribe(() => { firstNotifications += 1; });
  const unsubscribeSecond = h.store.subscribe(() => { secondNotifications += 1; });
  assert.equal(h.clock.size, 1, 'a new observer receives the accumulated changes');
  unsubscribeFirst();
  assert.equal(h.clock.size, 1, 'another observer still needs the batch');
  unsubscribeSecond();
  unsubscribeSecond();
  assert.equal(h.clock.size, 0);
  h.clock.advance(1000);
  assert.equal(firstNotifications + secondNotifications, 0);
  assert.equal(h.store.getSnapshot().webDecodedVideoFrames, 5);
  const unsubscribeAgain = h.store.subscribe(() => { secondNotifications += 1; });
  h.clock.advance(250);
  assert.equal(secondNotifications, 1);
  unsubscribeAgain();
  assert.equal(h.clock.size, 0);
});

test('unchanged state does not schedule work while repeated manifest observations retain their counts', () => {
  const h = createHarness();
  let notifications = 0;
  const unsubscribe = h.store.subscribe(() => { notifications += 1; });
  h.store.update({});
  h.store.update({ status: h.store.getSnapshot().status });
  h.store.incrementCounter('webDecodedVideoFrames', 0);
  assert.equal(h.clock.size, 0);
  h.store.updateIce('peer', 'connected');
  h.clock.advance(250);
  h.store.updateIce('peer', 'connected');
  assert.equal(h.clock.size, 0);
  const mediaManifest = {
    protocol: 'vds-media-encoded-v1',
    video: { codec: 'h264', payloadFormat: 'annexb' },
    audio: { codec: 'aac', payloadFormat: 'aac-adts' }
  };
  h.store.update({ mediaManifest });
  h.store.update({ mediaManifest });
  assert.equal(h.store.getSnapshot().observedMediaManifests[0].count, 2);
  h.clock.advance(250);
  assert.equal(notifications, 2);
  unsubscribe();
});

test('listener updates wait for the next batch and subscription changes are safe during notification', () => {
  const h = createHarness();
  const delivered = [];
  let firstDelivery = true;
  let unsubscribeThird;
  const unsubscribeFirst = h.store.subscribe(() => {
    delivered.push(`first:${h.clock.now}`);
    if (!firstDelivery) return;
    firstDelivery = false;
    h.store.incrementCounter('webDecodedVideoFrames');
    unsubscribeSecond();
    unsubscribeThird = h.store.subscribe(() => delivered.push(`third:${h.clock.now}`));
  });
  const unsubscribeSecond = h.store.subscribe(() => delivered.push(`second:${h.clock.now}`));
  h.store.incrementCounter('webDecodedVideoFrames');
  h.clock.advance(250);
  assert.deepEqual(delivered, ['first:250']);
  assert.equal(h.store.getSnapshot().webDecodedVideoFrames, 2);
  assert.equal(h.clock.size, 1);
  h.clock.advance(249);
  assert.deepEqual(delivered, ['first:250']);
  h.clock.advance(1);
  assert.deepEqual(delivered, ['first:250', 'first:500', 'third:500']);
  assert.equal(h.clock.size, 0);
  unsubscribeFirst();
  unsubscribeThird();
});
