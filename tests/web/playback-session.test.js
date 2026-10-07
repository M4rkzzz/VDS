const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourceDirectory = path.resolve(__dirname, '../../vds_web/src');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
}

function createHarness() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const h = {
    states: [], videoStates: [], audioStates: [], videoDrops: [], audioDrops: [],
    videoDecoders: [], audioDecoders: [], contexts: [], videoChunks: [], audioChunks: [],
    videoOutputs: 0, audioOutputs: 0, released: 0, audioStarts: [], gains: [], sourceChanges: [], sources: []
  };
  h.clock = {
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
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    }
  };
  const probes = { video: async () => ({ supported: true }), audio: async () => ({ supported: true }) };
  h.setProbe = (kind, probe) => { probes[kind] = probe; };
  h.makeOutput = (kind, timestamp = h[`${kind}Chunks`].at(-1)?.timestamp ?? 0) => ({
    timestamp,
    displayWidth: h.videoWidth || 16, displayHeight: h.videoHeight || 16,
    sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 2,
    copyTo(target) { target.fill(0); },
    close() { h.released += 1; }
  });

  function decoderClass(kind) {
    return class Decoder {
      static isConfigSupported(config) { return probes[kind](config); }
      constructor(callbacks) {
        this.callbacks = callbacks;
        this.state = 'unconfigured';
        h[`${kind}Decoders`].push(this);
      }
      configure(config) { this.config = config; this.state = 'configured'; }
      decode(chunk) {
        assert.equal(this.state, 'configured');
        if (h.decodeError) throw new Error('local-decoder-failed');
        h[`${kind}Chunks`].push(chunk.init);
        this.callbacks.output(h.makeOutput(kind, chunk.init.timestamp));
      }
      close() { assert.notEqual(this.state, 'closed'); this.state = 'closed'; }
    };
  }

  class Chunk { constructor(init) { this.init = init; } }
  class AudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 1;
      this.destination = {};
      h.contexts.push(this);
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createBuffer(channels, frames, rate) {
      return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() {
      const source = { stopped: 0, disconnected: 0, connect() {}, stop() { this.stopped++; },
        disconnect() { this.disconnected++; }, start: (at) => h.audioStarts.push(at) };
      h.sources.push(source); return source;
    }
    createGain() { const gain = { gain: { value: 1 }, connect() {} }; h.gains.push(gain); return gain; }
  }

  const context = vm.createContext({
    ArrayBuffer, Uint8Array, DataView, TextEncoder, TextDecoder, Float32Array, Promise, Error,
    performance: { now: () => h.clock.now },
    window: {
      setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout,
      VideoDecoder: decoderClass('video'), AudioDecoder: decoderClass('audio'),
      EncodedVideoChunk: Chunk, EncodedAudioChunk: Chunk, AudioContext
    }
  });
  const modules = new Map();
  function loadModule(name) {
    const filename = path.join(sourceDirectory, `${name}.ts`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const execute = vm.runInContext(`(function (module, exports, require) { ${code}\n })`, context);
    execute(module, module.exports, (relative) => loadModule(relative.replace(/^\.\//, '')));
    return module.exports;
  }
  const protocol = loadModule('datachannel-protocol');
  h.canvas = { width: 1, height: 1, getContext: () => ({ drawImage() {} }) };
  h.session = new (loadModule('playback-session').EncodedMediaPlaybackSession)(h.canvas, {
    video: {
      onState: (state) => h.videoStates.push(state),
      onDecodedFrame: () => { h.videoOutputs += 1; },
      onDroppedFrame: (reason) => h.videoDrops.push(reason),
      onPayloadFormat() {}, onVideoFrameInfo() {}
    },
    audio: {
      onState: (state) => h.audioStates.push(state),
      onDecodedBlock: () => { h.audioOutputs += 1; },
      onDroppedBlock: (reason) => h.audioDrops.push(reason)
    },
    onState: (state) => h.states.push(state),
    onSourceChanged: (epoch) => h.sourceChanges.push(epoch)
  });
  h.header = (sequence = 1, keyframe = true, kind = 'video') => ({
    protocol: 'vds-media-encoded-v1', type: 'frame', streamType: kind,
    codec: kind === 'video' ? 'h264' : 'opus', payloadFormat: kind === 'video' ? 'annexb' : 'opus-raw',
    timestampUs: sequence * 20000, sequence, keyframe, config: keyframe
  });
  h.payload = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x65, 0x88]).buffer;
  h.messages = (sequence = 1, keyframe = true, kind = 'video', payload = h.payload) => (
    protocol.encodeFrameMessages(h.header(sequence, keyframe, kind), payload)
  );
  h.accept = (sequence = 1, keyframe = true, kind = 'video') => h.session.acceptMessage(h.messages(sequence, keyframe, kind)[0]);
  h.acceptEpoch = (epoch, sequence = 0, keyframe = true, kind = 'video') => h.session.acceptMessage(protocol.encodeFrameMessages({
    ...h.header(sequence, keyframe, kind), ...(epoch !== undefined ? { sourceEpoch: epoch } : {})
  }, h.payload)[0]);
  return h;
}

test('a source epoch changes on the same channel at sequence zero and rejects retired or downgraded media', async () => {
  const h = createHarness(); await h.session.resumeAudio(); h.session.start();
  h.acceptEpoch('source-A', 100); h.acceptEpoch('source-A', 100, true, 'audio'); await flushMicrotasks();
  assert.equal(h.videoOutputs, 1); assert.equal(h.audioOutputs, 1);
  const oldVideo = h.videoDecoders[0]; const oldAudio = h.audioDecoders[0];
  h.acceptEpoch('source-A', 101, false); // Its microtask is superseded before local decode.
  const newFrame = h.acceptEpoch('source-B', 0);
  assert.equal(newFrame.header.sequence, 0); assert.equal(newFrame.header.sourceEpoch, 'source-B');
  h.acceptEpoch('source-B', 0, true, 'audio'); await flushMicrotasks();
  assert.equal(h.videoOutputs, 2); assert.equal(h.audioOutputs, 2);
  assert.equal(oldVideo.state, 'closed'); assert.equal(oldAudio.state, 'closed');
  assert.deepEqual(h.sourceChanges, ['source-B']);
  assert.equal(h.contexts.length, 1); assert.equal(h.contexts[0].state, 'running');
  assert.equal(h.audioChunks.at(-1).timestamp, 0);
  assert.equal(h.acceptEpoch('source-A', 1000), null);
  assert.equal(h.acceptEpoch(undefined, 1001), null);
  oldVideo.callbacks.output(h.makeOutput('video')); oldAudio.callbacks.output(h.makeOutput('audio'));
  await flushMicrotasks();
  assert.equal(h.videoOutputs, 2); assert.equal(h.audioOutputs, 2);
  h.acceptEpoch('source-B', 1, false); await flushMicrotasks(); assert.equal(h.videoOutputs, 3);
  assert.ok(h.videoDrops.includes('web-playback-source-epoch-retired'));
  assert.ok(h.videoDrops.includes('web-playback-source-epoch-legacy-after-epoch'));
  h.session.close(); h.session.start(); h.acceptEpoch('source-A', 0); await flushMicrotasks();
  assert.equal(h.videoOutputs, 4, 'a new connection/session clears the retired epoch set'); h.session.close();
});

test('legacy remains compatible until an explicit epoch upgrades the active source', async () => {
  const h = createHarness(); h.session.start(); h.accept(90); await flushMicrotasks();
  h.acceptEpoch('new-source', 0); await flushMicrotasks();
  assert.equal(h.videoOutputs, 2); assert.deepEqual(h.sourceChanges, ['new-source']);
  assert.equal(h.accept(91), null); h.session.close();
});

test('real protocol chunks cannot complete a frame using fragments from a closed session', () => {
  const h = createHarness();
  const payload = new Uint8Array(26 * 1024).fill(7).buffer;
  const chunks = h.messages(1, true, 'video', payload);
  assert.equal(chunks.length, 3);
  h.session.start();
  assert.equal(h.session.acceptMessage(chunks[0]), null);
  h.session.close();
  assert.equal(h.session.acceptMessage(chunks[1]), null);
  h.session.start();
  assert.equal(h.session.acceptMessage(chunks[1]), null);
  assert.equal(h.session.acceptMessage(chunks[2]), null);
  const completed = h.session.acceptMessage(chunks[0]);
  assert.ok(completed);
  assert.deepEqual(new Uint8Array(completed.payload), new Uint8Array(payload));
  assert.equal(h.videoOutputs, 0, 'return encoded frame before playback');
  h.session.close();
});

test('closing cancels the reorder wakeup and queued dispatch, while the next session plays normally', async () => {
  const h = createHarness();
  assert.equal(h.session.acceptMessage('ignored while stopped'), null);
  h.session.start();
  assert.equal(h.accept().header.sequence, 1);
  assert.equal(h.videoOutputs, 0);
  await flushMicrotasks();
  assert.equal(h.videoOutputs, 1);
  h.accept(3, false); // Sequence 2 is still in flight.
  await flushMicrotasks();
  assert.equal(h.clock.size, 1);
  h.clock.advance(19);
  await flushMicrotasks();
  assert.equal(h.videoOutputs, 1);
  h.session.close();
  assert.equal(h.clock.size, 0);
  h.clock.advance(100);
  await flushMicrotasks();
  assert.equal(h.videoOutputs, 1);

  h.session.start();
  h.accept(2);
  h.session.start();
  h.accept(3);
  await flushMicrotasks();
  assert.equal(h.clock.size, 0, 'old dispatch cannot enter the replacement session');
  h.clock.advance(20);
  await flushMicrotasks();
  assert.deepEqual(h.videoChunks.map((chunk) => chunk.timestamp), [20000, 60000]);
  assert.equal(h.states.at(-1), 'playing');
  h.accept(4, false);
  await flushMicrotasks();
  assert.equal(h.states.at(-1), 'playing', 'receiving more frames does not downgrade playback');
  h.session.close();
});

for (const kind of ['video', 'audio']) {
  test(`${kind} decoder support arriving after replacement cannot revive or change the new session`, async () => {
    const h = createHarness();
    const oldSupport = deferred();
    h.setProbe(kind, () => oldSupport.promise);
    h.session.start();
    h.accept(1, true, kind);
    await flushMicrotasks();
    h.clock.advance(20);
    await flushMicrotasks();
    assert.equal(h[`${kind}Decoders`].length, 0);
    h.session.close();
    h.session.start();
    h.setProbe(kind, async () => ({ supported: true }));
    h.accept(2, true, kind);
    await flushMicrotasks();
    h.clock.advance(20);
    await flushMicrotasks();
    const states = [...h.states];
    oldSupport.resolve({ supported: true });
    await flushMicrotasks();
    assert.deepEqual(h[`${kind}Chunks`].map((chunk) => chunk.timestamp), [40000]);
    assert.equal(h[`${kind}Decoders`].length, 1);
    assert.deepEqual(h.states, states);
    h.session.close();
    h[`${kind}Decoders`][0].callbacks.output(h.makeOutput(kind));
    assert.equal(h[`${kind}Outputs`], 1);
    assert.equal(h.states.at(-1), 'stopped');
  });
}

test('unordered frames are decoded by sequence while a gap requests a keyframe and leaves relay independent', async () => {
  const h = createHarness();
  h.session.start();
  h.accept(1);
  h.accept(3, false);
  h.accept(2, false);
  await flushMicrotasks();
  assert.deepEqual(h.videoChunks.map((chunk) => chunk.timestamp), [20000, 40000, 60000]);
  assert.equal(h.clock.size, 0);
  assert.equal(h.accept(5, false).header.sequence, 5, 'a held frame remains available for relay');
  await flushMicrotasks();
  assert.equal(h.clock.size, 1);
  h.clock.advance(60);
  await flushMicrotasks();
  assert.ok(h.videoDrops.includes('web-video-sequence-discontinuity'));
  h.accept(6);
  await flushMicrotasks();
  h.accept(7, false);
  await flushMicrotasks();
  assert.deepEqual(h.videoChunks.map((chunk) => chunk.timestamp), [20000, 40000, 60000, 120000, 140000]);
  h.session.close();
});

test('decoder failures are local and cannot prevent synchronous encoded-frame forwarding', async () => {
  const h = createHarness();
  h.decodeError = true;
  h.session.start();
  const frame = h.accept(1);
  assert.ok(frame);
  assert.equal(frame.header.sequence, 1);
  assert.deepEqual(new Uint8Array(frame.payload), new Uint8Array(h.payload));
  assert.deepEqual(h.videoDrops, []);
  await flushMicrotasks();
  h.clock.advance(20);
  await flushMicrotasks();
  assert.ok(h.videoDrops.includes('local-decoder-failed'));
  assert.equal(h.states.at(-1), 'decoding');
  assert.throws(() => h.session.acceptMessage('bad active message'), /datachannel-frame-invalid/);
  assert.throws(() => h.session.acceptMessage(new ArrayBuffer(0)), /datachannel-frame-invalid/);
  h.session.close();
});

test('first start preserves audio unlocked by a user gesture, and controls survive a later session', async () => {
  const h = createHarness();
  await h.session.resumeAudio();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].state, 'running');
  h.session.setVolume(0.25);
  h.session.setDelayMs(100);
  h.session.setAudioFormat(44100, 1);
  h.session.setVideoDisplaySize(640, 360);
  h.videoWidth = 640;
  h.videoHeight = 360;
  h.session.start();
  assert.equal(h.contexts[0].state, 'running', 'start preserves the gesture-unlocked audio context');
  h.accept(1, true, 'audio');
  h.accept(1);
  await flushMicrotasks();
  h.clock.advance(20);
  await flushMicrotasks();
  assert.equal(h.audioDecoders[0].config.sampleRate, 44100);
  assert.equal(h.audioDecoders[0].config.numberOfChannels, 1);
  assert.equal(h.gains[0].gain.value, 0.25);
  assert.equal(h.audioStarts[0], 1.12);
  assert.equal(h.canvas.width, 640);
  assert.equal(h.canvas.height, 360);
  h.session.close();
  assert.equal(h.contexts[0].state, 'closed');
  h.session.start();
  h.accept(2, true, 'audio');
  h.accept(2);
  await flushMicrotasks();
  h.clock.advance(20);
  await flushMicrotasks();
  assert.equal(h.gains.at(-1).gain.value, 0.25);
  assert.equal(h.audioStarts.at(-1), 1.12);
  assert.equal(h.audioDecoders.at(-1).config.sampleRate, 44100);
  assert.equal(h.canvas.width, 640);
  h.session.close();
});

