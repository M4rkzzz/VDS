const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

async function advancePlayout(h, milliseconds) {
  let remaining = milliseconds;
  while (remaining > 0.001) {
    const step = Math.min(10, remaining);
    for (const context of h.contexts) if (context.state === 'running') context.currentTime += step / 1000;
    h.clock.advance(step);
    await flush();
    for (const source of [...h.player.scheduledSources]) {
      const start = source.starts[0];
      if (source.onended && start.at + source.buffer.duration - start.offset <= h.contexts.at(-1).currentTime) source.onended();
    }
    h.onTick?.();
    remaining -= step;
  }
}

function harness(initialAudioState = 'running') {
  // Playout tests use an allowed output device. Policy tests explicitly create
  // a suspended/interrupted context rather than scheduling into one implicitly.
  const h = { contexts: [], decoders: [], sources: [], chunks: [], drops: [], outputStates: [], outputs: 0, released: 0, buffers: 0, pcmCopies: 0, nowMs: 1000 };
  let timerId = 0;
  const timers = new Map();
  h.clock = {
    get size() { return timers.size; },
    callbacks() { return [...timers.values()].map((timer) => timer.callback); },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { at: h.nowMs + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = h.nowMs + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        h.nowMs = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      h.nowMs = target;
    }
  };
  let support = async () => ({ supported: true });
  h.setSupport = (next) => { support = next; };
  h.data = (timestamp = 1000000, frames = 960) => ({
    timestamp, sampleRate: h.outputSampleRate || 48000, numberOfFrames: frames, numberOfChannels: 2,
    copyTo: (target) => { h.pcmCopies += 1; target.fill(0); },
    close() { h.released += 1; }
  });
  class AudioDecoder {
    static isConfigSupported(config) { return support(config); }
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
      h.decoders.push(this);
    }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) {
      assert.equal(this.state, 'configured');
      if (h.decodeError) throw new Error('decode-failed');
      h.chunks.push(chunk.init);
      h.onDecode?.(chunk.init);
      if (h.holdDecode) this.decodeQueueSize += 1;
      else if (!h.swallowOutput) this.callbacks.output(h.data(chunk.init.timestamp, h.outputFrames || 960));
    }
    close() { assert.notEqual(this.state, 'closed'); this.state = 'closed'; }
  }
  class Chunk { constructor(init) { this.init = init; } }
  class Context {
    constructor() {
      this.currentTime = 1;
      this.state = initialAudioState;
      this.destination = {};
      this.outputTimestamp = { contextTime: 0, performanceTime: 0 };
      h.contexts.push(this);
    }
    async resume() {
      if (h.resumeWait) await h.resumeWait;
      this.state = 'running';
      this.onstatechange?.();
    }
    async close() { this.state = 'closed'; }
    getOutputTimestamp() { return this.outputTimestamp; }
    createBuffer(channels, frames, sampleRate) {
      h.buffers += 1;
      return { duration: frames / sampleRate, getChannelData: () => new Float32Array(frames) };
    }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() {
      const source = {
        starts: [], stopped: 0, disconnected: 0, onended: null,
        connect() {},
        start(at, offset) {
          if (h.startError) throw new Error('start-failed');
          this.starts.push({ at, offset });
        },
        stop() { this.stopped += 1; },
        disconnect() { this.disconnected += 1; }
      };
      h.sources.push(source);
      return source;
    }
  }
  const environment = vm.createContext({
    ArrayBuffer, Uint8Array, Float32Array, Promise, Error,
    performance: { now: () => h.nowMs },
    window: {
      AudioDecoder, EncodedAudioChunk: Chunk, AudioContext: Context,
      setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout
    }
  });
  const modules = new Map();
  function loadModule(name) {
    const filename = path.resolve(__dirname, `../../vds_web/src/${name}.ts`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const execute = vm.runInContext(`(function (module, exports, require) { ${code}\n })`, environment);
    execute(module, module.exports, (relative) => loadModule(relative.replace(/^\.\//, '')));
    return module.exports;
  }
  h.player = new (loadModule('webcodecs-audio-player').WebCodecsAudioPlayer)({
    onOutputState: (state) => h.outputStates.push(state),
    onState() {}, onDecodedBlock: () => { h.outputs += 1; }, onDroppedBlock: (reason) => h.drops.push(reason)
  });
  h.push = (timestampUs = 1000000, codec = 'opus', sequence = timestampUs) => h.player.pushFrame({
    protocol: 'vds-media-encoded-v1', type: 'frame', streamType: 'audio', codec,
    payloadFormat: 'raw', timestampUs, sequence, keyframe: true, config: false
  }, new Uint8Array([1, 2, 3]).buffer);
  h.output = (ptsUs, frames) => h.decoders.at(-1).callbacks.output(h.data(ptsUs, frames));
  return h;
}

test('audio output is lazy and an interrupted context resumes on a later gesture', async () => {
  const h = harness('suspended');
  assert.equal(h.contexts.length, 0);
  h.player.setVolume(0.5);
  h.player.setFormat(48000, 2);
  assert.equal(h.contexts.length, 0, 'volume and manifest setup must not create audio before a gesture or media');
  await h.player.resume();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.outputStates[0], 'suspended');
  assert.equal(h.outputStates.at(-1), 'running');
  const context = h.contexts[0];
  context.state = 'interrupted';
  context.onstatechange();
  assert.equal(h.outputStates.at(-1), 'interrupted');
  await h.player.resume();
  assert.equal(context.state, 'running');
  assert.equal(h.outputStates.at(-1), 'running');
  h.player.close();
});

test('a blocked old audio unlock cannot publish running into a replacement context', async () => {
  const h = harness('suspended');
  const blocked = deferred();
  h.resumeWait = blocked.promise;
  const pending = h.player.resume();
  assert.deepEqual(h.outputStates, ['suspended']);
  h.player.close();
  h.resumeWait = null;
  await h.player.resume();
  assert.equal(h.contexts.length, 2);
  const count = h.outputStates.length;
  blocked.resolve();
  await pending;
  assert.equal(h.outputStates.length, count, 'obsolete context state and resume completions must be ignored');
  assert.equal(h.contexts[1].state, 'running');
  h.player.close();
});

test('a user gesture stays unlocked, and volume, format and manual delay survive close', async () => {
  const h = harness();
  await h.player.resume();
  h.player.setVolume(0.25);
  h.player.setFormat(44100, 1);
  h.player.setDelayMs(100);
  await h.push();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].state, 'running');
  assert.equal(h.decoders[0].config.sampleRate, 44100);
  assert.equal(h.decoders[0].config.numberOfChannels, 1);
  assert.equal(h.player.gainNode.gain.value, 0.25);
  assert.equal(h.sources[0].starts[0].at, 1.12, '20 ms buffering is independent of manual delay');
  h.player.close();
  await h.player.resume();
  await h.push(2000000);
  assert.equal(h.decoders.at(-1).config.sampleRate, 44100);
  assert.equal(h.player.gainNode.gain.value, 0.25);
  assert.equal(h.sources.at(-1).starts[0].at, 1.12);
  h.player.close();
});

