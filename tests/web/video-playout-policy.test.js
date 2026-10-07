const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

async function flush() { for (let index = 0; index < 80; index += 1) await Promise.resolve(); }

function harness() {
  const h = { now: 1000, chunks: [], decoders: [], drops: [], frames: [], painted: [], keyframeRequests: 0 };
  let id = 0;
  const timers = new Map();
  const animations = new Map();
  const setTimeout = (callback, delay) => { const handle = ++id; timers.set(handle, { at: h.now + delay, callback }); return handle; };
  const clearTimeout = (handle) => timers.delete(handle);
  h.tick = (milliseconds) => {
    const target = h.now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      h.now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    h.now = target;
    const callbacks = [...animations.values()]; animations.clear();
    for (const callback of callbacks) callback(h.now);
  };
  h.pendingAnimations = () => animations.size;
  h.pendingTimers = () => timers.size;
  h.frame = (ptsUs, width = 640, height = 360) => {
    const frame = { timestamp: ptsUs, displayWidth: width, displayHeight: height,
      codedWidth: width, codedHeight: height, closed: 0, close() { this.closed += 1; } };
    h.frames.push(frame); return frame;
  };
  class Decoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; h.decoders.push(this); }
    configure(config) { this.state = 'configured'; this.config = config; }
    decode(chunk) {
      assert.equal(this.state, 'configured'); h.chunks.push(chunk.init);
      if (h.failDecode) throw new Error('decoder rejected input');
      if (h.holdRequests) this.decodeQueueSize += 1;
      else if (h.onDecode) h.onDecode(this, chunk.init);
      else if (!h.holdOutputs) this.callbacks.output(h.frame(chunk.init.timestamp, h.outputWidth, h.outputHeight));
    }
    close() { assert.notEqual(this.state, 'closed'); this.state = 'closed'; }
  }
  class Chunk { constructor(init) { this.init = init; } }
  const context = vm.createContext({ ArrayBuffer, Uint8Array, Promise, Error,
    performance: { now: () => h.now }, window: { VideoDecoder: Decoder, EncodedVideoChunk: Chunk, setTimeout, clearTimeout,
      requestAnimationFrame: (callback) => { const handle = ++id; animations.set(handle, callback); return handle; },
      cancelAnimationFrame: (handle) => animations.delete(handle) } });
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} }; modules.set(name, module);
    const filename = path.resolve(__dirname, `../../vds_web/src/${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext(`(function(module,exports,require){${code}\n})`, context)(module, module.exports, (relative) => load(relative.replace(/^\.\//, '')));
    return module.exports;
  }
  h.policy = load('playback-policy');
  h.player = new (load('webcodecs-player').WebCodecsVideoPlayer)({ width: 1, height: 1,
    getContext: () => ({ drawImage(frame) { if (h.failRender) throw new Error('canvas unavailable'); h.painted.push(frame.timestamp); } }) }, {
    onState() {}, onPayloadFormat() {}, onDecodedFrame() {},
    onDroppedFrame: (reason) => h.drops.push(reason), onKeyframeNeeded: () => h.keyframeRequests++
  });
  h.payload = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x65, 0x88]).buffer;
  h.header = (sequence = 0, ptsUs = sequence * 33333, keyframe = sequence === 0, config = keyframe) => ({
    protocol: 'vds-media-encoded-v1', type: 'frame', streamType: 'video', codec: 'h264', payloadFormat: 'annexb',
    timestampUs: ptsUs, sequence, keyframe, config
  });
  h.push = (sequence = 0, ptsUs = sequence * 33333, keyframe = sequence === 0, payload = h.payload) => h.player.pushFrame(h.header(sequence, ptsUs, keyframe), payload);
  h.output = (ptsUs, width, height) => h.decoders.at(-1).callbacks.output(h.frame(ptsUs, width, height));
  return h;
}

test('B-frame input stays in decode order while presentation output follows PTS using one RAF', async () => {
  const h = harness(); h.holdOutputs = true;
  await h.push(0, 0); await h.push(1, 66666, false); await h.push(2, 33333, false);
  assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [0, 66666, 33333]);
  h.output(0); h.tick(17); assert.deepEqual(h.painted, []); assert.equal(h.pendingAnimations(), 1);
  h.tick(3); assert.deepEqual(h.painted, [0]);
  h.output(33333); h.output(66666); assert.equal(h.pendingAnimations(), 1);
  h.tick(34); h.tick(33);
  assert.deepEqual(h.painted, [0, 33333, 66666]);
  assert.ok(h.frames.every((frame) => frame.closed === 1));
  h.player.close(); assert.equal(h.pendingTimers(), 0); assert.equal(h.pendingAnimations(), 0);
});

test('actual decodeQueueSize pauses submission and dequeue resumes it without closing the codec', async () => {
  const h = harness(); h.holdRequests = true;
  for (let sequence = 0; sequence < 4; sequence++) await h.push(sequence);
  const pending = h.push(4); await flush();
  assert.equal(h.chunks.length, 4); assert.equal(h.player.getMetrics().decoderQueue, 4);
  const decoder = h.decoders[0]; decoder.decodeQueueSize = 2; decoder.ondequeue();
  for (let sequence = 0; sequence < 4; sequence++) h.output(sequence * 33333);
  h.tick(100);
  await pending;
  assert.equal(h.chunks.length, 5); assert.equal(h.decoders.length, 1);
  h.player.close(); assert.equal(h.pendingTimers(), 0);
});

test('a stuck decode queue recovers at a new keyframe and old timers cannot close its replacement', async () => {
  const h = harness(); h.holdRequests = true;
  for (let sequence = 0; sequence < 4; sequence++) await h.push(sequence);
  const pending = h.push(4); await flush();
  h.tick(159); assert.equal(h.decoders[0].state, 'configured');
  h.tick(1); await pending;
  assert.equal(h.decoders[0].state, 'closed'); assert.ok(h.drops.includes('webcodecs-video-decode-backlog'));
  assert.equal(h.keyframeRequests, 1);
  h.holdRequests = false; await h.push(5, 166665, true); h.tick(20);
  h.tick(500); assert.equal(h.decoders[1].state, 'configured');
  h.player.close();
});

test('codec-internal stalled output is detected even after decodeQueueSize reaches zero', async () => {
  const h = harness(); h.holdOutputs = true;
  await h.push(); assert.equal(h.player.getMetrics().decoderQueue, 0);
  h.tick(499); assert.equal(h.decoders[0].state, 'configured');
  h.tick(1); assert.equal(h.decoders[0].state, 'closed');
  assert.ok(h.drops.includes('webcodecs-video-output-stalled')); assert.equal(h.keyframeRequests, 1);
  h.holdOutputs = false; await h.push(1, 1000000, true); h.tick(20);
  assert.equal(h.painted.at(-1), 1000000); h.player.close();
});

test('continuous partial codec output cannot hide unbounded internal work behind an empty ready queue', async () => {
  const h = harness(); h.holdOutputs = true;
  let maximumPending = 0;
  for (let sequence = 0; sequence < 201; sequence++) {
    void h.push(sequence, sequence * 16667, sequence % 30 === 0);
    await flush();
    if (sequence % 6 === 0 && h.player.pendingCodecWork.length) {
      h.output(h.player.pendingCodecWork[0].ptsUs);
    }
    maximumPending = Math.max(maximumPending, h.player.getMetrics().pendingCodecOutputs);
    h.tick(16.667); await flush();
  }
  assert.ok(maximumPending <= 16);
  assert.ok(h.chunks.length < 201, 'slow output must cancel the old reference chain rather than store all input');
  assert.ok(h.keyframeRequests > 0);
  assert.ok(h.drops.some((reason) => ['webcodecs-video-output-backlog', 'webcodecs-video-queue-full'].includes(reason)));
  assert.ok(h.decoders.some((decoder) => decoder.state === 'closed'));
  h.player.close(); assert.equal(h.pendingTimers(), 0);
});

test('out-of-order partial output cannot renew the oldest codec submission beyond its 500 ms deadline', async () => {
  const h = harness(); h.holdOutputs = true;
  h.player.setExpectedDisplaySize(640, 360, 30);
  await h.push(0, 0);
  const pts = [0, 100000, 33333, 66666, 200000];
  for (let sequence = 1; sequence <= 4; sequence++) {
    h.tick(100); await h.push(sequence, pts[sequence]);
    if (sequence % 2 === 0) h.output(pts[sequence]);
  }
  assert.equal(h.decoders[0].state, 'configured');
  assert.equal(h.player.getMetrics().outputStallMs, 400);
  h.tick(99); assert.equal(h.decoders[0].state, 'configured');
  h.tick(1); assert.equal(h.decoders[0].state, 'closed');
  assert.ok(h.drops.includes('webcodecs-video-output-stalled'));
  h.holdOutputs = false; await h.push(5, 500000, true); h.tick(20);
  assert.equal(h.painted.at(-1), 500000); h.player.close();
});

test('B-frame bursts reserve a third slot within the 32 MiB estimate while ordinary video stays at two', async () => {
  const h = harness(); h.holdOutputs = true;
  await h.push(0, 0); await h.push(1, 100000, false); await h.push(2, 33333, false);
  assert.equal(h.player.getMetrics().decoderReordersPts, true);
  h.output(0, 1920, 1088); h.output(33333, 1920, 1088); h.output(66666, 1920, 1088);
  assert.equal(h.player.getMetrics().presentationCapacity, 3);
  assert.equal(h.player.getMetrics().presentationQueue, 3);
  assert.ok(h.player.getMetrics().presentationBytes < 32 * 1024 * 1024);
  h.tick(20); h.tick(34); h.tick(33);
  assert.deepEqual(h.painted, [0, 33333, 66666]); assert.equal(h.player.getMetrics().presentationDrops, 0);
  h.output(100000, 3840, 2160);
  assert.equal(h.player.getMetrics().presentationCapacity, 1, 'B-frame priming cannot exceed the byte budget');
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
  assert.equal(h.player.getMetrics().decoderReordersPts, false);
});

test('codec-internal outputs reserve ready slots without blocking priming when no picture is available', async () => {
  const h = harness(); h.holdOutputs = true;
  await h.push(0); h.output(0);
  await h.push(1); assert.equal(h.player.getMetrics().pendingCodecOutputs, 1);
  const waiting = h.push(2); await flush(); assert.equal(h.chunks.length, 2);
  h.output(33333); h.tick(20); await waiting;
  assert.equal(h.chunks.length, 3); assert.equal(h.player.getMetrics().presentationDrops, 0); h.player.close();
});

test('B-frame input can release codec-internal pictures while a future ready picture waits for its deadline', async () => {
  const h = harness(); h.holdOutputs = true;
  await h.push(0, 0); await h.push(1, 100000, false); await h.push(2, 33333, false);
  h.output(0);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 2);
  await h.push(3, 66666, false);
  assert.equal(h.chunks.length, 4, 'pending B pictures cannot prevent the next encoded input from releasing them');
  h.output(33333); h.output(66666);
  assert.equal(h.player.getMetrics().presentationQueue, 3); assert.equal(h.player.getMetrics().presentationDrops, 0);
  h.tick(20); h.tick(34); h.tick(33); assert.deepEqual(h.painted, [0, 33333, 66666]); h.player.close();
});

for (const frameRate of [30, 60]) test(`${frameRate} fps B2 mux bursts retain cadence with three bounded ready pictures`, async () => {
  const h = harness();
  h.player.setExpectedDisplaySize(1920, 1080, frameRate);
  const codecWork = [];
  h.onDecode = (decoder, chunk) => {
    codecWork.push(chunk.timestamp);
    if (codecWork.length > 2) {
      codecWork.sort((a, b) => a - b);
      decoder.callbacks.output(h.frame(codecWork.shift(), 1920, 1088));
    }
  };
  h.player.setPlaybackClock(() => ({ ptsUs: (h.now - 1000 - 60) * 1000, performanceMs: h.now }));
  const frameCount = 180;
  const batchSize = frameRate === 30 ? 7 : 14;
  const batchPeriod = batchSize * 1000 / frameRate;
  const promises = [];
  let sent = 0;
  let nextBatch = 1000;
  let maximumPending = 0;
  let maximumBytes = 0;
  while (sent < frameCount || h.player.getMetrics().pendingInputs) {
    if (h.now >= nextBatch && sent < frameCount) {
      for (let index = 0; index < batchSize && sent < frameCount; index++) {
        const sequence = sent++;
        const sourceFrame = sequence === 0 ? 0 : Math.floor((sequence - 1) / 3) * 3 + [3, 1, 2][(sequence - 1) % 3];
        promises.push(h.push(sequence, Math.round(sourceFrame * 1000000 / frameRate)));
        await flush(); // Each DataChannel message gets its own microtask checkpoint.
      }
      nextBatch += batchPeriod;
    }
    maximumPending = Math.max(maximumPending, h.player.getMetrics().pendingInputs);
    maximumBytes = Math.max(maximumBytes, h.player.getMetrics().presentationBytes);
    h.tick(5); await flush();
    assert.ok(h.now < 1000 + frameCount * 1000 / frameRate + 1000, 'normal bursts must keep making progress');
  }
  await Promise.all(promises);
  codecWork.sort((a, b) => a - b);
  for (const pts of codecWork) h.output(pts, 1920, 1088);
  for (let count = 0; count < 60; count++) { h.tick(5); await flush(); }
  assert.equal(h.chunks.length, frameCount);
  assert.ok(h.painted.length >= frameCount * 0.95, `presented ${h.painted.length}/${frameCount}`);
  assert.ok(maximumPending <= 12); assert.ok(maximumBytes <= 32 * 1024 * 1024);
  assert.ok(!h.drops.includes('webcodecs-video-queue-full'));
  assert.ok(!h.drops.includes('webcodecs-video-output-backlog'));
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

for (const bFrames of [0, 2, 3]) for (const frameRate of [30, 60])
for (const declaredFps of bFrames === 0 && frameRate === 60 ? [true, false] : [true])
test(`${frameRate} fps asynchronous B${bFrames} codec batches reserve future ready pictures${declaredFps ? '' : ' without manifest FPS'}`, async () => {
  const h = harness(); h.player.setExpectedDisplaySize(1920, 1080, declaredFps ? frameRate : 0);
  const codecWork = [];
  h.onDecode = (_decoder, chunk) => { codecWork.push(chunk.timestamp); };
  const audioLeadMs = bFrames === 3 && frameRate === 30 ? 100 : 60;
  h.player.setPlaybackClock(() => ({ ptsUs: (h.now - 1000 - audioLeadMs) * 1000, performanceMs: h.now }));
  const frameCount = 180;
  const batchSize = frameRate === 30 ? 7 : 14;
  const promises = [];
  let sent = 0, nextBatch = 1000, maximumPending = 0;
  while (sent < frameCount || h.player.getMetrics().pendingInputs) {
    if (h.now >= nextBatch && sent < frameCount) {
      for (let index = 0; index < batchSize && sent < frameCount; index++) {
        const sequence = sent++;
        const group = bFrames + 1;
        const sourceFrame = sequence === 0 ? 0 : Math.floor((sequence - 1) / group) * group +
          ((sequence - 1) % group === 0 ? group : (sequence - 1) % group);
        promises.push(h.push(sequence, Math.round(sourceFrame * 1000000 / frameRate)));
        await flush();
      }
      nextBatch += batchSize * 1000 / frameRate;
    }
    // A real VideoDecoder returns on a later codec task, after this ingress burst.
    while (codecWork.length > bFrames) {
      codecWork.sort((a, b) => a - b); h.output(codecWork.shift(), 1920, 1088); await flush();
    }
    const metrics = h.player.getMetrics();
    maximumPending = Math.max(maximumPending, metrics.pendingInputs);
    assert.ok(metrics.presentationQueue <= 3); assert.ok(metrics.presentationBytes <= 32 * 1024 * 1024);
    h.tick(5); await flush();
    assert.ok(h.now < 1000 + frameCount * 1000 / frameRate + 1000, 'asynchronous codec batches must keep making progress');
  }
  await Promise.all(promises);
  // A running decoder retains its final reorder pictures until more input or flush.
  // They are not an unsolicited extra output burst in continuous playback.
  for (let count = 0; count < 40; count++) { h.tick(5); await flush(); }
  assert.equal(h.chunks.length, frameCount);
  const startupAllowance = bFrames === 0 ? 2 : 0;
  assert.ok(h.painted.length >= frameCount - bFrames - startupAllowance - 1, `presented ${h.painted.length}/${frameCount}`);
  assert.ok(h.player.getMetrics().presentationOverflowDrops <= startupAllowance);
  assert.ok(h.player.getMetrics().presentationLateDrops <= 1);
  assert.equal(h.player.getMetrics().codecReorderAllowance, bFrames);
  assert.ok(maximumPending <= h.player.getMetrics().inputQueueCapacity);
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

for (const bFrames of [0, 2]) test(`60 fps B${bFrames} mux batches account for an actual 110 ms device clock lead`, async () => {
  const h = harness(); h.player.setExpectedDisplaySize(1920, 1080, 60);
  const codecWork = [];
  h.onDecode = (_decoder, chunk) => codecWork.push(chunk.timestamp);
  // getOutputTimestamp can describe a past device observation. Advance that
  // observation to now instead of reserving against a stale performance time.
  h.player.setPlaybackClock(() => ({ ptsUs: (h.now - 25 - 1000 - 110) * 1000, performanceMs: h.now - 25 }));
  const promises = [];
  let sent = 0, nextBatch = 1000, maximumPending = 0;
  while (sent < 180 || h.player.getMetrics().pendingInputs) {
    if (h.now >= nextBatch && sent < 180) {
      for (let index = 0; index < 14 && sent < 180; index++) {
        const sequence = sent++, group = bFrames + 1;
        const picture = sequence === 0 ? 0 : Math.floor((sequence - 1) / group) * group +
          ((sequence - 1) % group === 0 ? group : (sequence - 1) % group);
        promises.push(h.push(sequence, Math.round(picture * 1000000 / 60))); await flush();
        maximumPending = Math.max(maximumPending, h.player.getMetrics().pendingInputs);
      }
      nextBatch += 14 * 1000 / 60;
    }
    while (codecWork.length > bFrames) {
      codecWork.sort((a, b) => a - b); h.output(codecWork.shift(), 1920, 1088); await flush();
    }
    assert.ok(h.player.getMetrics().presentationQueue <= 3);
    assert.ok(h.player.getMetrics().presentationBytes <= 32 * 1024 * 1024);
    h.tick(5); await flush();
    assert.ok(h.now < 5000, 'a normal clock lead must not cause repeated reference-chain reset');
  }
  await Promise.all(promises);
  for (let count = 0; count < 50; count++) { h.tick(5); await flush(); }
  assert.equal(h.chunks.length, 180);
  assert.ok(h.painted.length >= 176, `presented ${h.painted.length}/180`);
  if (bFrames === 0) assert.ok(maximumPending >= 18, 'the fixture must exercise more than the previous 17 compressed requests');
  assert.ok(!h.drops.includes('webcodecs-video-queue-full'));
  assert.equal(h.keyframeRequests, 0);
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

test('B2 pictures retained during a known audio deadline wait are not mistaken for 500 ms of codec work', async () => {
  const h = harness(); h.player.setExpectedDisplaySize(1920, 1080, 30);
  const codecWork = [];
  h.onDecode = (_decoder, chunk) => codecWork.push(chunk.timestamp);
  h.player.setPlaybackClock(() => ({ ptsUs: 10000000 + (h.now - 1000 - 700) * 1000, performanceMs: h.now }));
  const promises = [];
  let sent = 0, nextBatch = 1000;
  while (sent < 180 || h.player.getMetrics().pendingInputs) {
    if (h.now >= nextBatch && sent < 180) {
      for (let index = 0; index < 7 && sent < 180; index++) {
        const sequence = sent++;
        const picture = sequence === 0 ? 0 : Math.floor((sequence - 1) / 3) * 3 +
          ((sequence - 1) % 3 === 0 ? 3 : (sequence - 1) % 3);
        promises.push(h.push(sequence, 10000000 + Math.round(picture * 1000000 / 30))); await flush();
      }
      nextBatch += 7 * 1000 / 30;
    }
    while (codecWork.length > 2) {
      codecWork.sort((a, b) => a - b); h.output(codecWork.shift(), 1920, 1088); await flush();
    }
    assert.ok(h.player.getMetrics().presentationQueue <= 3);
    h.tick(5); await flush();
    assert.ok(h.now < 9000);
  }
  await Promise.all(promises);
  for (let count = 0; count < 40; count++) { h.tick(5); await flush(); }
  assert.equal(h.chunks.length, 180);
  assert.ok(h.painted.length >= 176, `presented ${h.painted.length}/180`);
  assert.equal(h.keyframeRequests, 0);
  assert.ok(!h.drops.includes('webcodecs-video-output-stalled'));
  assert.equal(h.player.getMetrics().presentationDrops, 0);
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

for (const end of ['close', 'decoder error']) test(`a retained B-frame presentation wait is canceled by ${end} without a timer reaching its replacement`, async () => {
  const h = harness(); h.player.setExpectedDisplaySize(1920, 1080, 30);
  const codecWork = [];
  h.onDecode = (_decoder, chunk) => codecWork.push(chunk.timestamp);
  h.player.setPlaybackClock(() => ({ ptsUs: 10000000 + (h.now - 1000 - 700) * 1000, performanceMs: h.now }));
  const promises = [];
  for (const [sequence, picture] of [0, 3, 1, 2, 6, 4, 5].entries()) {
    promises.push(h.push(sequence, 10000000 + Math.round(picture * 1000000 / 30))); await flush();
  }
  while (codecWork.length > 2) {
    codecWork.sort((a, b) => a - b); h.output(codecWork.shift(), 1920, 1088); await flush();
  }
  assert.equal(h.player.getMetrics().codecPresentationWait, true);
  const oldDecoder = h.decoders[0]; h.tick(550); await flush();
  assert.equal(oldDecoder.state, 'configured');
  assert.ok(h.player.getMetrics().oldestCodecOutputMs >= 550);
  assert.ok(h.player.getMetrics().outputStallMs < 500);
  if (end === 'close') h.player.close();
  else oldDecoder.callbacks.error(new Error('codec-error'));
  await Promise.all(promises);
  assert.equal(h.player.getMetrics().codecPresentationWait, false);
  assert.equal(h.pendingTimers(), 0);
  h.player.setPlaybackClock(() => null); h.tick(1000); await flush();
  const replacementPts = end === 'close' ? 20000000 : 10233333;
  h.onDecode = null; await h.push(7, replacementPts, true);
  oldDecoder.callbacks.output(h.frame(10166667));
  h.tick(20); h.tick(550);
  assert.equal(h.decoders[1].state, 'configured');
  assert.equal(h.painted.at(-1), replacementPts);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

for (const width of [1920, 3840]) test(`an asynchronous B2 GOP flush with ${width === 3840 ? 'one 4K slot' : 'three 1080p slots'} releases held pictures before each IDR`, async () => {
  const height = width === 3840 ? 2160 : 1088;
  const h = harness(); h.player.setExpectedDisplaySize(width, height, 30);
  const codecWork = [];
  let flushBeforePts = null;
  h.onDecode = (_decoder, chunk) => {
    if (chunk.type === 'key' && codecWork.length) flushBeforePts = chunk.timestamp;
    codecWork.push(chunk.timestamp);
  };
  h.player.setPlaybackClock(() => ({ ptsUs: (h.now - 1000 - 60) * 1000, performanceMs: h.now }));
  const pictures = [];
  for (let start = 0; start < 180; start += 30) {
    pictures.push({ pts: start, key: true });
    let previous = start;
    while (previous < start + 29) {
      const reference = Math.min(previous + 3, start + 29);
      pictures.push({ pts: reference, key: false });
      for (let b = previous + 1; b < reference; b++) pictures.push({ pts: b, key: false });
      previous = reference;
    }
  }
  assert.equal(pictures.length, 180);
  let sent = 0, nextBatch = 1000;
  const promises = [];
  while (sent < pictures.length || h.player.getMetrics().pendingInputs) {
    if (h.now >= nextBatch && sent < pictures.length) {
      for (let index = 0; index < 7 && sent < pictures.length; index++) {
        const sequence = sent++, picture = pictures[sequence];
        promises.push(h.push(sequence, Math.round(picture.pts * 1000000 / 30), picture.key)); await flush();
      }
      nextBatch += 7 * 1000 / 30;
    }
    codecWork.sort((a, b) => a - b);
    while (flushBeforePts !== null && codecWork[0] < flushBeforePts) {
      h.output(codecWork.shift(), width, height); await flush();
    }
    flushBeforePts = null;
    while (codecWork.length > 2) {
      codecWork.sort((a, b) => a - b); h.output(codecWork.shift(), width, height); await flush();
    }
    assert.ok(h.player.getMetrics().presentationQueue <= (width === 3840 ? 1 : 3));
    assert.ok(h.player.getMetrics().presentationOverflowDrops <= (width === 3840 ? 7 : 0), JSON.stringify({ now: h.now, sent, chunks: h.chunks.length, metrics: h.player.getMetrics() }));
    h.tick(5); await flush();
    assert.ok(h.now < 8000, 'a keyframe must not deadlock retained codec pictures');
  }
  await Promise.all(promises);
  for (let count = 0; count < 40; count++) { h.tick(5); await flush(); }
  assert.equal(h.chunks.length, 180);
  // One 4K slot cannot retain both pictures released by an IDR. Allow one
  // eviction per GOP plus the two initial priming pictures, without codec reset.
  assert.ok(h.painted.length >= (width === 3840 ? 170 : 177), `presented ${h.painted.length}/180`);
  assert.ok(h.player.getMetrics().presentationOverflowDrops <= (width === 3840 ? 7 : 0));
  assert.equal(h.keyframeRequests, 0);
  assert.ok(!h.drops.includes('webcodecs-video-output-stalled'));
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

test('a decoder error during presentation waiting cannot submit to null or revive the failed reference chain', async () => {
  const h = harness(); await h.push(0); await h.push(1);
  const waiting = h.push(2); await flush(); assert.equal(h.chunks.length, 2);
  h.decoders[0].callbacks.error(new Error('codec-error')); await waiting;
  h.tick(20); await flush();
  assert.equal(h.player.waitingForKeyframe, true); assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  await h.push(3, 99999, false); assert.equal(h.chunks.length, 2);
  await h.push(4, 133332, true); h.tick(20); assert.equal(h.chunks.length, 3); h.player.close();
});

test('output queue targets two frames and 32 MiB, releasing evicted and closed frames once', async () => {
  const h = harness(); h.holdOutputs = true; await h.push();
  h.output(0); h.output(33333); h.output(66666);
  assert.equal(h.player.getMetrics().presentationQueue, 2); assert.equal(h.frames[0].closed, 0);
  assert.equal(h.frames[1].closed, 1, 'a codec burst retains the earliest deadline and latest output');
  h.output(100000, 3840, 2160);
  assert.equal(h.player.getMetrics().presentationQueue, 1); assert.ok(h.player.getMetrics().presentationBytes <= 32 * 1024 * 1024);
  h.output(133333, 7680, 4320); assert.equal(h.frames.at(-1).closed, 1);
  const oldDecoder = h.decoders[0]; h.player.close();
  oldDecoder.callbacks.output(h.frame(166666));
  assert.ok(h.frames.every((frame) => frame.closed === 1)); assert.equal(h.pendingAnimations(), 0);
});

test('a supported large decoded frame can own one slot without turning the queue budget into a resolution ban', async () => {
  const h = harness(); h.outputWidth = 7680; h.outputHeight = 4320;
  await h.push(0);
  assert.equal(h.player.getMetrics().presentationCapacity, 1);
  assert.equal(h.player.getMetrics().presentationQueue, 1);
  assert.equal(h.frames[0].closed, 0);
  assert.ok(h.player.getMetrics().presentationBytes > 32 * 1024 * 1024);
  const waiting = h.push(1); await flush(); assert.equal(h.chunks.length, 1);
  h.tick(20); await waiting; h.tick(34);
  assert.deepEqual(h.painted, [0, 33333]);
  assert.equal(h.player.getMetrics().presentationDrops, 0);
  h.player.close(); assert.ok(h.frames.every((frame) => frame.closed === 1));
});

test('pure configuration packets retain SPS/PPS while a config-marked VCL packet is still decoded', async () => {
  const h = harness();
  const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]).buffer;
  const pps = new Uint8Array([0, 0, 0, 1, 0x68, 0xce, 0x06]).buffer;
  await h.player.pushFrame(h.header(0, 0, false, true), sps);
  await h.player.pushFrame(h.header(1, 0, false, true), pps);
  assert.equal(h.chunks.length, 0);
  await h.push(2, 0, true, new Uint8Array([0, 0, 0, 1, 0x65, 0x88]).buffer);
  assert.equal(h.chunks.length, 1);
  const payload = new Uint8Array(h.chunks[0].data);
  assert.ok(payload.includes(0x67)); assert.ok(payload.includes(0x68)); assert.ok(payload.includes(0x65));
  await h.player.pushFrame(h.header(3, 33333, false, true), h.payload);
  assert.equal(h.chunks.length, 2, 'config=true cannot erase a packet containing a picture');
  h.player.close();
});

test('device audio clock drives PTS deadlines, with monotonic fallback when it is unavailable', async () => {
  const h = harness(); h.holdOutputs = true;
  let clock = { ptsUs: 1000000, performanceMs: 1000 };
  h.player.setPlaybackClock(() => clock);
  await h.push(0, 1033333); h.output(1033333);
  h.tick(20); assert.deepEqual(h.painted, []);
  h.tick(14); assert.deepEqual(h.painted, [1033333]);
  clock = null;
  await h.push(1, 1066666, false); h.output(1066666); h.tick(34);
  assert.equal(h.painted.at(-1), 1066666); h.player.close();
});

test('codec switches clear incompatible parameter sets and full configuration is not duplicated', async () => {
  const h = harness();
  await h.push();
  assert.deepEqual(Array.from(new Uint8Array(h.chunks[0].data)), Array.from(new Uint8Array(h.payload)));
  const hevcPayload = new Uint8Array([0, 0, 0, 1, 0x42, 1, 1, 1, 1, 1, 93, 0, 0, 0, 1, 0x26, 1, 0x88]).buffer;
  await h.player.pushFrame({ ...h.header(1, 33333, true), codec: 'h265' }, hevcPayload);
  assert.deepEqual(Array.from(new Uint8Array(h.chunks[1].data)), Array.from(new Uint8Array(hevcPayload)));
  assert.equal(h.decoders[0].state, 'closed');
  assert.ok(h.decoders[1].config.codec.startsWith('hev1.'));
  h.player.close();
});

test('a rejected decode clears pending output accounting and recovers without a phantom watchdog', async () => {
  const h = harness(); h.failDecode = true;
  await h.push();
  assert.equal(h.decoders[0].state, 'closed');
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0); assert.equal(h.pendingTimers(), 0);
  h.failDecode = false; await h.push(1, 33333, true); h.tick(20); h.tick(500);
  assert.equal(h.decoders[1].state, 'configured');
  assert.ok(!h.drops.includes('webcodecs-video-output-stalled')); h.player.close();
});

test('a canvas failure releases its frame and the remaining RAF presentation continues', async () => {
  const h = harness(); h.holdOutputs = true; await h.push();
  h.output(0); h.output(33333); h.failRender = true; h.tick(20);
  assert.equal(h.frames[0].closed, 1); assert.equal(h.pendingAnimations(), 1);
  assert.ok(h.drops.includes('web-video-presentation-failed'));
  h.failRender = false; h.tick(34); assert.deepEqual(h.painted, [33333]);
  assert.ok(h.frames.every((frame) => frame.closed === 1)); h.player.close();
});

test('adaptive buffer stays between 20 and 60 ms and ignores backwards B-frame PTS', () => {
  const h = harness(); const delay = new h.policy.AdaptivePlaybackDelay();
  delay.observe(0, 0);
  for (let index = 1; index <= 8; index++) delay.observe(index * 60, index * 33333);
  assert.equal(delay.value, 60);
  delay.observe(500, 100000); assert.equal(delay.value, 60);
  for (let index = 1; index <= 170; index++) delay.observe(500 + index * 34, 100000 + index * 34000);
  assert.ok(delay.value < 60); assert.ok(delay.value >= 20);
  delay.reset(); assert.equal(delay.value, 20);
});

test('reorder keeps sequence distinct from PTS, consumes configuration sequence and ignores old bootstrap', () => {
  const h = harness(); const delay = new h.policy.AdaptivePlaybackDelay();
  const order = new h.policy.VideoSequenceReorder(delay);
  const frame = (sequence, pts, key = false, config = false) => ({ header: h.header(sequence, pts, key, config), payload: h.payload });
  order.push(frame(0, 0, false, true), 0); assert.equal(order.drain(0).frames.length, 0);
  order.push(frame(1, 0, true), 1); assert.deepEqual([...order.drain(1).frames].map((item) => item.header.sequence), [0, 1]);
  order.push(frame(3, 33333), 2); assert.equal(order.drain(2).frames.length, 0);
  order.push(frame(2, 66666), 3);
  assert.deepEqual([...order.drain(3).frames].map((item) => item.header.timestampUs), [66666, 33333]);
  order.push(frame(1, 0, true), 4); assert.equal(order.drain(4).frames.length, 0);
});

test('missing sequence has a deadline and bounded storage, then a fresh keyframe resumes decoding', () => {
  const h = harness(); const delay = new h.policy.AdaptivePlaybackDelay();
  const order = new h.policy.VideoSequenceReorder(delay);
  const frame = (sequence, key = false) => ({ header: h.header(sequence, sequence * 33333, key), payload: h.payload });
  order.push(frame(1, true), 0); order.drain(0);
  order.push(frame(3), 1); assert.equal(order.drain(20).requestKeyframe, false);
  assert.equal(order.drain(21).requestKeyframe, true); assert.equal(order.size, 0);
  for (let sequence = 4; sequence < 40; sequence++) { order.push(frame(sequence), sequence); assert.ok(order.size <= 12); }
  order.push(frame(40, true), 40);
  assert.deepEqual([...order.drain(40).frames].map((item) => item.header.sequence), [40]);
});

test('source epoch history rejects all retired sources without limiting normal source changes', () => {
  const h = harness(); const gate = new h.policy.SourceEpochGate();
  assert.equal(gate.accept('source-0').accepted, true);
  for (let index = 1; index <= 1024; index++) {
    assert.equal(gate.accept(`source-${index}`).changed, true);
    assert.equal(gate.accept(`source-${index - 1}`).reason, 'retired');
  }
  assert.equal(gate.retiredCount, 1024); assert.equal(gate.current, 'source-1024');
  assert.equal(gate.accept('source-1025').accepted, true);
  assert.equal(gate.current, 'source-1025'); assert.equal(gate.accept('source-0').reason, 'retired');
  assert.equal(gate.accept(undefined).reason, 'legacy-after-epoch');
  gate.clear(); assert.equal(gate.accept(undefined).accepted, true); assert.equal(gate.retiredCount, 0);
});

test('reorder stays bounded even if a retained bootstrap keyframe cannot reduce an overflow', () => {
  const h = harness(); const order = new h.policy.VideoSequenceReorder(new h.policy.AdaptivePlaybackDelay());
  for (let sequence = 0; sequence < 100; sequence++) {
    order.push({ header: h.header(sequence, sequence * 33333, true), payload: h.payload }, sequence);
    assert.ok(order.size <= 12);
  }
});

for (const fps of [30, 60]) {
  for (const width of [640, 3840]) {
    for (const bufferMs of [20, 60]) {
    test(`${fps} fps continuous silent video keeps cadence at ${bufferMs} ms with ${width === 3840 ? 'one 4K slot' : 'two slots'}`, async (t) => {
      const h = harness(); h.outputWidth = width; h.outputHeight = width === 3840 ? 2160 : 360;
      h.player.bufferDelay.targetMs = bufferMs;
      const tasks = [];
      for (let index = 0; index < 180; index++) {
        tasks.push(h.push(index, Math.round(index * 1000000 / fps)));
        await flush(); h.tick(1000 / fps); await flush();
        assert.ok(h.player.getMetrics().presentationQueue <= (width === 3840 ? 1 : 2));
        assert.ok(h.player.getMetrics().presentationBytes <= 32 * 1024 * 1024);
      }
      for (let index = 0; index < 8; index++) { h.tick(1000 / fps); await flush(); }
      await Promise.all(tasks);
      assert.ok(h.painted.length >= 174, `only ${h.painted.length}/180 frames were presented`);
      assert.ok(!h.drops.includes('webcodecs-video-queue-full')); assert.equal(h.keyframeRequests, 0);
      assert.ok(h.player.getMetrics().schedulerLatenessP95Ms <= 1000 / fps + 2);
      assert.ok(h.player.schedulerLateness.length <= 128);
      t.diagnostic(JSON.stringify({ presented: h.painted.length, submitted: 180,
        p95Ms: h.player.getMetrics().schedulerLatenessP95Ms, drops: h.player.getMetrics().presentationDrops }));
      h.player.close();
    });
    }
  }
}

test('device audio 60 ms behind source retains 60 fps by waiting on bounded presentation capacity', async () => {
  const h = harness(); const tasks = [];
  h.player.setPlaybackClock(() => ({ ptsUs: (h.now - 1000 - 60) * 1000, performanceMs: h.now }));
  for (let index = 0; index < 180; index++) {
    tasks.push(h.push(index, Math.round(index * 1000000 / 60)));
    await flush(); h.tick(1000 / 60); await flush();
  }
  for (let index = 0; index < 8; index++) { h.tick(1000 / 60); await flush(); }
  await Promise.all(tasks);
  assert.ok(h.painted.length >= 174, `only ${h.painted.length}/180 audio-clocked frames were presented`);
  assert.equal(h.keyframeRequests, 0); h.player.close();
});

test('presentation waits do not use the decoder 160 ms timeout and close settles stale waits', async () => {
  const h = harness();
  h.player.setPlaybackClock(() => ({ ptsUs: (h.now - 1000 - 300) * 1000, performanceMs: h.now }));
  await h.push(0); await h.push(1);
  const waiting = h.push(2); await flush(); assert.equal(h.chunks.length, 2);
  h.tick(160); await flush(); assert.equal(h.decoders[0].state, 'configured');
  assert.ok(!h.drops.includes('webcodecs-video-decode-backlog'));
  h.player.close(); await waiting; assert.equal(h.pendingAnimations(), 0);
  h.player.setPlaybackClock(() => null); await h.push(0, 0, true); h.tick(20);
  assert.equal(h.painted.length, 1); assert.equal(h.decoders[1].state, 'configured'); h.player.close();
});

test('a fixed 200 ms arrival-delay increase reanchors the monotonic fallback after repeated late frames', async () => {
  const h = harness(); const tasks = [];
  for (let index = 0; index < 30; index++) {
    tasks.push(h.push(index, Math.round(index * 1000000 / 60)));
    await flush(); h.tick(1000 / 60); await flush();
  }
  h.tick(200);
  for (let index = 30; index < 180; index++) {
    tasks.push(h.push(index, Math.round(index * 1000000 / 60)));
    await flush(); h.tick(1000 / 60); await flush();
  }
  for (let index = 0; index < 8; index++) { h.tick(1000 / 60); await flush(); }
  await Promise.all(tasks);
  assert.ok(h.player.getMetrics().fallbackReanchors >= 1);
  assert.ok(h.player.getMetrics().schedulerLatenessP95Ms < 40);
  assert.ok(h.painted.length >= 170); h.player.close();
});