test('production upstream recovery preserves running audio context while actual room leave closes it', async () => {
  const h = createHarness(); await h.session.resumeAudio(); h.session.start();
  h.acceptEpoch('old-source', 90); h.acceptEpoch('old-source', 90, true, 'audio'); await flushMicrotasks();
  const context = h.contexts[0]; const source = h.sources[0]; const oldDecoder = h.audioDecoders[0];
  let closedPeers = 0;
  const currentPeer = { close() { closedPeers++; } };
  class Peer { close() { closedPeers++; } }
  const filename = path.resolve(sourceDirectory, 'main.ts');
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const names = ['requestUpstreamRecovery', 'ensureUpstreamPeer', 'handleChainReconnect', 'resetLocalViewerSession'];
  const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  const prelude = `
    let upstreamPc = currentPeer, upstreamMediaChannel = null, downstreamPc = null, downstreamDataChannel = null;
    let upstreamEdgeAttemptId = null, downstreamEdgeAttemptId = null, upstreamRecoveryAttempts = 0, viewerReadySent = true;
    let downstreamDataChannelReady = false, downstreamRelayForwarding = false, downstreamCloseExpected = false;
    let lastVideoKeyframeForRelay = null, lastBootstrapFrameId = '', downstreamPeerId = '', relaySourceEpoch = '';
    let joinAttemptSeq = 0, session = { roomId: 'same-room', upstreamPeerId: 'host', hostId: 'host', chainPosition: 1 };
    const pendingIceCandidates = new Map(), serverConfig = { iceServers: [] };
  `;
  const code = ts.transpileModule(`${prelude}\n${declarations.map((node) => node.getText(parsed)).join('\n')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const element = () => ({ textContent: '', classList: { add() {}, remove() {} } });
  const globals = {
    currentPeer, playback: h.session, RTCPeerConnection: Peer, clientId: 'client',
    upstreamRecovery: { stop() {}, start() {} }, isCurrentUpstreamPeer: () => true,
    diagnostics: { update() {} }, signaling: { send() {}, close() {} }, wirePeerEvents() {}, rotateRelaySourceEpoch() {},
    setError: (reason) => assert.fail(reason), setStatus() {}, errorToMessage: (error) => error.message,
    getManifestCompatibilityFailure: () => null, removePeerDiagnostics() {}, clearError() {},
    formatChainPosition: (position) => String(position), sessionStorage: { setItem() {} },
    clearJoinAckTimer() {}, clearMobileSuspendTimer() {}, setJoinPending() {}, clearRelayHelloAckTimer() {}, clearStoredSession() {},
    joinCard: element(), leaveButton: element(), viewerRoomId: element(), chainPositionText: element(), waitingMessage: element()
  };
  const flow = new Function(...Object.keys(globals), `${code}\nreturn {
    recover: () => requestUpstreamRecovery(upstreamPc, 'host', 'upstream-failed'),
    reconnect: () => ensureUpstreamPeer(session.upstreamPeerId),
    rebind: () => handleChainReconnect({ upstreamPeerId: 'next-host', newChainPosition: 2 }), leave: resetLocalViewerSession
  };`)(...Object.values(globals));
  flow.recover();
  assert.equal(context.state, 'running'); assert.equal(source.stopped, 1); assert.equal(source.disconnected, 1);
  assert.equal(oldDecoder.state, 'closed'); assert.equal(closedPeers, 1);
  oldDecoder.callbacks.output(h.makeOutput('audio')); assert.equal(h.audioOutputs, 1);
  flow.reconnect(); h.acceptEpoch('new-source', 0); h.acceptEpoch('new-source', 0, true, 'audio'); await flushMicrotasks();
  assert.equal(h.contexts.length, 1); assert.equal(h.contexts[0], context); assert.equal(context.state, 'running');
  assert.equal(h.audioOutputs, 2); assert.equal(h.videoOutputs, 2);
  const recoverySource = h.sources.at(-1);
  await flow.rebind(); assert.equal(context.state, 'running'); assert.equal(recoverySource.stopped, 1);
  flow.reconnect(); h.acceptEpoch('third-source', 0); h.acceptEpoch('third-source', 0, true, 'audio'); await flushMicrotasks();
  assert.equal(h.contexts.length, 1); assert.equal(h.contexts[0], context);
  assert.equal(h.audioOutputs, 3); assert.equal(h.videoOutputs, 3);
  flow.leave(); assert.equal(context.state, 'closed'); assert.equal(h.sources.at(-1).stopped, 1);
  assert.equal(h.states.at(-1), 'stopped');
});