test('the master clock maps source PTS to the device timestamp, including manual delay', async () => {
  const h = harness();
  await h.player.resume();
  h.player.setDelayMs(100);
  await h.push();
  const context = h.contexts[0];
  context.outputTimestamp = { contextTime: 1.13, performanceTime: 5000 };
  const clock = h.player.getPlaybackClock();
  assert.ok(Math.abs(clock.ptsUs - 1010000) < 0.001);
  assert.equal(clock.performanceMs, 5000);
  context.outputTimestamp = { contextTime: 1.11, performanceTime: 5000 };
  assert.equal(h.player.getPlaybackClock(), null, 'a future sound cannot be a device clock');
  context.outputTimestamp = { contextTime: 1.3, performanceTime: 5000 };
  assert.equal(h.player.getPlaybackClock(), null, 'a drained source does not provide an indefinite clock');
  h.player.close();
  assert.equal(h.player.getPlaybackClock(), null);
});

test('missing, suspended, zero and invalid device timestamps fall back without a fabricated clock', async () => {
  const h = harness('suspended');
  await h.push();
  const context = h.contexts[0];
  context.outputTimestamp = { contextTime: 1.03, performanceTime: 5000 };
  assert.equal(h.player.getPlaybackClock(), null);
  await h.player.resume();
  await h.push(1020000);
  assert.notEqual(h.player.getPlaybackClock(), null, 'a fresh running packet establishes an actual clock');
  context.outputTimestamp = { contextTime: 0, performanceTime: 0 };
  assert.equal(h.player.getPlaybackClock(), null);
  context.outputTimestamp = { contextTime: 1.03, performanceTime: NaN };
  assert.equal(h.player.getPlaybackClock(), null);
  context.getOutputTimestamp = undefined;
  assert.equal(h.player.getPlaybackClock(), null);
  h.player.close();
});

test('muting removes the heard-audio clock and unmuting restores it without replacing playback resources', async () => {
  const h = harness();
  await h.player.resume();
  await h.push();
  const context = h.contexts[0];
  const decoder = h.decoders[0];
  const source = h.sources[0];
  context.outputTimestamp = { contextTime: 1.03, performanceTime: 1000 };
  assert.ok(h.player.getPlaybackClock());
  h.player.setVolume(0);
  assert.equal(h.player.getPlaybackClock(), null);
  assert.equal(h.player.getMetrics().clockValid, false);
  assert.equal(source.stopped, 0);
  assert.equal(decoder.state, 'configured');
  h.player.setVolume(0.4);
  assert.ok(Math.abs(h.player.getPlaybackClock().ptsUs - 1010000) < 0.001);
  assert.equal(h.player.getMetrics().clockValid, true);
  assert.equal(h.player.context, context);
  assert.equal(h.player.decoder, decoder);
  assert.equal(h.player.scheduledSources.has(source), true);
  assert.equal(context.state, 'running');
  h.player.close();
});

test('a muted context with a slow 32-second fake sink never becomes the video master clock', async () => {
  const h = harness();
  await h.player.resume();
  await h.push(1000000, 'opus', 0);
  const context = h.contexts[0];
  const decoder = h.decoders[0];
  h.player.setVolume(0);
  h.clock.advance(32000);
  context.currentTime += 32 * 0.65;
  h.sources[0].onended();
  await h.push(21800000, 'opus', 1);
  const anchor = h.player.clockAnchors.at(-1);
  context.outputTimestamp = { contextTime: anchor.contextTime + 0.005, performanceTime: h.nowMs };
  assert.equal(h.player.getPlaybackClock(), null);
  assert.equal(h.player.getMetrics().clockValid, false);
  assert.equal(h.player.context, context);
  assert.equal(h.player.decoder, decoder);
  assert.equal(context.state, 'running');
  h.player.setVolume(0.5);
  const clock = h.player.getPlaybackClock();
  assert.ok(clock);
  assert.ok(Math.abs(clock.ptsUs - 21805000) < 0.001);
  assert.equal(clock.performanceMs, h.nowMs);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.decoders.length, 1);
  assert.deepEqual(h.drops, []);
  h.player.close();
});

test('source scheduling follows PTS, while jitter changes are bounded and sources never overlap', async () => {
  const h = harness();
  await h.player.resume();
  await h.push();
  for (let index = 1; index < 12; index += 1) {
    h.nowMs += 45;
    h.contexts[0].currentTime += 0.02;
    await h.push(1000000 + index * 20000);
    assert.ok(h.player.playbackDelay.value >= 20 && h.player.playbackDelay.value <= 60);
    const previous = h.sources.at(-2);
    const source = h.sources.at(-1);
    assert.ok(source.starts[0].at >= previous.starts[0].at + previous.buffer.duration - previous.starts[0].offset - 1e-9);
  }
  assert.equal(h.player.playbackDelay.value, 60);
  const source = h.sources.at(-1);
  assert.ok(Math.abs(source.starts[0].at - (h.contexts[0].currentTime + 0.06)) < 1e-8);
  h.player.close();
});

test('normal onended removes a source; close stops every remaining source exactly once', async () => {
  const h = harness();
  await h.push();
  await h.push(1020000);
  const ended = h.sources[0];
  const lateEnded = ended.onended;
  ended.onended();
  assert.equal(ended.disconnected, 1);
  assert.equal(h.player.scheduledSources.size, 1);
  h.player.close();
  h.player.close();
  lateEnded();
  assert.equal(ended.stopped, 0);
  assert.equal(ended.disconnected, 1);
  assert.equal(h.sources[1].stopped, 1);
  assert.equal(h.sources[1].disconnected, 1);
  assert.equal(h.player.scheduledSources.size, 0);
});

test('stable arrivals reduce extra jitter delay slowly, trimming overlap instead of double-playing samples', async () => {
  const h = harness();
  await h.player.resume();
  await h.push();
  for (let index = 1; index <= 4; index += 1) {
    h.nowMs += 45;
    h.contexts[0].currentTime += 0.02;
    h.sources.at(-1).onended();
    await h.push(1000000 + index * 20000);
  }
  assert.equal(h.player.getMetrics().targetBufferMs, 60);
  for (let index = 5; index <= 260; index += 1) {
    h.nowMs += 20;
    h.contexts[0].currentTime += 0.02;
    h.sources.at(-1).onended();
    await h.push(1000000 + index * 20000);
    const previous = h.sources.at(-2);
    const current = h.sources.at(-1);
    assert.ok(current.starts[0].at >= previous.starts[0].at + previous.buffer.duration - previous.starts[0].offset - 1e-8);
  }
  assert.equal(h.player.getMetrics().targetBufferMs, 55);
  assert.ok(h.sources.some((source) => source.starts[0].offset > 0.004));
  assert.ok(h.player.getMetrics().scheduledLeadMs <= 80);
  h.player.close();
});

test('partial lateness trims elapsed samples; an overlapping duplicate is released without another source', async () => {
  const h = harness();
  await h.player.resume();
  await h.push();
  h.contexts[0].currentTime = 1.05;
  await h.push(1020000);
  const current = h.sources.at(-1);
  assert.ok(Math.abs(current.starts[0].at - 1.052) < 1e-8);
  assert.ok(Math.abs(current.starts[0].offset - 0.012) < 1e-8);
  h.player.playAudioData(h.data(1020000));
  assert.equal(h.sources.length, 2);
  assert.ok(h.drops.includes('webcodecs-audio-output-overlap'));
  h.contexts[0].outputTimestamp = { contextTime: 1.055, performanceTime: 5055 };
  assert.ok(Math.abs(h.player.getPlaybackClock().ptsUs - 1035000) < 0.001);
  assert.equal(h.released, 3);
  h.player.close();
});

