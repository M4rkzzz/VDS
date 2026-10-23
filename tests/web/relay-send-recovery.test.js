const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const modules = new Map();
function load(name, clock) {
  if (!clock && modules.has(name)) return modules.get(name);
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../vds_web/src', `${name}.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = {};
  new Function('exports', 'require', 'setTimeout', 'clearTimeout', code)(exports,
    relative => load(relative.replace('./', '')), clock?.setTimeout || setTimeout, clock?.clearTimeout || clearTimeout);
  if (!clock) modules.set(name, exports); return exports;
}
const protocol = load('datachannel-protocol');
const { EncodedRelaySender } = load('encoded-relay-sender');
const header = { protocol: protocol.ENCODED_MEDIA_PROTOCOL, type: 'frame', streamType: 'video', codec: 'h264',
  sourceEpoch: 'sender-test', timestampUs: 1, sequence: 1, keyframe: false, config: false, payloadFormat: 'annexb' };
const budget = 8 * 1024 * 1024;
function harness(request = () => {}) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const clock = {
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const sent = [], requests = [];
  const channel = { readyState: 'open', bufferedAmount: 0,
    send(message) { sent.push(message); this.bufferedAmount += message.byteLength; } };
  const Sender = load('encoded-relay-sender', clock).EncodedRelaySender;
  const sender = new Sender(channel, () => { requests.push(now); request(); }, () => now);
  return { channel, sender, sent, requests, timers, advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  } };
}

test('lost recovery request retries with no video arrival and no second low-buffer event', () => {
  const h = harness();
  h.channel.bufferedAmount = budget; h.sender.send(header, new ArrayBuffer(100));
  h.channel.bufferedAmount = 0; h.sender.onBufferedLow();
  assert.deepEqual(h.requests, [0]);
  h.advance(1999); assert.equal(h.requests.length, 1);
  h.advance(1); assert.deepEqual(h.requests, [0, 2000]);
  assert.equal(h.timers.size, 1, 'only the stalled sender owns a retry');
  h.sender.send({ ...header, keyframe: true }, new ArrayBuffer(100));
  assert.equal(h.timers.size, 0, 'fresh keyframe stops recovery work');
  h.advance(60000); assert.equal(h.requests.length, 2);
});

test('recovery checks a missed drain event without requesting while congested; close cancels retries', () => {
  const h = harness(); h.channel.bufferedAmount = budget;
  h.sender.send(header, new ArrayBuffer(100));
  h.advance(10000); assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 1);
  h.channel.bufferedAmount = 0; h.advance(2000);
  assert.equal(h.requests.length, 1);
  h.channel.readyState = 'closed'; h.advance(2000);
  assert.equal(h.timers.size, 0); assert.equal(h.requests.length, 1);
});

test('throwing recovery callbacks retry without traffic; reset prevents retired callbacks rearming', () => {
  const h = harness(() => { throw new Error('upstream transient send error'); });
  h.channel.bufferedAmount = budget; h.sender.send(header, new ArrayBuffer(100));
  h.channel.bufferedAmount = 0; h.sender.onBufferedLow();
  h.advance(2000); assert.equal(h.requests.length, 2);
  const stale = [...h.timers.values()][0].callback;
  h.sender.reset(); assert.equal(h.timers.size, 0);
  h.channel.bufferedAmount = budget; h.sender.send(header, new ArrayBuffer(100));
  stale(); assert.equal(h.timers.size, 1, 'retired callback must not consume the replacement timer');
  h.sender.reset(); h.advance(60000); assert.equal(h.requests.length, 2);
});

