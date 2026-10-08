const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../vds_web/src/datachannel-protocol.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const protocolModule = { exports: {} };
new Function('module', 'exports', compiled)(protocolModule, protocolModule.exports);
const protocol = protocolModule.exports;
const header = {
  protocol: protocol.ENCODED_MEDIA_PROTOCOL, type: 'frame', streamType: 'video', codec: 'h264',
  payloadFormat: 'annexb', timestampUs: 1, sequence: 1, keyframe: true, config: true
};

// Construct wire envelopes directly so receiving validation is independent of the encoder's own limit.
function envelope(frameHeader, payload) {
  const headerBytes = Buffer.from(JSON.stringify(frameHeader));
  const output = new Uint8Array(8 + headerBytes.length + payload.length);
  output.set(Buffer.from('VDS1'));
  new DataView(output.buffer).setUint32(4, headerBytes.length, false);
  output.set(headerBytes, 8);
  output.set(payload, 8 + headerBytes.length);
  return output.buffer;
}

assert.throws(() => protocol.decodeFrameMessage(envelope(header, new Uint8Array(protocol.MAX_ENCODED_FRAME_BYTES + 1))), /frame-too-large/);
assert.strictEqual(protocol.decodeFrameMessage(envelope(header, new Uint8Array(protocol.MAX_ENCODED_FRAME_BYTES))).payload.byteLength, protocol.MAX_ENCODED_FRAME_BYTES);

const reassembler = new protocol.EncodedFrameReassembler();
const chunkHeader = { ...header, type: 'chunk', frameId: 'short-frame', chunkIndex: 0, chunkCount: 1, framePayloadBytes: 10 };
assert.throws(() => reassembler.push(envelope(chunkHeader, new Uint8Array([1, 2, 3]))), /chunk-invalid-header/);
assert.throws(() => reassembler.push(envelope({ ...chunkHeader, chunkCount: 2 }, new Uint8Array(10))), /chunk-invalid-header/);
assert.throws(() => reassembler.push(envelope({
  ...chunkHeader, chunkCount: Number.MAX_SAFE_INTEGER, framePayloadBytes: protocol.MAX_ENCODED_FRAME_BYTES
}, new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES))), /chunk-invalid-header/);
assert.strictEqual(reassembler.pendingBytes, 0, 'rejected headers cannot reserve pending payload');

const bytes = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 5);
for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
const messages = protocol.encodeFrameMessages(header, bytes.buffer);
const lastChunk = protocol.decodeFrameMessage(messages[1]);
assert.throws(() => reassembler.push(envelope(lastChunk.header, new Uint8Array(4))), /chunk-invalid-header/);
assert.strictEqual(reassembler.push(messages[0]), null);
assert.throws(() => reassembler.push(envelope({ ...lastChunk.header, codec: 'h265' }, new Uint8Array(lastChunk.payload))), /chunk-header-mismatch/);

// Reverse delivery and harmless duplicates still produce the exact input.
assert.strictEqual(reassembler.push(messages[1]), null);
assert.strictEqual(reassembler.push(messages[1]), null);
assert.deepStrictEqual(new Uint8Array(reassembler.push(messages[0]).payload), bytes);

// Optional source epochs cannot be malformed or mixed within a fragmented frame.
for (const sourceEpoch of ['', null, 1, {}, 'x'.repeat(129)]) {
  assert.throws(() => protocol.decodeFrameMessage(envelope({ ...header, sourceEpoch }, new Uint8Array(1))), /frame-invalid-header/);
}
const epochMessages = protocol.encodeFrameMessages({ ...header, sourceEpoch: 'source-epoch-a' }, bytes.buffer);
const epochChunk = protocol.decodeFrameMessage(epochMessages[1]);
assert.strictEqual(reassembler.push(epochMessages[0]), null);
assert.throws(() => reassembler.push(envelope({ ...epochChunk.header, sourceEpoch: 'source-epoch-b' }, new Uint8Array(epochChunk.payload))), /chunk-header-mismatch/);
assert.strictEqual(reassembler.pendingBytes, 0, 'header mismatch releases the partial frame');
reassembler.clear();
console.log('vds-web receiving frame validation passed');