test('unordered stale encoded packets are discarded before AAC or Opus decoder state changes', async () => {
  for (const codec of ['opus', 'aac']) {
    const h = harness();
    await h.push(400000, codec, 20);
    await h.push(440000, codec, 22);
    await h.push(420000, codec, 21);
    await h.push(440000, codec, 22);
    await h.push(430000, codec, 23);
    await h.push(460000, codec, 22);
    assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [400000, 440000]);
    assert.equal(h.outputs, 2);
    assert.equal(h.drops.filter((reason) => reason === 'web-audio-stale-encoded-frame').length, 4);
    h.player.close();
  }
});

test('audio sequence may jump by samples; zero and a lower first timestamp are valid after reset', async () => {
  const h = harness();
  await h.push(0, 'opus', 0);
  await h.push(20000, 'opus', 960);
  await h.push(40000, 'opus', 1920);
  assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [0, 20000, 40000]);
  h.player.close();
  await h.push(0, 'opus', 0);
  await h.push(20000, 'opus', 960);
  await h.push(0, 'aac', 0);
  assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [0, 20000, 40000, 0, 20000, 0]);
  assert.equal(h.decoders.length, 3);
  assert.deepEqual(h.drops, []);
  h.player.close();
});

test('a media epoch reset stops old sound and permits low PTS without losing the user gesture or controls', async () => {
  const h = harness();
  await h.player.resume();
  h.player.setVolume(0.25);
  h.player.setDelayMs(100);
  h.player.setFormat(44100, 1);
  await h.push(1000000, 'opus', 48000);
  const oldDecoder = h.decoders[0];
  const context = h.contexts[0];
  const gain = h.player.gainNode;
  const oldEnded = h.sources[0].onended;
  h.player.resetMedia();
  assert.equal(h.sources[0].stopped, 1);
  assert.equal(h.sources[0].disconnected, 1);
  assert.equal(context.state, 'running');
  assert.equal(h.player.gainNode, gain);
  assert.equal(h.player.getPlaybackClock(), null);
  await h.push(0, 'opus', 0);
  oldDecoder.callbacks.output(h.data(1020000));
  oldDecoder.callbacks.error(new Error('old-epoch-error'));
  oldEnded();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[1].stopped, 0);
  assert.equal(h.sources[1].starts[0].at, 1.12);
  assert.equal(h.decoders[1].config.sampleRate, 44100);
  assert.equal(h.decoders[1].config.numberOfChannels, 1);
  assert.equal(h.decoders[1].state, 'configured');
  assert.equal(gain.gain.value, 0.25);
  assert.equal(h.outputs, 2);
  assert.equal(h.released, 3);
  assert.deepEqual(h.drops, []);
  h.player.close();
});

test('media reset cancels an old support probe and decoder watchdog while preserving the running context', async () => {
  const h = harness();
  await h.player.resume();
  const support = deferred();
  h.setSupport(() => support.promise);
  const pending = h.push(1000000);
  await flush();
  h.player.resetMedia();
  h.setSupport(async () => ({ supported: true }));
  h.holdDecode = true;
  for (let index = 0; index < 8; index += 1) await h.push(index * 1000, 'opus', index * 960);
  const waiting = h.push(8000, 'opus', 7680);
  await flush();
  assert.equal(h.clock.size, 2);
  h.player.resetMedia();
  await waiting;
  assert.equal(h.clock.size, 0);
  h.holdDecode = false;
  await h.push(0, 'opus', 0);
  support.resolve({ supported: true });
  await pending;
  h.clock.advance(200);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].state, 'running');
  assert.equal(h.decoders.length, 2);
  assert.equal(h.decoders[1].state, 'configured');
  assert.equal(h.chunks.at(-1).timestamp, 0);
  assert.equal(h.outputs, 1);
  assert.deepEqual(h.drops, []);
  h.player.close();
});

test('changing delay or format cancels already scheduled sound and keeps the unlocked context', async () => {
  const h = harness();
  await h.player.resume();
  await h.push();
  const context = h.contexts[0];
  h.player.setDelayMs(100);
  assert.equal(h.sources[0].stopped, 1);
  await h.push(1020000);
  assert.equal(h.sources[1].starts[0].at, 1.12);
  h.player.setFormat(44100, 1);
  assert.equal(h.sources[1].stopped, 1);
  assert.equal(h.decoders[0].state, 'closed');
  await h.push(1040000);
  assert.equal(h.decoders[1].config.sampleRate, 44100);
  assert.equal(context.state, 'running');
  assert.equal(h.contexts.length, 1);
  h.player.close();
});

test('suspended AAC and Opus release each block without allocating output, then resume from fresh media', async () => {
  for (const codec of ['opus', 'aac']) {
    const h = harness('suspended');
    for (let index = 0; index < 50; index += 1) await h.push(1000000 + index * 20000, codec);
    assert.equal(h.drops.length, 50);
    assert.ok(h.drops.every((reason) => reason === 'web-audio-output-awaiting-gesture'));
    assert.equal(h.buffers, 0);
    assert.equal(h.pcmCopies, 0);
    assert.equal(h.sources.length, 0);
    assert.equal(h.released, 50);
    assert.equal(h.player.getMetrics().scheduledSources, 0);
    assert.equal(h.player.getMetrics().scheduledLeadMs, 0);
    assert.equal(h.player.getMetrics().decoded, 0);
    assert.equal(h.player.getMetrics().dropped, 50);
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
    assert.equal(h.player.getPlaybackClock(), null);
    const decoder = h.decoders[0];
    await h.player.resume();
    assert.equal(h.sources.length, 0, 'a gesture must not replay blocked old packets');
    await h.push(5000000, codec);
    assert.equal(h.contexts.length, 1);
    assert.equal(h.decoders.length, 1);
    assert.equal(h.decoders[0], decoder);
    assert.equal(h.sources.length, 1);
    assert.equal(h.outputs, 1);
    assert.equal(h.player.timelineAnchor.ptsUs, 5000000);
    h.contexts[0].outputTimestamp = { contextTime: 1.025, performanceTime: 5000 };
    assert.ok(Math.abs(h.player.getPlaybackClock().ptsUs - 5005000) < 0.001);
    h.player.close();
  }
});

test('interrupted output releases previous scheduling and preserves the decoder for fresh resumed audio', async () => {
  const h = harness();
  await h.push();
  const decoder = h.decoders[0], context = h.contexts[0], source = h.sources[0];
  context.state = 'interrupted';
  context.onstatechange();
  await h.push(1020000);
  assert.equal(source.stopped, 1);
  assert.equal(source.disconnected, 1);
  assert.equal(h.player.getMetrics().scheduledSources, 0);
  assert.equal(h.player.getMetrics().scheduledLeadMs, 0);
  assert.equal(h.player.getPlaybackClock(), null);
  assert.equal(h.buffers, 1);
  assert.equal(h.sources.length, 1);
  assert.equal(h.drops.at(-1), 'web-audio-output-awaiting-gesture');
  await h.player.resume();
  await h.push(1040000);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.decoders[0], decoder);
  assert.equal(h.decoders.length, 1);
  assert.equal(h.sources.length, 2);
  assert.equal(h.player.timelineAnchor.ptsUs, 1040000);
  h.player.close();
});

test('the first fresh burst after an underrun reanchors without dropping its first two blocks', async () => {
  const h = harness();
  await h.push();
  h.clock.advance(1000);
  h.contexts[0].currentTime = 2;
  await h.push(1020000);
  await h.push(1040000);
  await h.push(1060000);
  assert.equal(h.sources[0].stopped, 1);
  assert.equal(h.sources.length, 4);
  assert.ok(h.sources[1].starts[0].at >= 2.02);
  assert.deepEqual(h.drops, []);
  assert.equal(h.released, 4);
  h.player.close();
});

