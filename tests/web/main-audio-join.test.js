const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the complete production entry point, including its actual join button,
// automatic restore, signaling callback and playback status bindings.
function harness({ savedSession = false, activeGesture = true } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, handlers: new Map(), attributes: new Map(),
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, listener) { this.handlers.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      querySelectorAll() { return []; }, replaceChildren() {}, requestFullscreen() {}
    });
    return elements.get(id);
  }
  const clock = new Map();
  const calls = { audio: 0, connect: 0, sent: [], console: [], status: [] };
  const storage = new Map([['vds-web-client-id', 'web-test']]);
  if (savedSession) storage.set('vds-web-session', JSON.stringify({
    roomId: 'ABC234', clientId: 'web-test', sessionToken: 'fixture-token',
    hostId: 'host-peer', upstreamPeerId: 'host-peer', chainPosition: 0
  }));
  const capability = {
    ok: true, browser: 'Edge', browserFamily: 'chromium', platform: 'desktop', mobile: false,
    maxDirectDownstreams: 1, relayCapable: true, relayEligibilityReason: 'relay-ready',
    audioOutput: true, reasons: [], supportedVideoCodecs: ['h264'], supportedAudioCodecs: ['opus']
  };
  let signaling, playback, diagnostics;
  class Signaling {
    constructor() { signaling = this; }
    onMessage(callback) { this.message = callback; }
    onStatus(callback) { this.status = callback; }
    async connect() { calls.connect += 1; }
    send(message) { calls.sent.push(message); }
    close() {}
  }
  class Playback {
    constructor(canvas, callbacks) { playback = this; this.callbacks = callbacks; }
    // A suspended browser context may leave this pending until a later gesture.
    resumeAudio() { calls.audio += 1; return new Promise(() => {}); }
    setAudioFormat() {} setVideoDisplaySize() {} close() {}
  }
  class Diagnostics {
    constructor() {
      diagnostics = this;
      this.snapshot = { capability, clientId: 'web-test', status: '能力检测中',
        encodedFramesReceived: 0, webDecodedVideoFrames: 0, dataChannelFramesReceived: 0 };
    }
    update(partial) { Object.assign(this.snapshot, partial); }
    getSnapshot() { return { ...this.snapshot }; }
    incrementCounter(name) { this.snapshot[name] = (this.snapshot[name] || 0) + 1; }
    subscribe() {}
    format() { return '{}'; }
  }
  const modules = {
    './styles.css': {},
    './capabilities': { detectCapabilities: () => capability, detectCapabilitiesAsync: async () => capability },
    './diagnostics': { DiagnosticsStore: Diagnostics },
    './signaling': { VdsWebSignaling: Signaling, fetchServerConfig: async () => ({ iceServers: [] }), fetchPublicRooms: async () => [] },
    './playback-session': { EncodedMediaPlaybackSession: Playback },
    './upstream-recovery': { UpstreamRecovery: class { start() {} stop() {} mediaReady() {} } },
    './datachannel-protocol': { ENCODED_MEDIA_PROTOCOL: 'vds-media-encoded-v1', ENCODED_MEDIA_PROTOCOL_VERSION: 1,
      webEncodedMediaCapabilities: () => ({}) }
  };
  const location = { protocol: 'https:', host: 'fixture.test', search: '' };
  const context = vm.createContext({
    exports: {}, require: (request) => {
      assert.ok(modules[request], `unexpected production import ${request}`);
      return modules[request];
    },
    navigator: { userActivation: { isActive: activeGesture } }, location,
    sessionStorage: { getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { location, addEventListener() {},
      setTimeout: (callback) => { const id = Symbol(); clock.set(id, callback); return id; },
      clearTimeout: (id) => clock.delete(id) },
    document: { getElementById: element, addEventListener() {}, fullscreenEnabled: false },
    performance: { now: () => 0 }, Date, URLSearchParams,
    console: { info: (value) => calls.console.push(value), warn() {}, error() {} }
  });
  const filename = path.resolve(__dirname, '../../vds_web/src/main.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  vm.runInContext(code, context, { filename });
  return { calls, elements, storage, clock,
    get signaling() { return signaling; }, get playback() { return playback; }, get diagnostics() { return diagnostics; } };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function joined(h) {
  h.signaling.message({ type: 'room-joined', roomId: 'ABC234', sessionToken: 'fixture-new-token',
    hostId: 'host-peer', upstreamPeerId: 'host-peer', chainPosition: 0,
    mediaManifest: { protocol: 'vds-media-encoded-v1', video: { codec: 'h264', payloadFormat: 'annexb' },
      audio: { codec: 'opus', payloadFormat: 'opus-raw' } } });
}

test('the complete Web entry point joins through its real button while AudioContext.resume stays pending', async () => {
  const h = harness();
  await flush();
  h.elements.get('roomIdInput').value = 'ABC234';
  h.elements.get('joinButton').handlers.get('click')();
  await flush();
  assert.equal(h.calls.audio, 1);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].type, 'join-room');
  joined(h);
  await flush();
  assert.equal(h.diagnostics.snapshot.roomId, 'ABC234');
  assert.equal(h.diagnostics.snapshot.status, '等待上游');
  assert.equal(h.clock.size, 0, 'actual room acknowledgement clears the join deadline');
  h.playback.callbacks.audio.onOutputState('suspended');
  h.playback.callbacks.onState('playing');
  h.playback.callbacks.audio.onDroppedBlock('web-audio-output-awaiting-gesture');
  assert.equal(h.diagnostics.snapshot.status, '观看中');
  assert.equal(h.diagnostics.snapshot.lastError, undefined);
  assert.equal(h.diagnostics.snapshot.playbackFailureReason, undefined);
  assert.equal(h.diagnostics.snapshot.webDroppedAudioBlocks, 1);
  assert.match(h.elements.get('statusText').textContent, /点击画面开启声音/);
  h.playback.callbacks.audio.onOutputState('running');
  assert.equal(h.elements.get('statusText').textContent, '观看中');
});

test('the complete Web entry point restores signaling without pre-creating audio outside a user gesture', async () => {
  const h = harness({ savedSession: true, activeGesture: false });
  await flush();
  assert.equal(h.calls.audio, 0);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].type, 'join-room');
  assert.equal(h.calls.sent[0].roomId, 'ABC234');
  assert.equal(h.calls.sent[0].sessionToken, 'fixture-token');
  joined(h);
  await flush();
  assert.equal(h.diagnostics.snapshot.status, '等待上游');
  assert.equal(h.clock.size, 0);
});
