const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const AVC_CONFIG = [new Uint8Array([0x67, 0x64, 0, 0x28]), new Uint8Array([0x68, 0xee, 0x3c, 0x80])];
const HEVC_CONFIG = [new Uint8Array([0x40, 1, 0x80]), new Uint8Array([0x42, 1, 1, 1, 1, 1, 150]),
  new Uint8Array([0x44, 1, 0x80])];

function annexB(units, prefixSizes = []) {
  const bytes = new Uint8Array(units.reduce((sum, unit, index) => sum + (prefixSizes[index] || 4) + unit.length, 0));
  let offset = 0;
  units.forEach((unit, index) => {
    const prefix = prefixSizes[index] || 4;
    bytes[offset + prefix - 1] = 1;
    offset += prefix;
    bytes.set(unit, offset);
    offset += unit.length;
  });
  return bytes.buffer;
}

function lengthPrefixed(units) {
  const bytes = new Uint8Array(units.reduce((sum, unit) => sum + 4 + unit.length, 0));
  let offset = 0;
  const view = new DataView(bytes.buffer);
  for (const unit of units) {
    view.setUint32(offset, unit.length, false);
    offset += 4;
    bytes.set(unit, offset);
    offset += unit.length;
  }
  return bytes.buffer;
}

function picture(codec, size = 6) {
  const bytes = new Uint8Array(size).fill(0x55);
  bytes.set(codec === 'h264' ? [0x65, 0x88] : [0x26, 1, 0x80]);
  return bytes;
}