test('100 ms AAC packetization bursts retain all blocks with bounded reservations at each manual delay', async () => {
  for (const manualDelayMs of [0, 100, 300]) {
    const h = harness();
    await h.player.resume();
    h.player.setDelayMs(manualDelayMs);
    h.outputFrames = 1024;
    const blockMs = 1024 / 48;
    const periodMs = blockMs * 5;
    let peakSources = 0;
    for (let burst = 0; burst < 282; burst += 1) {
      const arrivalMs = 1000 + burst * periodMs + (burst % 7 === 6 ? 12 : 0);
      h.clock.advance(arrivalMs - h.nowMs);
      const context = h.contexts[0];
      context.currentTime = arrivalMs / 1000;
      for (const source of h.sources) {
        const start = source.starts[0];
        if (source.onended && start.at + source.buffer.duration - start.offset <= context.currentTime) source.onended();
      }
      for (let frame = 0; frame < 5; frame += 1) {
        const sequence = burst * 5 + frame;
        await h.push(Math.round(sequence * blockMs * 1000), 'aac', sequence * 1024);
      }
      peakSources = Math.max(peakSources, h.player.getMetrics().scheduledSources);
      assert.ok(h.player.getMetrics().scheduledLeadMs <= manualDelayMs + 60 + 120);
      assert.ok(h.player.getMetrics().targetBufferMs >= 20 && h.player.getMetrics().targetBufferMs <= 60);
    }
    assert.equal(h.outputs, 1410, `all 46.875 AAC blocks/s scheduled at manual delay ${manualDelayMs}`);
    assert.deepEqual(h.drops, []);
    assert.ok(peakSources <= 24);
    assert.equal(h.released, 1410);
    h.player.close();
  }
});

test('235 ms PES bursts submit all eleven AAC blocks through the fixed lead budget for 30 seconds', async () => {
  for (const initialBufferMs of [20, 60]) {
    for (const manualDelayMs of [0, 100, 300]) {
      const h = harness();
      await h.player.resume();
      h.player.setDelayMs(manualDelayMs);
      h.outputFrames = 1024;
      const blockUs = 1024 / 48000 * 1000000;
      const burstMs = blockUs * 11 / 1000;
      const tasks = [];
      let maximumLead = 0;
      let maximumSources = 0;
      let observedWait = false;
      await h.push(0, 'aac', 0);
      if (initialBufferMs === 60) {
        for (let sample = 1; sample <= 4; sample += 1) h.player.playbackDelay.observe(1000 + sample * 45, sample * 20000);
      }
      h.onTick = () => {
        const metrics = h.player.getMetrics();
        maximumLead = Math.max(maximumLead, metrics.scheduledLeadMs);
        maximumSources = Math.max(maximumSources, metrics.scheduledSources);
        observedWait ||= metrics.playoutWaiters > 0;
        assert.ok(metrics.scheduledLeadMs <= manualDelayMs + metrics.targetBufferMs + 121);
        assert.ok(metrics.pendingInputs <= 24);
        assert.ok(metrics.pendingCodecOutputs <= 12);
        assert.ok(metrics.scheduledSources <= 64);
      };
      for (let burst = 0; burst < 128; burst += 1) {
        for (let frame = burst ? 0 : 1; frame < 11; frame += 1) {
          const sequence = burst * 11 + frame;
          tasks.push(h.push(Math.round(sequence * blockUs), 'aac', sequence * 1024));
        }
        await flush();
        h.onTick();
        await advancePlayout(h, burstMs);
      }
      await Promise.all(tasks);
      assert.equal(h.chunks.length, 1408);
      assert.equal(h.outputs, 1408, `all 46.875 blocks/s with initial buffer ${initialBufferMs}, manual ${manualDelayMs}`);
      assert.deepEqual(h.drops, []);
      assert.equal(h.player.getMetrics().pendingInputs, 0);
      assert.equal(h.player.getMetrics().playoutWaiters, 0);
      assert.equal(h.contexts.length, 1);
      assert.ok(observedWait);
      assert.ok(maximumLead <= manualDelayMs + 181);
      assert.ok(maximumSources < 32);
      h.player.close();
    }
  }
});

test('a frozen playout clock times out its wait instead of deadlocking the input queue', async () => {
  const h = harness();
  await h.player.resume();
  h.outputFrames = 1024;
  const tasks = Array.from({ length: 6 }, (_, index) => h.push(Math.round(index * 1024 / 48000 * 1000000), 'aac', index));
  await flush();
  await flush();
  assert.equal(h.player.getMetrics().playoutWaiters, 1);
  h.clock.advance(160);
  await Promise.all(tasks);
  assert.equal(h.player.getMetrics().playoutWaiters, 0);
  assert.equal(h.player.getMetrics().pendingInputs, 0);
  assert.ok(h.drops.includes('webcodecs-audio-playout-backlog'));
  assert.equal(h.contexts[0].state, 'running');
  await h.push(0, 'aac', 0);
  assert.equal(h.decoders.at(-1).state, 'configured');
  assert.equal(h.contexts.length, 1);
  h.player.close();
});

test('8 kHz AAC keeps complete 128 ms access units with one-unit lead at zero and 300 ms manual delay', async () => {
  for (const manualDelayMs of [0, 300]) {
    const h = harness();
    h.player.setFormat(8000, 1);
    h.player.setDelayMs(manualDelayMs);
    h.outputFrames = 1024;
    h.outputSampleRate = 8000;
    await h.player.resume(8000);
    let maximumLead = 0;
    h.onTick = () => {
      const metrics = h.player.getMetrics();
      maximumLead = Math.max(maximumLead, metrics.scheduledLeadMs);
      assert.ok(metrics.scheduledLeadMs <= manualDelayMs + metrics.targetBufferMs + 129);
      assert.ok(metrics.scheduledSources <= 5);
      assert.ok(metrics.pendingInputs <= 24);
      assert.ok(metrics.pendingCodecOutputs <= 12);
    };
    for (let burst = 0; burst < 32; burst += 1) {
      const tasks = Array.from({ length: 4 }, (_, index) => h.push((burst * 4 + index) * 128000, 'aac', burst * 4 + index));
      await flush();
      await flush();
      assert.equal(h.chunks.length, burst * 4 + 1, 'only one full access unit fits before device progress');
      assert.equal(h.player.getMetrics().playoutWaiters, 1);
      await advancePlayout(h, 512);
      await Promise.all(tasks);
    }
    assert.equal(h.decoders[0].config.sampleRate, 8000);
    assert.equal(h.chunks.length, 128);
    assert.equal(h.outputs, 128, h.drops.join(', '));
    assert.deepEqual(h.drops, []);
    assert.equal(h.contexts.length, 1);
    assert.equal(h.player.getMetrics().pendingInputs, 0);
    assert.equal(h.player.getMetrics().playoutWaiters, 0);
    assert.ok(maximumLead <= manualDelayMs + 149);
    assert.ok(h.sources.every((source) => source.buffer.duration === 0.128));
    h.player.close();
  }
});

