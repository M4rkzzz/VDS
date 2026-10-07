const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadPlayer(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', source)(module, module.exports, (request) => (
    request.startsWith('./') ? loadPlayer(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), request + '.ts'))) : require(request)
  ));
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(kind) {
  const harness = { decoders: [], chunks: [], states: [], drops: [], outputs: 0, released: 0, contexts: [] };
  let probe = async () => ({ supported: true });
  harness.setProbe = (nextProbe) => { probe = nextProbe; };
  harness.makeOutput = () => ({
    timestamp: harness.chunks.at(-1)?.timestamp || 0,
    displayWidth: 16,
    displayHeight: 16,
    sampleRate: 48000,
    numberOfChannels: 2,
    numberOfFrames: 2,
    copyTo: (destination) => destination.fill(0),
    close: () => { harness.released += 1; }
  });

  class Decoder {
    static isConfigSupported(config) { return probe(config); }
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.state = 'unconfigured';
      harness.decoders.push(this);
    }
    configure(config) {
      assert.notEqual(this.state, 'closed', 'cannot configure a closed decoder');
      this.config = config;
      this.state = 'configured';
    }
    decode(chunk) {
      assert.equal(this.state, 'configured', 'cannot decode using a closed or unconfigured decoder');
      harness.chunks.push({ decoder: this, ...chunk.init });
      this.callbacks.output(harness.makeOutput());
    }
    close() {
      assert.notEqual(this.state, 'closed', 'WebCodecs close must not be called twice');
      this.state = 'closed';
    }
    fail() {
      this.state = 'closed';
      this.callbacks.error(new Error('simulated decoder failure'));
    }
  }

  class Chunk {
    constructor(init) { this.init = init; }
  }

  class Context {
    constructor() {
      this.state = 'running';
      this.startedAtMs = performance.now();
      this.destination = {};
      harness.contexts.push(this);
    }
    get currentTime() { return (performance.now() - this.startedAtMs) / 1000; }
    createBuffer(channels, frames, rate) {
      return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() { return { connect() {}, start() {}, stop() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    close() {
      assert.notEqual(this.state, 'closed');
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  global.window = {
    setTimeout, clearTimeout,
    VideoDecoder: Decoder,
    AudioDecoder: Decoder,
    EncodedVideoChunk: Chunk,
    EncodedAudioChunk: Chunk,
    AudioContext: Context
  };
  const diagnostics = {
    onState: (state) => harness.states.push(state),
    onDroppedFrame: (reason) => harness.drops.push(reason),
    onDroppedBlock: (reason) => harness.drops.push(reason),
    onDecodedFrame: () => { harness.outputs += 1; },
    onDecodedBlock: () => { harness.outputs += 1; },
    onPayloadFormat() {}
  };
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage() {} }) };
  harness.player = kind === 'video'
    ? new (loadPlayer('vds_web/src/webcodecs-player.ts').WebCodecsVideoPlayer)(canvas, diagnostics)
    : new (loadPlayer('vds_web/src/webcodecs-audio-player.ts').WebCodecsAudioPlayer)(diagnostics);
  harness.header = (sequence = 1, keyframe = true) => ({
    protocol: 'vds-media-encoded-v1', type: 'frame', streamType: kind,
    codec: kind === 'video' ? 'h264' : 'opus',
    payloadFormat: kind === 'video' ? 'annexb' : 'raw',
    timestampUs: sequence * 20000, sequence, keyframe, config: keyframe
  });
  harness.payload = kind === 'video'
    ? new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x65, 0x88]).buffer
    : new Uint8Array([1, 2, 3]).buffer;
  return harness;
}

async function testCloseDuringSupportProbe(kind) {
  const h = createHarness(kind);
  const support = deferred();
  const started = deferred();
  h.setProbe(() => { started.resolve(); return support.promise; });
  const pending = h.player.pushFrame(h.header(), h.payload);
  const queued = h.player.pushFrame(h.header(2, false), h.payload);
  await started.promise;
  h.player.close();
  h.player.close();
  support.resolve({ supported: true });
  await Promise.all([pending, queued]);
  assert.equal(h.decoders.length, 0, `${kind}: closed support probe must not create a decoder`);
  assert.equal(h.outputs, 0);
  assert.deepEqual(h.states, []);
  assert.deepEqual(h.drops, []);
  h.setProbe(async () => ({ supported: true }));
  await h.player.pushFrame(h.header(3), h.payload);
  assert.equal(h.outputs, 1, `${kind}: player can be reused after close`);
  h.player.close();
}

async function testOldProbeCannotAffectNewSession(kind) {
  const h = createHarness(kind);
  const support = deferred();
  const started = deferred();
  h.setProbe(() => { started.resolve(); return support.promise; });
  const pending = h.player.pushFrame(h.header(), h.payload);
  await started.promise;
  h.player.close();
  h.setProbe(async () => ({ supported: true }));
  await h.player.pushFrame(h.header(2), h.payload);
  const currentDecoder = h.decoders[0];
  support.resolve({ supported: false });
  await pending;
  await h.player.pushFrame(h.header(3, false), h.payload);
  assert.equal(h.decoders.length, 1, `${kind}: stale probe must not replace the new decoder`);
  assert.equal(currentDecoder.state, 'configured');
  assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [40000, 60000]);
  assert.deepEqual(h.drops, []);
  h.player.close();
}

