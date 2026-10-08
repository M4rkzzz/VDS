const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../vds_web/src/datachannel-protocol.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const protocolModule = { exports: {} };
new Function('module', 'exports', code)(protocolModule, protocolModule.exports);
const protocol = protocolModule.exports;
const frameBytes = protocol.MAX_ENCODED_FRAME_BYTES;
const chunkBytes = protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES;
const chunkCount = Math.ceil(frameBytes / chunkBytes);
const header = {
  protocol: protocol.ENCODED_MEDIA_PROTOCOL, type: 'chunk', streamType: 'video', codec: 'h264',
  payloadFormat: 'annexb', timestampUs: 1, sequence: 1, keyframe: true, config: true
};

function clockHarness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(delay) {
      const until = now + delay;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = until;
    },
    get timerCount() { return timers.size; }
  };
  return { clock, assembler: new protocol.EncodedFrameReassembler(clock) };
}

function chunk(frameId, index, overrides = {}, bytes = frameBytes, fill = 0x5a) {
  const size = Math.min(chunkBytes, bytes - index * chunkBytes);
  return protocol.encodeFrameMessage({ ...header, frameId, chunkIndex: index,
    chunkCount: Math.ceil(bytes / chunkBytes), framePayloadBytes: bytes, ...overrides },
  new Uint8Array(size).fill(fill).buffer);
}

test('unfinished payload has a byte budget and fresh complete frames recover after eviction', () => {
  const { assembler, clock } = clockHarness();
  for (let frame = 0; frame < 20; frame += 1) {
    for (let index = 0; index < chunkCount - 1; index += 1) {
      assert.equal(assembler.push(chunk(`incomplete-${frame}`, index)), null);
      assert.ok(assembler.pendingBytes <= protocol.MAX_PENDING_CHUNKED_BYTES);
    }
  }
  assert.ok(assembler.pendingFrameCount < 20, 'the byte budget evicts before the 64-frame bound');
  assert.equal(clock.timerCount, 1, 'one deadline timer covers every unfinished frame');
  const completed = assembler.push(chunk('incomplete-19', chunkCount - 1));
  assert.equal(completed.payload.byteLength, frameBytes);
  assert.ok(new Uint8Array(completed.payload).every(byte => byte === 0x5a));
  assembler.clear();
  assert.equal(assembler.pendingBytes, 0);
  assert.equal(clock.timerCount, 0);
});

test('a 235 ms 60 fps burst of fourteen maximum legal frames is not clipped', () => {
  const { assembler, clock } = clockHarness();
  // Interleave fragments so all fourteen AUs are pending at the same time.
  for (let index = 0; index < chunkCount - 1; index += 1) {
    for (let frame = 0; frame < 14; frame += 1) {
      assert.equal(assembler.push(chunk(`burst-${frame}`, index, {
        timestampUs: Math.round(frame * 1000000 / 60), sequence: frame
      }, frameBytes, frame + 1)), null);
    }
  }
  assert.equal(assembler.pendingFrameCount, 14);
  assert.equal(assembler.pendingBytes, 14 * (frameBytes - 8192));
  for (let frame = 0; frame < 14; frame += 1) {
    const completed = assembler.push(chunk(`burst-${frame}`, chunkCount - 1, {
      timestampUs: Math.round(frame * 1000000 / 60), sequence: frame
    }, frameBytes, frame + 1));
    assert.equal(completed.payload.byteLength, frameBytes);
    assert.ok(new Uint8Array(completed.payload).every(byte => byte === frame + 1));
  }
  assert.equal(assembler.pendingBytes, 0);
  assert.equal(assembler.pendingFrameCount, 0);
  assert.equal(clock.timerCount, 0);
});

test('idle partial frames expire without another incoming message and duplicates cannot extend the lease', () => {
  const { assembler, clock } = clockHarness();
  const first = chunk('stalled', 0);
  assembler.push(first);
  clock.advance(5000);
  assembler.push(first);
  assert.equal(assembler.pendingBytes, chunkBytes, 'duplicates do not double-count storage');
  assert.equal(clock.timerCount, 1);
  clock.advance(5000);
  assert.equal(assembler.pendingBytes, 0);
  assert.equal(assembler.pendingFrameCount, 0);
  assert.equal(clock.timerCount, 0);
  assembler.push(chunk('replacement', 0));
  assembler.clear();
  assert.equal(clock.timerCount, 0, 'session cleanup cancels idle cleanup');
});

test('header mismatch and frame-count eviction release their exact retained bytes', () => {
  const { assembler, clock } = clockHarness();
  assembler.push(chunk('mismatch', 0));
  assert.throws(() => assembler.push(chunk('mismatch', 1, { codec: 'h265' })), /chunk-header-mismatch/);
  assert.equal(assembler.pendingBytes, 0);
  assert.equal(clock.timerCount, 0);
  for (let frame = 0; frame < 65; frame += 1) assembler.push(chunk(`short-${frame}`, 0));
  assert.equal(assembler.pendingFrameCount, 64);
  assert.equal(assembler.pendingBytes, 64 * chunkBytes);
  assembler.clear();
  assert.equal(clock.timerCount, 0);
});

test('a maximum legal frame still reassembles in reverse order with duplicates', () => {
  const { assembler, clock } = clockHarness();
  for (let index = chunkCount - 1; index > 0; index -= 1) {
    const message = chunk('reverse', index);
    assert.equal(assembler.push(message), null);
    assert.equal(assembler.push(message), null);
  }
  const completed = assembler.push(chunk('reverse', 0));
  assert.equal(completed.payload.byteLength, frameBytes);
  assert.ok(new Uint8Array(completed.payload).every(byte => byte === 0x5a));
  assert.equal(assembler.pendingBytes, 0);
  assert.equal(clock.timerCount, 0);
});