test('8 kHz access-unit waiting is canceled by media reset and close without old timer or output revival', async () => {
  for (const action of ['resetMedia', 'close']) {
    const h = harness();
    h.player.setFormat(8000, 1);
    h.player.setDelayMs(300);
    h.outputFrames = 1024;
    h.outputSampleRate = 8000;
    await h.player.resume(8000);
    await h.push(0, 'aac', 0);
    const oldDecoder = h.decoders[0];
    const waiting = h.push(128000, 'aac', 1);
    await flush();
    assert.equal(h.player.getMetrics().playoutWaiters, 1);
    const oldTimer = h.clock.callbacks()[0];
    h.player[action]();
    await waiting;
    assert.equal(h.sources[0].stopped, 1);
    assert.equal(h.player.getMetrics().playoutWaiters, 0);
    assert.equal(h.clock.size, 0);
    if (action === 'close') await h.player.resume(8000);
    await h.push(0, 'aac', 0);
    const currentDecoder = h.decoders.at(-1);
    oldTimer();
    oldDecoder.callbacks.output(h.data(128000, 1024));
    await advancePlayout(h, 160);
    assert.equal(currentDecoder.state, 'configured');
    assert.equal(h.contexts.length, action === 'close' ? 2 : 1);
    assert.deepEqual(h.drops, []);
    assert.equal(h.clock.size, 0);
    h.player.close();
  }
});

test('two complete 512 ms access units wait for device capacity without a 160 ms waveform limit', async () => {
  for (const manualDelayMs of [0, 300]) {
    const h = harness();
    h.player.setFormat(8000, 1);
    h.player.setDelayMs(manualDelayMs);
    h.outputFrames = 4096;
    h.outputSampleRate = 8000;
    await h.player.resume(8000);
    await h.push(0, 'aac', 0);
    const decoder = h.decoders[0];
    let completed = false;
    const waiting = h.push(512000, 'aac', 4096).then(() => { completed = true; });
    await flush();
    assert.equal(h.player.getMetrics().playoutWaiters, 1);
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0, 'waiting time does not age unsubmitted codec work');
    await advancePlayout(h, 500);
    assert.equal(completed, false);
    assert.equal(decoder.state, 'configured');
    assert.equal(h.chunks.length, 1);
    await advancePlayout(h, 12);
    await waiting;
    assert.equal(h.outputs, 2);
    assert.equal(h.chunks.length, 2);
    assert.equal(h.decoders.length, 1);
    assert.equal(h.contexts.length, 1);
    assert.deepEqual(h.drops, []);
    assert.ok(h.player.getMetrics().scheduledLeadMs <= manualDelayMs + 533);
    assert.ok(h.sources[1].starts[0].at >= h.sources[0].starts[0].at + 0.512);
    h.player.close();
  }
});

test('large-access-unit wait cancellation still isolates old timers after media reset and close', async () => {
  for (const action of ['resetMedia', 'close']) {
    const h = harness();
    h.player.setFormat(8000, 1);
    h.outputFrames = 4096;
    h.outputSampleRate = 8000;
    await h.player.resume(8000);
    await h.push(0, 'aac', 0);
    const waiting = h.push(512000, 'aac', 4096);
    await flush();
    const oldTimer = h.clock.callbacks()[0];
    await advancePlayout(h, 200);
    assert.equal(h.player.getMetrics().playoutWaiters, 1);
    h.player[action]();
    await waiting;
    assert.equal(h.player.getMetrics().playoutWaiters, 0);
    assert.equal(h.clock.size, 0);
    if (action === 'close') await h.player.resume(8000);
    await h.push(0, 'aac', 0);
    const currentDecoder = h.decoders.at(-1);
    oldTimer();
    await advancePlayout(h, 600);
    assert.equal(currentDecoder.state, 'configured');
    assert.equal(h.contexts.length, action === 'close' ? 2 : 1);
    assert.deepEqual(h.drops, []);
    assert.equal(h.clock.size, 0);
    h.player.close();
  }
});

test('media reset, close and decoder error cancel playout waiting and isolate a late timer', async () => {
  for (const action of ['resetMedia', 'close', 'error']) {
    const h = harness();
    await h.player.resume();
    h.outputFrames = 1024;
    const tasks = Array.from({ length: 6 }, (_, index) => h.push(Math.round(index * 1024 / 48000 * 1000000), 'aac', index));
    await flush();
    await flush();
    assert.equal(h.player.getMetrics().playoutWaiters, 1);
    const lateTimer = h.clock.callbacks()[0];
    if (action === 'error') h.decoders[0].callbacks.error(new Error('codec-failed'));
    else h.player[action]();
    await Promise.all(tasks);
    assert.equal(h.player.getMetrics().playoutWaiters, 0);
    assert.equal(h.clock.size, 0);
    if (action === 'close') await h.player.resume();
    await h.push(0, 'aac', 0);
    const current = h.decoders.at(-1);
    lateTimer();
    await advancePlayout(h, 500);
    assert.equal(current.state, 'configured');
    assert.equal(h.contexts.length, action === 'close' ? 2 : 1);
    assert.equal(h.player.getMetrics().pendingInputs, 0);
    assert.equal(h.clock.size, 0);
    h.player.close();
  }
});

test('slow continuous output cannot accumulate unbounded codec work even when decodeQueueSize is zero', async () => {
  const h = harness();
  await h.player.resume();
  h.swallowOutput = true;
  let maximumPending = 0;
  for (let index = 0; index < 200; index += 1) {
    await advancePlayout(h, 20);
    await h.push(index * 20000);
    if (index % 5 === 4) {
      const timestamp = h.player.codecSubmissions.keys().next().value;
      if (timestamp !== undefined) h.output(timestamp);
    }
    const metrics = h.player.getMetrics();
    maximumPending = Math.max(maximumPending, metrics.pendingCodecOutputs);
    assert.ok(metrics.pendingCodecOutputs <= 12);
    assert.ok(metrics.oldestCodecOutputMs <= 500);
    assert.ok(metrics.codecOutputSpanMs <= 240);
    assert.equal(h.decoders.at(-1).decodeQueueSize, 0);
  }
  assert.equal(maximumPending, 12);
  assert.ok(h.drops.includes('webcodecs-audio-codec-output-backlog'));
  assert.ok(h.decoders.length > 5);
  assert.equal(h.contexts.length, 1);
  const outputs = h.outputs;
  h.swallowOutput = false;
  await h.push(4000000);
  assert.equal(h.outputs, outputs + 1);
  assert.equal(h.contexts[0].state, 'running');
  h.player.close();
});

test('the oldest submitted block stays watched despite later outputs, and unmatched output cannot reanchor sound', async () => {
  const h = harness();
  await h.player.resume();
  h.swallowOutput = true;
  for (let index = 0; index < 8; index += 1) await h.push(index * 1000);
  const decoder = h.decoders[0];
  for (let output = 0; output < 4; output += 1) {
    await advancePlayout(h, 100);
    const timestamp = [...h.player.codecSubmissions.keys()].at(-1);
    h.output(timestamp);
  }
  assert.equal(h.player.getMetrics().oldestCodecOutputMs, 400);
  const sources = h.sources.length;
  h.output(99999999);
  assert.equal(h.sources.length, sources);
  assert.ok(h.drops.includes('webcodecs-audio-unmatched-output'));
  await advancePlayout(h, 100);
  assert.equal(decoder.state, 'closed');
  assert.ok(h.drops.includes('webcodecs-audio-output-stalled'));
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  h.swallowOutput = false;
  await h.push(0);
  decoder.callbacks.output(h.data(12345));
  assert.equal(h.decoders.at(-1).state, 'configured');
  assert.equal(h.contexts.length, 1);
  h.player.close();
});

