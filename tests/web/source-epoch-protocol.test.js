const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../../vds_web/src/datachannel-protocol.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const protocolModule = { exports: {} };
new Function('module', 'exports', code)(protocolModule, protocolModule.exports);
const protocol = protocolModule.exports;
const header = {
  protocol: protocol.ENCODED_MEDIA_PROTOCOL, type: 'frame', streamType: 'video', codec: 'h264',
  payloadFormat: 'annexb', timestampUs: 120000, sequence: 42, keyframe: true, config: true
};

function envelope(frameHeader, payload) {
  const headerBytes = Buffer.from(JSON.stringify(frameHeader));
  const output = new Uint8Array(8 + headerBytes.length + payload.length);
  output.set(Buffer.from('VDS1'));
  new DataView(output.buffer).setUint32(4, headerBytes.length, false);
  output.set(headerBytes, 8);
  output.set(payload, 8 + headerBytes.length);
  return output.buffer;
}

function payload(fill) {
  return new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 7).fill(fill);
}

test('legacy complete and chunked frames retain their wire identity without sourceEpoch', () => {
  const small = protocol.decodeFrameMessage(protocol.encodeFrameMessage(header, new Uint8Array([1, 2]).buffer));
  assert.equal(small.header.sourceEpoch, undefined);
  assert.equal(Object.hasOwn(small.header, 'sourceEpoch'), false);
  const bytes = payload(3);
  const messages = protocol.encodeFrameMessages(header, bytes.buffer);
  const chunk = protocol.decodeFrameMessage(messages[0]);
  assert.equal(chunk.header.frameId, `video:120000:42:${bytes.length}`);
  const assembler = new protocol.EncodedFrameReassembler();
  assert.equal(assembler.push(messages[1]), null);
  const decoded = assembler.push(messages[0]);
  assert.equal(Object.hasOwn(decoded.header, 'sourceEpoch'), false);
  assert.deepEqual(new Uint8Array(decoded.payload), bytes);
});

test('sourceEpoch survives complete frames and relay serialization without normalization', () => {
  for (const sourceEpoch of ['source:42:video', '源代际', 'a'.repeat(128)]) {
    const epochHeader = { ...header, sourceEpoch };
    const decoded = protocol.decodeFrameMessage(protocol.encodeFrameMessages(epochHeader, new Uint8Array([4, 5]).buffer)[0]);
    assert.equal(decoded.header.sourceEpoch, sourceEpoch);
    const forwarded = protocol.decodeFrameMessage(protocol.encodeFrameMessages(decoded.header, decoded.payload)[0]);
    assert.equal(forwarded.header.sourceEpoch, sourceEpoch);
    assert.deepEqual(new Uint8Array(forwarded.payload), new Uint8Array([4, 5]));
  }
});

test('interleaved chunks with identical sequence and timestamp stay isolated by source epoch', () => {
  const bytesA = payload(0x31);
  const bytesB = payload(0x71);
  const messagesA = protocol.encodeFrameMessages({ ...header, sourceEpoch: 'epoch-a' }, bytesA.buffer);
  const messagesB = protocol.encodeFrameMessages({ ...header, sourceEpoch: 'epoch-b' }, bytesB.buffer);
  assert.notEqual(protocol.decodeFrameMessage(messagesA[0]).header.frameId, protocol.decodeFrameMessage(messagesB[0]).header.frameId);
  const assembler = new protocol.EncodedFrameReassembler();
  assert.equal(assembler.push(messagesA[0]), null);
  assert.equal(assembler.push(messagesB[1]), null);
  const frameA = assembler.push(messagesA[1]);
  const frameB = assembler.push(messagesB[0]);
  assert.equal(frameA.header.sourceEpoch, 'epoch-a');
  assert.equal(frameB.header.sourceEpoch, 'epoch-b');
  assert.deepEqual(new Uint8Array(frameA.payload), bytesA);
  assert.deepEqual(new Uint8Array(frameB.payload), bytesB);
});

test('legacy and epoch-aware peers cannot mix same-sized fragments after a source switch', () => {
  const oldBytes = payload(0x13);
  const newBytes = payload(0x73);
  const oldMessages = protocol.encodeFrameMessages(header, oldBytes.buffer);
  const newMessages = protocol.encodeFrameMessages({ ...header, sourceEpoch: 'new-source' }, newBytes.buffer);
  const assembler = new protocol.EncodedFrameReassembler();
  assert.equal(assembler.push(oldMessages[0]), null);
  assert.equal(assembler.push(newMessages[1]), null);
  const newFrame = assembler.push(newMessages[0]);
  assert.equal(newFrame.header.sourceEpoch, 'new-source');
  assert.deepEqual(new Uint8Array(newFrame.payload), newBytes);
  const oldFrame = assembler.push(oldMessages[1]);
  assert.equal(oldFrame.header.sourceEpoch, undefined);
  assert.deepEqual(new Uint8Array(oldFrame.payload), oldBytes);
});

test('every chunk must match the source epoch even if a sender reuses or forges frameId', () => {
  for (const switchedEpoch of [undefined, 'epoch-b']) {
    const bytes = payload(5);
    const messages = protocol.encodeFrameMessages({ ...header, sourceEpoch: 'epoch-a' }, bytes.buffer);
    const secondChunk = protocol.decodeFrameMessage(messages[1]);
    const assembler = new protocol.EncodedFrameReassembler();
    assert.equal(assembler.push(messages[0]), null);
    assert.throws(() => assembler.push(envelope({ ...secondChunk.header, sourceEpoch: switchedEpoch }, new Uint8Array(secondChunk.payload))), /chunk-header-mismatch/);
    assert.equal(assembler.push(messages[1]), null, 'the mismatched partial frame was discarded');
    assert.deepEqual(new Uint8Array(assembler.push(messages[0]).payload), bytes);
  }
});

test('source epochs reject empty, oversized and non-string values on encode and receive', () => {
  for (const sourceEpoch of ['', 'x'.repeat(129), null, false, 123, {}, []]) {
    const invalidHeader = { ...header, sourceEpoch };
    assert.throws(() => protocol.decodeFrameMessage(envelope(invalidHeader, new Uint8Array([1]))), /frame-invalid-header/);
    assert.throws(() => protocol.encodeFrameMessage(invalidHeader, new Uint8Array([1]).buffer), /frame-invalid-header/);
    assert.throws(() => protocol.encodeFrameMessages(invalidHeader, payload(1).buffer), /frame-invalid-header/);
  }
});