async function testConcurrentFramesConfigureOnce(kind) {
  const h = createHarness(kind);
  const support = deferred();
  const started = deferred();
  let probes = 0;
  h.setProbe(() => { probes += 1; started.resolve(); return support.promise; });
  const frames = [1, 2, 3].map((sequence) => h.player.pushFrame(h.header(sequence, sequence === 1), h.payload));
  await started.promise;
  assert.equal(probes, 1);
  support.resolve({ supported: true });
  await Promise.all(frames);
  assert.equal(h.decoders.length, 1, `${kind}: concurrent initial frames must share one decoder`);
  assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [20000, 40000, 60000]);
  assert.equal(h.outputs, 3);
  assert.equal(h.released, 3);
  assert.deepEqual(h.drops, []);
  h.player.close();
}

async function testClosedDecoderRecovery(kind, notifyError) {
  const h = createHarness(kind);
  await h.player.pushFrame(h.header(), h.payload);
  const oldDecoder = h.decoders[0];
  if (notifyError) oldDecoder.fail();
  else oldDecoder.close();
  if (kind === 'video' && notifyError) {
    await h.player.pushFrame(h.header(2, false), h.payload);
    assert.equal(h.chunks.length, 1, 'video must wait for a new keyframe after a fatal error');
  }
  await h.player.pushFrame(h.header(3), h.payload);
  assert.equal(h.decoders.length, 2, `${kind}: failed decoder must be replaced`);
  assert.equal(h.outputs, 2);
  assert.equal(h.decoders[1].state, 'configured');
  const released = h.released;
  const dropCount = h.drops.length;
  oldDecoder.callbacks.output(h.makeOutput());
  oldDecoder.callbacks.error(new Error('late callback from previous decoder'));
  assert.equal(h.outputs, 2, `${kind}: old decoder output must not render/play`);
  assert.equal(h.released, released + 1, `${kind}: old output must release its frame/data`);
  assert.equal(h.drops.length, dropCount, `${kind}: old error must not affect new playback`);
  assert.equal(h.decoders[1].state, 'configured');
  h.player.close();
  h.player.close();
  h.decoders[1].callbacks.output(h.makeOutput());
  assert.equal(h.outputs, 2, `${kind}: output after close must be released without playback`);
  assert.ok(h.contexts.every((context) => context.state === 'closed'));
}

async function testPendingQueueIsBounded(kind) {
  const h = createHarness(kind);
  const support = deferred();
  const started = deferred();
  h.setProbe(() => { started.resolve(); return support.promise; });
  const limit = kind === 'video' ? h.player.getMetrics().inputQueueCapacity : 24;
  const pending = [h.player.pushFrame(h.header(), h.payload)];
  await started.promise;
  for (let sequence = 2; sequence <= limit + 1; sequence += 1) {
    pending.push(h.player.pushFrame(h.header(sequence, false), h.payload));
  }
  support.resolve({ supported: true });
  await Promise.all(pending);
  assert.ok(h.drops.includes(`webcodecs-${kind}-queue-full`));
  assert.equal(h.chunks.length, kind === 'video' ? 0 : limit);
  h.setProbe(async () => ({ supported: true }));
  await h.player.pushFrame(h.header(limit + 2), h.payload);
  assert.equal(h.chunks.at(-1).timestamp, (limit + 2) * 20000, `${kind}: queue can recover`);
  h.player.close();
}

async function testOverflowingVideoKeyframeStartsNewQueue() {
  const h = createHarness('video');
  const support = deferred();
  const started = deferred();
  h.setProbe(() => { started.resolve(); return support.promise; });
  const limit = h.player.getMetrics().inputQueueCapacity;
  const oldFrames = [h.player.pushFrame(h.header(), h.payload)];
  await started.promise;
  for (let sequence = 2; sequence <= limit; sequence += 1) {
    oldFrames.push(h.player.pushFrame(h.header(sequence, false), h.payload));
  }
  h.setProbe(async () => ({ supported: true }));
  await h.player.pushFrame(h.header(limit + 1), h.payload);
  await h.player.pushFrame(h.header(limit + 2, false), h.payload);
  support.resolve({ supported: true });
  await Promise.all(oldFrames);
  assert.deepEqual(h.chunks.map((chunk) => chunk.timestamp), [(limit + 1) * 20000, (limit + 2) * 20000]);
  assert.equal(h.decoders.length, 1, 'the overflowing keyframe can immediately recover video');
  assert.deepEqual(h.drops, ['webcodecs-video-queue-full']);
  h.player.close();
}

async function main() {
  const previousWindow = global.window;
  try {
    for (const kind of ['video', 'audio']) {
      await testCloseDuringSupportProbe(kind);
      await testOldProbeCannotAffectNewSession(kind);
      await testConcurrentFramesConfigureOnce(kind);
      await testClosedDecoderRecovery(kind, true);
      await testClosedDecoderRecovery(kind, false);
      await testPendingQueueIsBounded(kind);
    }
    await testOverflowingVideoKeyframeStartsNewQueue();
    console.log('vds-web player lifecycle tests passed');
  } finally {
    global.window = previousWindow;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