test('AAC sample-clock outputs match rounded 90 kHz source timestamps without accumulating pending codec work', async () => {
  const h = harness();
  await h.player.resume();
  h.swallowOutput = true;
  const baseTicks = 130080;
  const firstPtsUs = Math.round(baseTicks * 1000000 / 90000);
  for (let index = 0; index < 128; index += 1) {
    const inputPtsUs = Math.round((baseTicks + index * 1920) * 1000000 / 90000);
    const outputPtsUs = firstPtsUs + Math.floor(index * 1024 * 1000000 / 48000);
    assert.ok(Math.abs(inputPtsUs - outputPtsUs) <= 1);
    await h.push(inputPtsUs, 'aac', index);
    h.output(outputPtsUs, 1024);
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
    await advancePlayout(h, 1024 * 1000 / 48000);
  }
  assert.equal(h.outputs, 128);
  assert.deepEqual(h.drops, []);
  assert.equal(h.clock.size, 0);
  assert.equal(h.contexts.length, 1);
  h.player.close();
});

test('AAC source PTS gaps and sample-sequence jumps keep the continuous codec clock mapped to the source clock', async () => {
  for (const manualDelayMs of [0, 300]) {
    const h = harness();
    await h.player.resume();
    h.player.setDelayMs(manualDelayMs);
    h.swallowOutput = true;
    const blockUs = 1024 * 1000000 / 48000;
    let sourceIndex = 0;
    let previousPtsUs = 1000000;
    for (let index = 0; index < 256; index += 1) {
      if (index) sourceIndex += index % 13 === 0 ? 2 : 1;
      const sourcePtsUs = 1000000 + Math.round(sourceIndex * blockUs);
      if (index) await advancePlayout(h, (sourcePtsUs - previousPtsUs) / 1000);
      await h.push(sourcePtsUs, 'aac', sourceIndex * 1024);
      h.output(1000000 + Math.floor(index * blockUs), 1024);
      assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
      const anchor = h.player.clockAnchors.at(-1);
      assert.ok(Math.abs(anchor.ptsUs - sourcePtsUs) <= 1);
      h.contexts[0].outputTimestamp = { contextTime: anchor.contextTime + 0.005, performanceTime: h.nowMs };
      assert.ok(Math.abs(h.player.getPlaybackClock().ptsUs - sourcePtsUs - 5000) <= 1);
      previousPtsUs = sourcePtsUs;
    }
    assert.equal(h.outputs, 256);
    assert.equal(h.decoders.length, 1);
    assert.deepEqual(h.drops, []);
    assert.equal(h.contexts.length, 1);
    h.player.close();
  }
});

test('AAC unknown, invalid and duplicate outputs do not consume source submissions or extend their watchdog', async () => {
  const h = harness();
  await h.player.resume();
  h.swallowOutput = true;
  await h.push(1000000, 'aac', 0);
  h.output(9990000, 1024);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 1);
  assert.equal(h.player.aacOutputAnchor, null);
  h.output(1000000, 1024);
  await advancePlayout(h, 42.667);
  await h.push(1042667, 'aac', 2048);
  const originalTimer = h.clock.callbacks()[0];
  h.output(1000000, 1024);
  h.output(1099999, 1024);
  h.output(NaN, 1024);
  const invalid = h.data(1021333, 1024);
  invalid.sampleRate = 0;
  h.decoders[0].callbacks.output(invalid);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 1);
  assert.equal(h.clock.callbacks()[0], originalTimer);
  assert.equal(h.player.aacOutputAnchor.lastPtsUs, 1000000);
  h.output(1021333, 1024);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  assert.equal(h.player.clockAnchors.at(-1).ptsUs, 1042667);
  assert.equal(h.outputs, 2);
  assert.equal(h.drops.filter((reason) => reason === 'webcodecs-audio-unmatched-output').length, 5);
  assert.equal(h.clock.size, 0);
  h.player.close();
});

test('AAC media reset and decoder replacement reanchor low source PTS while isolating old sample clocks', async () => {
  for (const action of ['resetMedia', 'releaseDecoder', 'close']) {
    const h = harness();
    await h.player.resume();
    h.swallowOutput = true;
    await h.push(1000000, 'aac', 1024);
    h.output(1000000, 1024);
    await h.push(1042667, 'aac', 3072);
    const oldDecoder = h.decoders[0];
    const oldTimer = h.clock.callbacks()[0];
    h.player[action]();
    assert.equal(h.player.aacOutputAnchor, null);
    if (action === 'close') await h.player.resume();
    await h.push(0, 'aac', 0);
    const currentDecoder = h.decoders.at(-1);
    oldDecoder.callbacks.output(h.data(1021333, 1024));
    oldTimer();
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 1);
    currentDecoder.callbacks.output(h.data(0, 1024));
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
    assert.equal(h.player.aacOutputAnchor.lastPtsUs, 0);
    assert.equal(h.player.clockAnchors.at(-1).ptsUs, 0);
    assert.equal(currentDecoder.state, 'configured');
    assert.deepEqual(h.drops, []);
    assert.equal(h.contexts.length, action === 'close' ? 2 : 1);
    h.player.close();
  }
});

test('an epoch restart on the continuing host clock reanchors 44 s to 60 s without reusing old reservations', async () => {
  for (const manualDelayMs of [0, 300]) {
    const h = harness();
    await h.player.resume();
    h.player.setDelayMs(manualDelayMs);
    h.outputFrames = 1024;
    const blockUs = 1024 * 1000000 / 48000;
    const oldInputs = Array.from({ length: 11 }, (_, index) => h.push(44000000 + Math.round(index * blockUs), 'aac', index));
    await flush();
    await flush();
    const oldDecoder = h.decoders[0];
    const oldSources = [...h.sources];
    const oldTimer = h.clock.callbacks()[0];
    assert.equal(h.player.getMetrics().playoutWaiters, 1);
    h.player.resetMedia();
    await Promise.all(oldInputs);
    assert.ok(oldSources.every((source) => source.stopped === 1));
    const before = h.outputs;
    const newInputs = Array.from({ length: 11 }, (_, index) => h.push(60000000 + Math.round(index * blockUs), 'aac', index));
    await flush();
    oldDecoder.callbacks.output(h.data(44000000, 1024));
    oldTimer();
    await advancePlayout(h, 11 * blockUs / 1000);
    await Promise.all(newInputs);
    assert.equal(h.outputs - before, 11);
    assert.equal(h.player.getMetrics().pendingInputs, 0);
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
    assert.ok(h.player.clockAnchors.every((anchor) => anchor.ptsUs >= 60000000));
    assert.deepEqual(h.drops, []);
    assert.equal(h.contexts.length, 1);
    h.player.close();
  }
});