function harness() {
  const h = { allocations: [], chunks: [], decoders: [], drops: [], formats: [], probes: [], timers: new Map() };
  let timerId = 0;
  class ObservedUint8Array extends Uint8Array {
    constructor(first, ...rest) {
      super(first, ...rest);
      if (typeof first === 'number') h.allocations.push(first);
    }
  }
  class Decoder {
    static async isConfigSupported(config) {
      h.probes.push(config);
      return h.probe ? h.probe(config) : { supported: true };
    }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; h.decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { h.chunks.push(chunk.init); }
    close() { this.state = 'closed'; }
  }
  class Chunk {
    constructor(init) {
      // EncodedVideoChunk snapshots BufferSource at submission. Do the same
      // using the test realm, outside the observed preparation allocations.
      this.init = { ...init, bytes: new Uint8Array(init.data).slice() };
    }
  }
  const context = vm.createContext({
    ArrayBuffer, Uint8Array: ObservedUint8Array, Promise, Error, performance: { now: () => 1000 },
    window: { VideoDecoder: Decoder, EncodedVideoChunk: Chunk,
      setTimeout(callback, delay) { const id = ++timerId; h.timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { h.timers.delete(id); }, requestAnimationFrame() { return ++timerId; }, cancelAnimationFrame() {} }
  });
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, `../../vds_web/src/${name}.ts`), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    vm.runInContext(`(function(module, exports, require) { ${code}\n })`, context)(module, module.exports,
      relative => load(relative.replace(/^\.\//, '')));
    return module.exports;
  }
  h.player = new (load('webcodecs-player').WebCodecsVideoPlayer)({ width: 1, height: 1, getContext() { return null; } }, {
    onState() {}, onDecodedFrame() {}, onDroppedFrame(reason) { h.drops.push(reason); },
    onPayloadFormat(format) { h.formats.push(format); }
  });
  h.push = (payload, codec = 'h264', options = {}) => h.player.pushFrame({
    protocol: 'vds-media-encoded-v1', type: 'frame', streamType: 'video', codec, payloadFormat: 'annexb',
    timestampUs: 0, sequence: 0, keyframe: true, config: true, ...options
  }, payload);
  h.largeAllocations = minimum => h.allocations.filter(bytes => bytes >= minimum);
  return h;
}

test('Annex-B decoders receive the original AU without full-frame preparation copies', async () => {
  for (const codec of ['h264', 'h265']) {
    const h = harness();
    const configs = codec === 'h264' ? AVC_CONFIG : HEVC_CONFIG;
    const payload = annexB([...configs, picture(codec, 1024 * 1024)]);
    await h.push(payload, codec);
    assert.equal(h.chunks.length, 1);
    assert.equal(h.chunks[0].data, payload);
    assert.deepEqual(h.largeAllocations(1024 * 1024), [], 'NAL discovery and codec selection borrow views');
    assert.deepEqual(h.drops, []);
    assert.ok(h.formats.includes('annexb:annexb'));
    h.player.close();
  }
});

test('configuration probing defers AVCC materialization until that decoder format is selected', async () => {
  const h = harness();
  let resolveAnnexB;
  const waiting = new Promise(resolve => { resolveAnnexB = resolve; });
  h.probe = config => {
    assert.deepEqual(h.largeAllocations(1024 * 1024), [], 'even the fallback probe sees no converted AU');
    return config.avc.format === 'annexb' ? waiting : { supported: true };
  };
  const units = [...AVC_CONFIG, picture('h264', 1024 * 1024)];
  const pending = h.push(annexB(units));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  assert.equal(h.chunks.length, 0);
  assert.deepEqual(h.largeAllocations(1024 * 1024), []);
  resolveAnnexB({ supported: false });
  await pending;
  assert.equal(h.decoders[0].config.avc.format, 'avc');
  assert.equal(h.largeAllocations(1024 * 1024).length, 1);
  assert.deepEqual(h.chunks[0].bytes, new Uint8Array(lengthPrefixed(units)));
  h.player.close();
});

test('unsupported decoder probes do not materialize an unused converted AU', async () => {
  const h = harness();
  h.probe = () => ({ supported: false });
  await h.push(annexB([...AVC_CONFIG, picture('h264', 1024 * 1024)]));
  assert.equal(h.decoders.length, 0);
  assert.equal(h.chunks.length, 0);
  assert.deepEqual(h.largeAllocations(1024 * 1024), []);
  assert.ok(h.drops.includes('webcodecs-h264-config-unsupported'));
  h.player.close();
});

test('cached parameter sets are small independent copies and survive source-buffer reuse', async () => {
  for (const codec of ['h264', 'h265']) {
    const h = harness();
    const configs = codec === 'h264' ? AVC_CONFIG : HEVC_CONFIG;
    const initial = annexB([...configs, picture(codec, 1024 * 1024)]);
    await h.push(initial, codec);
    const cached = [...h.player.configurationUnits.values()];
    assert.equal(cached.length, configs.length);
    for (let index = 0; index < cached.length; index += 1) {
      assert.notEqual(cached[index].buffer, initial);
      assert.equal(cached[index].buffer.byteLength, cached[index].byteLength, 'cache must not retain the large AU buffer');
      assert.deepEqual(new Uint8Array(cached[index]), configs[index]);
    }
    new Uint8Array(initial).fill(0x99);
    const fresh = picture(codec);
    await h.push(annexB([fresh]), codec, { sequence: 1, timestampUs: 33333, config: false });
    assert.deepEqual(h.chunks[1].bytes, new Uint8Array(annexB([...configs, fresh])));
    assert.equal(h.decoders.length, 1, 'source-buffer reuse cannot silently change the configured codec');
    h.player.close();
  }
});

test('separate cached configuration participates in codec selection and AVCC fallback bytes', async () => {
  for (const codec of ['h264', 'h265']) {
    const h = harness();
    const configs = codec === 'h264' ? AVC_CONFIG : HEVC_CONFIG;
    h.probe = config => ({ supported: codec === 'h264'
      ? config.avc.format === 'avc'
      : /^hvc1\./.test(config.codec) && config.hevc.format === 'hevc' });
    await h.push(annexB(configs), codec, { keyframe: false });
    assert.equal(h.chunks.length, 0, 'a pure configuration AU does not submit a picture');
    const fresh = picture(codec);
    await h.push(annexB([fresh]), codec, { sequence: 1, timestampUs: 33333, config: false });
    assert.equal(h.chunks.length, 1);
    assert.equal(h.decoders.at(-1).config.codec, codec === 'h264' ? 'avc1.640028' : 'hvc1.1.6.L150.B0');
    assert.deepEqual(h.chunks[0].bytes, new Uint8Array(lengthPrefixed([...configs, fresh])));
    assert.ok(h.formats.includes('annexb:avcc'));
    h.player.close();
  }
});

test('partial configuration prefixes include only missing sets and preserve the replacement SPS', async () => {
  const h = harness();
  h.probe = config => ({ supported: config.avc.format === 'avc' });
  await h.push(annexB(AVC_CONFIG), 'h264', { keyframe: false });
  const sps = new Uint8Array([0x67, 0x42, 0xe0, 0x1f]);
  const fresh = picture('h264');
  await h.push(annexB([sps, fresh]), 'h264', { sequence: 1, config: false });
  assert.equal(h.decoders[0].config.codec, 'avc1.42E01F');
  assert.deepEqual(h.chunks[0].bytes, new Uint8Array(lengthPrefixed([AVC_CONFIG[1], sps, fresh])));
  h.player.close();
});

test('mixed start codes and trailing Annex-B zeros keep the previous length-prefixed wire representation', async () => {
  const h = harness();
  h.probe = config => ({ supported: config.avc.format === 'avc' });
  const fresh = picture('h264');
  const padded = new Uint8Array(fresh.length + 2);
  padded.set(fresh);
  await h.push(annexB([...AVC_CONFIG, padded], [3, 4, 3]));
  assert.deepEqual(h.chunks[0].bytes, new Uint8Array(lengthPrefixed([...AVC_CONFIG, fresh])));
  h.player.close();
});

test('length-prefixed input still falls back to Annex-B without copying every NAL first', async () => {
  const h = harness();
  const units = [...AVC_CONFIG, picture('h264', 1024 * 1024)];
  await h.push(lengthPrefixed(units), 'h264', { payloadFormat: 'avcc' });
  assert.deepEqual(h.chunks[0].bytes, new Uint8Array(annexB(units)));
  assert.equal(h.largeAllocations(1024 * 1024).length, 1, 'only the required Annex-B output is materialized');
  assert.ok(h.formats.includes('avcc:annexb'));
  h.player.close();
});

test('oversized parameter sets clear the existing cache without copying or retaining the large NAL', async () => {
  const h = harness();
  await h.push(annexB(AVC_CONFIG), 'h264', { keyframe: false });
  const largeSps = new Uint8Array(70 * 1024).fill(0x55);
  largeSps.set(AVC_CONFIG[0]);
  h.allocations.length = 0;
  await h.push(annexB([largeSps, picture('h264')]));
  assert.equal(h.player.configurationUnits.size, 0);
  assert.equal(h.player.configurationPrefix, null);
  assert.deepEqual(h.largeAllocations(64 * 1024), []);
  h.player.close();
});