function upstreamRequestHarness() {
  const filename = path.resolve(__dirname, '../../vds_web/src/main.ts');
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requestUpstreamKeyframe');
  const state = parsed.statements.filter(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(d => d.name.getText(parsed).startsWith('lastUpstreamKeyframeRequest')));
  const code = ts.transpileModule([...state, fn].map(node => node.getText(parsed)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('performance', 'ENCODED_MEDIA_PROTOCOL', 'ENCODED_MEDIA_PROTOCOL_VERSION', `
    let upstreamMediaChannel=null, upstreamPc={}, manifest=null;
    function getCurrentManifest() { return manifest; }
    ${code}
    return { request: requestUpstreamKeyframe, bind: (channel, source) => {
      upstreamMediaChannel=channel; manifest=source;
    } };
  `)({ now: () => 1000 }, protocol.ENCODED_MEDIA_PROTOCOL, 1);
}

test('production upstream request tolerates send failure and permits immediate retry', () => {
  let fail = true, sent = 0;
  const channel = { readyState: 'open', send() { if (fail) throw Object.assign(new Error('queue full'), { name: 'OperationError' }); sent++; } };
  const { request, bind } = upstreamRequestHarness();
  bind(channel, { mediaSessionId: 'live', manifestVersion: 1 });
  assert.doesNotThrow(request);
  fail = false; request(); assert.equal(sent, 1);
  request(); assert.equal(sent, 1, 'successful request still coalesces its burst');
});

test('replacement channel and manifest request fresh IDR without inheriting an old cooldown', () => {
  const h = upstreamRequestHarness(), sent = [];
  const channel = () => ({ readyState: 'open', send: value => sent.push(JSON.parse(value)) });
  const first = channel(), replacement = channel();
  h.bind(first, { mediaSessionId: 'live', manifestVersion: 1 }); h.request(); h.request();
  assert.equal(sent.length, 1);
  h.bind(replacement, { mediaSessionId: 'live', manifestVersion: 1 }); h.request(); h.request();
  assert.equal(sent.length, 2, 'a new transport must request immediately');
  h.bind(replacement, { mediaSessionId: 'live', manifestVersion: 2 }); h.request(); h.request();
  assert.equal(sent.length, 3, 'a new manifest must request immediately');
  h.bind(replacement, { mediaSessionId: 'next-source', manifestVersion: 2 }); h.request(); h.request();
  assert.equal(sent.length, 4, 'a new session must request immediately');
  assert.equal(sent.at(-1).mediaSessionId, 'next-source');
});

test('off-phase drain event retries at request deadline without an extra polling interval', () => {
  const h = harness(); h.channel.bufferedAmount = budget;
  h.sender.send(header, new ArrayBuffer(100));
  h.advance(1500); h.channel.bufferedAmount = 0; h.sender.onBufferedLow();
  assert.deepEqual(h.requests, [1500]);
  h.advance(1999); assert.deepEqual(h.requests, [1500]);
  h.advance(1); assert.deepEqual(h.requests, [1500, 3500]);
  assert.equal(h.timers.size, 1);
  h.sender.reset();
});

test('relay rejects a whole frame near capacity; never emits a prefix of its chunks', () => {
  const h = harness(), payload = new ArrayBuffer(40000);
  h.channel.bufferedAmount = budget - 20000;
  assert.equal(h.sender.send(header, payload), false);
  assert.equal(h.sent.length, 0);
});

test('queue draining requests fresh IDR; cached bootstrap and dependent deltas cannot repair a gap', () => {
  const h = harness(), payload = new ArrayBuffer(40000);
  h.channel.bufferedAmount = budget;
  h.sender.send(header, payload);
  h.channel.bufferedAmount = 0; h.sender.onBufferedLow();
  assert.equal(h.requests.length, 1);
  assert.equal(h.sender.send(header, payload), false);
  assert.equal(h.sender.send({ ...header, keyframe: true }, payload, true), false);
  h.advance(2000); h.sender.send(header, payload);
  assert.equal(h.requests.length, 2, 'lost keyframe request can be retried while media arrives');
  assert.equal(h.sender.send({ ...header, keyframe: true, sequence: 2 }, payload), true);
  assert.equal(h.sender.send({ ...header, sequence: 3 }, payload), true);
  const assembler = new protocol.EncodedFrameReassembler();
  const complete = h.sent.map(message => assembler.push(message)).filter(Boolean);
  assert.deepEqual(complete.map(frame => frame.header.sequence), [2, 3]);
  assembler.clear();
});

test('audio survives video recovery and has independent congestion reserve', () => {
  const h = harness();
  h.channel.bufferedAmount = budget;
  assert.equal(h.sender.send(header, new ArrayBuffer(40000)), false);
  assert.equal(h.sender.send({ ...header, streamType: 'audio', codec: 'opus', payloadFormat: 'opus-raw' }, new ArrayBuffer(200)), true);
  assert.equal(h.requests.length, 0, 'do not restart encoder while downstream queue is still full');
});

test('empty queue admits a large keyframe completely without an artificial frame-size cap', () => {
  const h = harness(), payload = new ArrayBuffer(protocol.MAX_ENCODED_FRAME_BYTES);
  assert.equal(h.sender.send({ ...header, keyframe: true }, payload), true);
  assert.equal(h.sent.length, Math.ceil(payload.byteLength / protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES));
});

test('native send OperationError recovers on fresh keyframe instead of failing the relay', () => {
  const h = harness(), send = h.channel.send;
  h.channel.send = function(message) {
    if (h.sent.length === 1) throw Object.assign(new Error('queue full'), { name: 'OperationError' });
    send.call(this, message);
  };
  assert.equal(h.sender.send(header, new ArrayBuffer(40000)), false);
  assert.equal(h.sent.length, 1);
  h.channel.send = send; h.channel.bufferedAmount = 0;
  assert.equal(h.sender.send(header, new ArrayBuffer(100)), false);
  assert.equal(h.sender.send({ ...header, keyframe: true, sequence: 2 }, new ArrayBuffer(100)), true);
});

test('source replacement and sender replacement do not inherit the old congestion gate', () => {
  const h = harness(); h.channel.bufferedAmount = budget;
  h.sender.send(header, new ArrayBuffer(100)); h.channel.bufferedAmount = 0;
  h.sender.reset(); assert.equal(h.sender.send(header, new ArrayBuffer(100)), true);
  const next = new EncodedRelaySender(h.channel, () => {});
  assert.equal(next.send(header, new ArrayBuffer(100)), true);
});

function productionRelay() {
  const h = harness();
  const filename = process.env.VDS_RELAY_MAIN_TEST_SOURCE || path.resolve(__dirname, '../../vds_web/src/main.ts');
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const names = ['handleInboundEncodedFrame', 'forwardEncodedFrame', 'sendRelayBootstrapKeyframe', 'isDataChannelRelayReady', 'canSendDataChannelMessage'];
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  const code = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const assembler = new protocol.EncodedFrameReassembler();
  const counters = {}, errors = [];
  const globals = { ArrayBuffer, ...protocol, relayFrameSender: h.sender, downstreamDataChannel: h.channel,
    downstreamDataChannelReady: true, relaySourceEpoch: 'relay-fixture',
    DATA_CHANNEL_MAX_BUFFERED_BYTES: budget, DATA_CHANNEL_BUFFERED_LOW_BYTES: 2 * 1024 * 1024,
    playback: { acceptMessage: message => assembler.push(message) },
    diagnostics: { incrementCounter(name) { counters[name] = (counters[name] || 0) + 1; },
      getSnapshot: () => counters, update() {} },
    logVdsWebInfo() {}, toConsoleJson: JSON.stringify, maybeSendViewerReady() {},
    markDownstreamRelayForwarding() {}, markRelayUnsupported: reason => errors.push(reason), errorToMessage: error => error.message };
  const api = new Function(...Object.keys(globals), `let lastVideoKeyframeForRelay=null, lastBootstrapFrameId='';\n${code}\nreturn { forwardEncodedFrame, handleInboundEncodedFrame };`)(...Object.values(globals));
  return { ...h, ...api, counters, errors };
}

test('production relay emits a live keyframe only once, not bootstrap plus normal forwarding', () => {
  const h = productionRelay(), payload = new ArrayBuffer(40000);
  for (const chunk of protocol.encodeFrameMessages({ ...header, keyframe: true }, payload)) h.handleInboundEncodedFrame(chunk, 'upstream');
  const output = new protocol.EncodedFrameReassembler();
  const frames = h.sent.map(message => output.push(message)).filter(Boolean);
  assert.equal(frames.length, 1);
  assert.equal(h.counters.dataChannelFramesForwarded, 1);
  assert.deepEqual(h.errors, []); output.clear();
});

test('production relay does not send partial frame at queue boundary', () => {
  const h = productionRelay(); h.channel.bufferedAmount = budget - 20000;
  h.forwardEncodedFrame(header, new ArrayBuffer(40000));
  assert.equal(h.sent.length, 0);
  assert.equal(h.counters.dataChannelFramesDropped, 1);
  assert.deepEqual(h.errors, []);
});