test('a reconnect catch-up flush keeps fresh audio instead of retaining a full stale input queue', async () => {
  // First 54 AAC ingress times from the real source-restart trace. Its first
  // 981 ms of source media arrived in 446 ms before normal 235 ms PES cadence.
  const startupArrivalMs = [0, 0.5, 0.5, 0.5, 8.2, 8.3, 8.3, 8.3, 14.7, 14.7, 20.1, 29, 29, 29.1,
    37.4, 37.4, 37.5, 43.3, 43.4, 43.4, 43.4, 43.4, 62.3, 62.3, 62.3, 70.5, 70.8, 70.8,
    70.9, 70.9, 70.9, 70.9, 277.7, 278.4, 278.4, 278.6, 278.6, 278.6, 278.6, 279.2,
    279.2, 279.5, 279.7, 446, 446.2, 446.5, 446.5, 446.8, 447.2, 447.2, 447.2, 447.2, 447.2, 447.5];
  for (const manualDelayMs of [0, 300]) {
    const h = harness();
    await h.player.resume();
    h.player.setDelayMs(manualDelayMs);
    h.outputFrames = 1024;
    const blockUs = 1024 * 1000000 / 48000;
    const arrivals = new Map();
    const tasks = [];
    let maximumNormalWaitMs = 0;
    let now = 0;
    let sourceIndex = 0;
    h.onDecode = (chunk) => {
      const waitMs = h.nowMs - arrivals.get(chunk.timestamp);
      if (h.nowMs > 2000) maximumNormalWaitMs = Math.max(maximumNormalWaitMs, waitMs);
    };
    h.onTick = () => {
      const metrics = h.player.getMetrics();
      assert.ok(metrics.pendingInputs <= 24);
      assert.ok(metrics.pendingCodecOutputs <= 12);
      assert.ok(metrics.scheduledSources <= 64);
      assert.ok(metrics.scheduledLeadMs <= manualDelayMs + metrics.targetBufferMs + 121);
    };
    for (const arrivalMs of startupArrivalMs) {
      await advancePlayout(h, arrivalMs - now);
      now = arrivalMs;
      const ptsUs = 60000000 + Math.round(sourceIndex * blockUs);
      arrivals.set(ptsUs, h.nowMs);
      tasks.push(h.push(ptsUs, 'aac', sourceIndex++));
      await flush();
    }
    assert.ok(h.drops.includes('webcodecs-audio-queue-catchup'));
    const retiredDecoder = h.decoders[0];
    const countBeforeLateOutput = h.outputs;
    retiredDecoder.callbacks.output(h.data(60000000, 1024));
    assert.equal(h.outputs, countBeforeLateOutput);
    assert.equal(h.contexts.length, 1);
    for (let burst = 0; burst < 40; burst += 1) {
      const arrivalMs = 679 + burst * 11 * blockUs / 1000;
      await advancePlayout(h, arrivalMs - now);
      now = arrivalMs;
      for (let index = 0; index < 11; index += 1) {
        const ptsUs = 60000000 + Math.round(sourceIndex * blockUs);
        arrivals.set(ptsUs, h.nowMs);
        tasks.push(h.push(ptsUs, 'aac', sourceIndex++));
      }
      await flush();
    }
    await advancePlayout(h, 235);
    await Promise.all(tasks);
    assert.equal(h.player.getMetrics().pendingInputs, 0);
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
    assert.ok(maximumNormalWaitMs <= 160, `normal submit wait was ${maximumNormalWaitMs} ms`);
    assert.ok(h.drops.filter((reason) => reason === 'webcodecs-audio-queue-catchup').length <= 48);
    assert.ok(!h.drops.includes('webcodecs-audio-queue-full'));
    assert.ok(!h.drops.includes('webcodecs-audio-playout-backlog'));
    assert.ok(!h.drops.includes('webcodecs-audio-unmatched-output'));
    assert.equal(h.contexts.length, 1);
    h.player.close();
  }
});

test('regular mux packetization and codec output batching do not masquerade as network jitter', async () => {
  const h = harness();
  await h.player.resume();
  h.outputFrames = 1024;
  const blockUs = 1024 / 48000 * 1000000;
  for (let burst = 0; burst < 30; burst += 1) {
    h.clock.advance(burst ? blockUs * 5 / 1000 : 0);
    h.contexts[0].currentTime = h.nowMs / 1000;
    for (const source of h.sources) if (source.onended) source.onended();
    for (let frame = 0; frame < 5; frame += 1) await h.push(Math.round((burst * 5 + frame) * blockUs), 'aac');
  }
  assert.equal(h.player.getMetrics().targetBufferMs, 20, 'steady 106.7 ms packetization is not jitter');
  h.player.resetMedia();
  h.swallowOutput = true;
  for (let frame = 0; frame < 5; frame += 1) {
    if (frame) { h.clock.advance(blockUs / 1000); h.contexts[0].currentTime = h.nowMs / 1000; }
    await h.push(Math.round(frame * blockUs), 'aac');
  }
  h.clock.advance(15);
  h.contexts[0].currentTime = h.nowMs / 1000;
  for (let frame = 0; frame < 5; frame += 1) h.output(Math.round(frame * blockUs), 1024);
  assert.equal(h.player.getMetrics().targetBufferMs, 20, 'only ingress time trains adaptive buffering');
  assert.equal(h.outputs, 155);
  assert.deepEqual(h.drops, []);
  h.player.close();
});

test('established playback discards codec work older than 120 ms instead of replaying the old burst', async () => {
  const h = harness();
  await h.player.resume();
  await h.push();
  h.swallowOutput = true;
  await h.push(1020000);
  await h.push(1040000);
  h.clock.advance(130);
  h.contexts[0].currentTime += 0.13;
  h.output(1020000);
  h.output(1040000);
  assert.equal(h.sources.length, 1);
  assert.equal(h.drops.filter((reason) => reason === 'webcodecs-audio-output-backlog').length, 2);
  h.swallowOutput = false;
  h.clock.advance(20);
  h.contexts[0].currentTime += 0.02;
  await h.push(1060000);
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[0].stopped, 1);
  assert.equal(h.outputs, 2);
  h.player.close();
});

test('the output safety budget rejects excess reservations while keeping its playable front intact', async () => {
  const h = harness();
  await h.player.resume();
  h.outputFrames = 1024;
  const blockUs = 1024 / 48000 * 1000000;
  // Exercise output safety independently of the earlier encoded submission pacing.
  for (let index = 0; index < 10; index += 1) h.player.playAudioData(h.data(Math.round(index * blockUs), 1024));
  assert.equal(h.outputs, 5);
  assert.equal(h.sources.length, 5);
  assert.ok(h.sources.every((source) => source.stopped === 0));
  assert.equal(h.drops.filter((reason) => reason === 'webcodecs-audio-playback-backlog-full').length, 5);
  assert.ok(h.player.getMetrics().scheduledLeadMs <= 140);
  h.clock.advance(blockUs * 10 / 1000);
  h.contexts[0].currentTime = h.nowMs / 1000;
  for (const source of h.sources) source.onended();
  for (let index = 10; index < 15; index += 1) h.player.playAudioData(h.data(Math.round(index * blockUs), 1024));
  assert.equal(h.outputs, 10);
  assert.ok(h.player.getMetrics().scheduledLeadMs <= 140);
  assert.equal(h.player.getMetrics().scheduledSources, 5);
  assert.equal(h.released, 15);
  h.player.close();
});

test('real decodeQueueSize pauses submission and only the low-water dequeue event resumes it', async () => {
  const h = harness('suspended');
  h.holdDecode = true;
  for (let index = 0; index < 8; index += 1) await h.push(1000000 + index * 20000);
  let finished = false;
  const pending = h.push(1160000).then(() => { finished = true; });
  await flush();
  assert.equal(h.chunks.length, 8);
  assert.equal(finished, false);
  const decoder = h.decoders[0];
  decoder.decodeQueueSize = 5;
  decoder.ondequeue();
  await flush();
  assert.equal(finished, false);
  decoder.decodeQueueSize = 4;
  decoder.ondequeue();
  await pending;
  assert.equal(h.chunks.length, 9);
  assert.equal(decoder.decodeQueueSize, 5);
  assert.equal(h.clock.size, 1, 'the capacity timer is cancelled while pending codec output remains watched');
  h.player.close();
  assert.equal(h.clock.size, 0);
});

test('close settles a backpressure waiter, while an old dequeue/output cannot revive playback', async () => {
  const h = harness('suspended');
  h.holdDecode = true;
  for (let index = 0; index < 8; index += 1) await h.push(1000000 + index * 20000);
  const oldDecoder = h.decoders[0];
  const oldDequeue = oldDecoder.ondequeue;
  const waiting = h.push(1160000);
  await flush();
  h.player.close();
  assert.equal(h.clock.size, 0);
  await waiting;
  h.holdDecode = false;
  await h.player.resume();
  await h.push(2000000);
  oldDecoder.decodeQueueSize = 0;
  oldDequeue();
  oldDecoder.callbacks.output(h.data());
  oldDecoder.callbacks.error(new Error('obsolete-error'));
  assert.equal(h.chunks.length, 9);
  assert.equal(h.outputs, 1);
  assert.equal(h.released, 2);
  assert.equal(h.decoders[1].state, 'configured');
  assert.deepEqual(h.drops, []);
  h.clock.advance(200);
  assert.deepEqual(h.drops, []);
  assert.equal(h.decoders[1].state, 'configured');
  h.player.close();
});

test('a decoder that never dequeues times out after 160 ms and the next audio block recovers', async () => {
  const h = harness('suspended');
  h.holdDecode = true;
  for (let index = 0; index < 8; index += 1) await h.push(1000000 + index * 20000);
  const oldDecoder = h.decoders[0];
  const pending = h.push(1160000);
  await flush();
  assert.equal(h.clock.size, 2);
  h.clock.advance(159);
  await flush();
  assert.equal(oldDecoder.state, 'configured');
  assert.equal(h.chunks.length, 8);
  h.clock.advance(1);
  await pending;
  assert.equal(oldDecoder.state, 'closed');
  assert.equal(h.clock.size, 0);
  assert.equal(h.player.getMetrics().pendingInputs, 0);
  assert.deepEqual(h.drops, ['webcodecs-audio-decode-backlog']);
  h.holdDecode = false;
  await h.player.resume();
  await h.push(1180000);
  assert.equal(h.decoders.length, 2);
  assert.equal(h.outputs, 1);
  assert.equal(h.chunks.at(-1).timestamp, 1180000);
  h.player.close();
});

test('format replacement cancels the saturated decoder watchdog before configuring the new one', async () => {
  const h = harness('suspended');
  h.holdDecode = true;
  for (let index = 0; index < 8; index += 1) await h.push(1000000 + index * 20000);
  const pending = h.push(1160000);
  await flush();
  h.player.setFormat(44100, 1);
  await pending;
  assert.equal(h.clock.size, 0);
  h.holdDecode = false;
  await h.player.resume();
  await h.push(2000000);
  h.clock.advance(200);
  assert.equal(h.decoders[1].state, 'configured');
  assert.equal(h.decoders[1].config.sampleRate, 44100);
  assert.deepEqual(h.drops, []);
  h.player.close();
});

test('queue-zero codec output starvation recovers after 500 ms while preserving the unlocked context', async () => {
  const h = harness();
  await h.player.resume();
  h.swallowOutput = true;
  await h.push();
  const stalled = h.decoders[0];
  await advancePlayout(h, 480);
  assert.equal(stalled.decodeQueueSize, 0);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 1);
  assert.equal(h.player.getMetrics().outputStallMs, 480);
  h.clock.advance(19);
  assert.equal(stalled.state, 'configured');
  h.clock.advance(1);
  assert.equal(stalled.state, 'closed');
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  assert.equal(h.player.getMetrics().outputStallMs, 0);
  assert.deepEqual(h.drops, ['webcodecs-audio-output-stalled']);
  h.swallowOutput = false;
  await h.push(1500000);
  assert.equal(h.decoders.length, 2);
  assert.equal(h.outputs, 1);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].state, 'running');
  assert.equal(h.clock.size, 0);
  h.player.close();
});

test('closed, reset and codec-replaced output watchdogs cannot release a newer decoder', async () => {
  for (const change of ['close', 'resetMedia', 'codec']) {
    const h = harness();
    await h.player.resume();
    h.swallowOutput = true;
    await h.push();
    const oldWatchdog = h.clock.callbacks()[0];
    if (change !== 'codec') h.player[change]();
    h.swallowOutput = false;
    await h.push(change === 'codec' ? 1020000 : 0, change === 'codec' ? 'aac' : 'opus');
    const current = h.decoders.at(-1);
    oldWatchdog();
    h.clock.advance(500);
    assert.equal(current.state, 'configured');
    assert.deepEqual(h.drops, []);
    assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
    assert.equal(h.outputs, 1);
    assert.equal(h.clock.size, 0);
    h.player.close();
  }
});

test('output before 500 ms permits codec priming; synchronous decode errors leave no phantom watchdog', async () => {
  const h = harness();
  h.swallowOutput = true;
  await h.push();
  h.clock.advance(499);
  h.output(1000000);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  assert.equal(h.clock.size, 0);
  h.clock.advance(1000);
  assert.deepEqual(h.drops, []);
  h.decodeError = true;
  await h.push(1020000);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  assert.equal(h.clock.size, 0);
  h.clock.advance(500);
  assert.deepEqual(h.drops, ['decode-failed']);
  h.decodeError = false;
  h.swallowOutput = false;
  await h.push(1040000);
  assert.equal(h.player.getMetrics().pendingCodecOutputs, 0);
  h.player.close();
});

test('the JavaScript input queue stays at 24 during a slow support probe, and stale support is harmless', async () => {
  const h = harness();
  const support = deferred();
  h.setSupport(() => support.promise);
  const pending = Array.from({ length: 25 }, (_, index) => h.push(1000000 + index * 20000));
  await flush();
  assert.equal(h.player.pendingFrames, 24);
  assert.deepEqual(h.drops, ['webcodecs-audio-queue-full']);
  h.player.close();
  h.setSupport(async () => ({ supported: true }));
  await h.push(2000000);
  support.resolve({ supported: true });
  await Promise.all(pending);
  assert.equal(h.decoders.length, 1);
  assert.equal(h.chunks.length, 1);
  assert.equal(h.player.pendingFrames, 0);
  h.player.close();
});

test('a format change cancels a pending support probe without closing the gesture-unlocked context', async () => {
  const h = harness();
  await h.player.resume();
  const support = deferred();
  h.setSupport(() => support.promise);
  const pending = h.push();
  await flush();
  h.player.setFormat(44100, 1);
  h.setSupport(async () => ({ supported: true }));
  await h.push(2000000);
  support.resolve({ supported: true });
  await pending;
  assert.equal(h.decoders.length, 1);
  assert.equal(h.decoders[0].config.sampleRate, 44100);
  assert.equal(h.contexts[0].state, 'running');
  assert.equal(h.chunks.length, 1);
  h.player.close();
});

test('codec replacement stops reservations; a source.start failure still releases AudioData', async () => {
  const h = harness();
  await h.push();
  await h.push(1020000, 'aac');
  assert.equal(h.sources[0].stopped, 1);
  assert.equal(h.decoders[0].state, 'closed');
  h.startError = true;
  await h.push(1040000, 'aac');
  assert.equal(h.released, 3);
  assert.ok(h.drops.includes('start-failed'));
  assert.equal(h.sources.at(-1).disconnected, 1);
  assert.equal(h.player.scheduledSources.size, 1);
  h.player.close();
});
