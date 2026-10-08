const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createIpcBoundary } = require('../../desktop/ipc-boundary');

const entryUrl = 'file:///D:/project/videosharing/server/public/index.html';

function fixture(onRejected) {
  const handles = new Map();
  const listeners = new Map();
  const mainFrame = { url: entryUrl };
  const webContents = { mainFrame, isDestroyed: () => false };
  let window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  const rejected = [];
  const ipcMain = {
    handle(channel, handler) { handles.set(channel, handler); },
    on(channel, handler) { listeners.set(channel, handler); }
  };
  const boundary = createIpcBoundary({
    getWindow: () => window,
    entryUrl,
    onRejected: onRejected || ((error, channel) => rejected.push({ error, channel }))
  });
  function invoke(channel, ...args) {
    boundary.handle(ipcMain, channel, (_event, ...values) => values);
    return handles.get(channel)(event, ...args);
  }
  return { boundary, ipcMain, handles, listeners, mainFrame, webContents, event, rejected, invoke, setWindow(value) { window = value; } };
}

test('only the current main window, main frame and exact application file can invoke handlers', async () => {
  const f = fixture();
  let calls = 0;
  f.boundary.handle(f.ipcMain, 'get-app-version', () => { calls += 1; return '1.7.2'; });
  const invoke = f.handles.get('get-app-version');
  assert.equal(await invoke(f.event), '1.7.2');
  const foreignContents = { mainFrame: { url: entryUrl } };
  const subframe = { url: entryUrl };
  for (const event of [
    { sender: foreignContents, senderFrame: foreignContents.mainFrame },
    { sender: f.webContents, senderFrame: subframe },
    { sender: f.webContents, senderFrame: null },
    null
  ]) await assert.rejects(invoke(event), { code: 'IPC_UNTRUSTED_SENDER' });
  for (const url of ['file:///D:/other/index.html', `${entryUrl}?spoof=1`, `${entryUrl}#spoof`, 'https://boshan.s.3q.hair/']) {
    f.mainFrame.url = url;
    await assert.rejects(invoke(f.event), { code: 'IPC_UNTRUSTED_SENDER' });
  }
  f.mainFrame.url = entryUrl;
  f.setWindow(null);
  await assert.rejects(invoke(f.event), { code: 'IPC_UNTRUSTED_SENDER' });
  assert.equal(calls, 1);
  assert.equal(f.rejected.length, 9);
});

test('destroyed windows and contents cannot reach the application', async () => {
  const f = fixture();
  f.webContents.isDestroyed = () => true;
  await assert.rejects(f.invoke('window-close'), { code: 'IPC_UNTRUSTED_SENDER' });
  f.webContents.isDestroyed = () => false;
  f.setWindow({ webContents: f.webContents, isDestroyed: () => true });
  await assert.rejects(f.invoke('window-close'), { code: 'IPC_UNTRUSTED_SENDER' });
});

test('fire-and-forget IPC safely reports invalid senders, invalid arguments and handler failures', async () => {
  const f = fixture();
  let calls = 0;
  f.boundary.on(f.ipcMain, 'window-close', () => { calls += 1; });
  const close = f.listeners.get('window-close');
  assert.doesNotThrow(() => close({ sender: {}, senderFrame: f.mainFrame }));
  assert.doesNotThrow(() => close(f.event, 'unexpected'));
  close(f.event);
  assert.equal(calls, 1);
  assert.deepEqual(f.rejected.map(item => item.error.code), ['IPC_UNTRUSTED_SENDER', 'IPC_INVALID_ARGUMENT']);
  f.boundary.on(f.ipcMain, 'window-close', () => { throw new Error('sync-handler-failure'); });
  assert.doesNotThrow(() => f.listeners.get('window-close')(f.event));
  f.boundary.on(f.ipcMain, 'window-close', async () => { throw new Error('async-handler-failure'); });
  assert.doesNotThrow(() => f.listeners.get('window-close')(f.event));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.rejected.slice(2).map(item => item.error.message), ['sync-handler-failure', 'async-handler-failure']);
  const throwingReporter = fixture(() => { throw new Error('reporter-failure'); });
  throwingReporter.boundary.on(throwingReporter.ipcMain, 'window-close', () => {});
  assert.doesNotThrow(() => throwingReporter.listeners.get('window-close')({}));
});

test('ordinary invoke handler failures propagate without being misreported as a boundary rejection', async () => {
  const f = fixture();
  f.boundary.handle(f.ipcMain, 'get-app-version', async () => { throw new Error('ordinary-handler-failure'); });
  await assert.rejects(f.handles.get('get-app-version')(f.event), { message: 'ordinary-handler-failure' });
  assert.deepEqual(f.rejected, []);
});

test('all no-argument application operations work and reject surplus arguments', async () => {
  const f = fixture();
  for (const channel of [
    'get-app-version', 'get-update-log-snapshot', 'media-engine-start',
    'media-engine-list-capture-targets', 'media-engine-audio-is-platform-supported',
    'media-engine-audio-check-permission', 'media-engine-audio-get-process-list',
    'media-engine-get-viewer-volume', 'media-engine-get-capabilities',
    'window-is-maximized', 'window-get-bounds', 'window-get-cursor-screen-point',
    'window-is-fullscreen', 'window-minimize', 'window-minimize-to-tray',
    'window-maximize', 'window-close', 'check-for-updates', 'download-update', 'quit-and-install'
  ]) {
    assert.deepEqual(await f.invoke(channel), []);
    await assert.rejects(f.invoke(channel, {}), { code: 'IPC_INVALID_ARGUMENT' });
  }
});

test('window, clipboard and viewer controls retain legitimate input types', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('window-set-fullscreen', true), [true]);
  assert.deepEqual(await f.invoke('clipboard-write-text', 'VDS diagnostic\n第二行'), ['VDS diagnostic\n第二行']);
  assert.deepEqual(await f.invoke('media-engine-set-viewer-volume', 0.375), [0.375]);
  assert.deepEqual(await f.invoke('media-engine-set-viewer-audio-delay', { delayMs: -120 }), [{ delayMs: -120 }]);
  for (const [channel, value] of [
    ['window-set-fullscreen', 1], ['clipboard-write-text', {}],
    ['media-engine-set-viewer-volume', '0.5'], ['media-engine-set-viewer-volume', -1],
    ['media-engine-set-viewer-volume', Infinity], ['media-engine-set-viewer-audio-delay', { delayMs: '20' }]
  ]) await assert.rejects(f.invoke(channel, value), { code: 'IPC_INVALID_ARGUMENT' });
});

test('peer creation accepts the current renderer contract and extensible JSON options', async () => {
  const f = fixture();
  const options = {
    peerId: 'viewer-1', role: 'viewer-upstream', initiator: false, encodedMediaDataChannel: true,
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }, 'stun:stun.example.net'],
    mediaManifest: { manifestVersion: 1, mediaSessionId: 'media-1', video: { codec: 'h264', frameRate: 240 }, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } },
    futureTransportOption: { mode: 'new-mode', ordered: false, layers: [1, 2, 3], optionalValue: null }
  };
  assert.deepEqual(await f.invoke('media-engine-create-peer', options), [options]);
  assert.deepEqual(await f.invoke('media-engine-close-peer', { peerId: 'viewer-1', transportGeneration: 'generation-2' }), [{ peerId: 'viewer-1', transportGeneration: 'generation-2' }]);
  for (const options of [{}, { peerId: 1 }, { peerId: 'x'.repeat(257) }, { peerId: 'p', initiator: 'yes' }, { peerId: 'p', mediaManifest: [] }, { peerId: 'p', iceServers: {} }]) {
    await assert.rejects(f.invoke('media-engine-create-peer', options), { code: 'IPC_INVALID_ARGUMENT' });
  }
});

test('SDP and ICE limits reject malformed or oversized signaling before native RPC', async () => {
  const f = fixture();
  const description = { peerId: 'p', type: 'answer', sdp: 'x'.repeat(1024 * 1024), mediaManifest: null };
  assert.deepEqual(await f.invoke('media-engine-set-remote-description', description), [description]);
  const ice = { peerId: 'p', candidate: 'x'.repeat(16 * 1024), transportGeneration: 'g' };
  assert.deepEqual(await f.invoke('media-engine-add-remote-ice-candidate', ice), [ice]);
  for (const options of [{ ...description, type: 'not-sdp' }, { ...description, sdp: 'x'.repeat(1024 * 1024 + 1) }, { ...description, sdp: [] }, { ...description, peerId: '' }]) {
    await assert.rejects(f.invoke('media-engine-set-remote-description', options), { code: 'IPC_INVALID_ARGUMENT' });
  }
  for (const options of [{ ...ice, candidate: 'x'.repeat(16 * 1024 + 1) }, { ...ice, candidate: {} }, { ...ice, sdpMLineIndex: NaN }]) {
    await assert.rejects(f.invoke('media-engine-add-remote-ice-candidate', options), { code: 'IPC_INVALID_ARGUMENT' });
  }
});

test('host, audio, OBS and thumbnail options remain compatible without frame-rate or bitrate caps', async () => {
  const f = fixture();
  const operations = [
    ['media-engine-start-host-session', { backend: 'native', captureTargetId: 'screen:0:0', captureHwnd: '', captureKind: 'display', width: 16384, height: 9216, frameRate: 960, bitrateKbps: 1000000000, mediaSessionId: 'm' }],
    ['media-engine-stop-host-session', undefined],
    ['media-engine-prepare-obs-ingest', { port: 0, refresh: true, mediaSessionId: 'm' }],
    ['media-engine-start-audio-session', { pid: 1234, processName: '', mediaSessionId: 'm' }],
    ['media-engine-stop-audio-session', {}],
    ['media-engine-get-stats', undefined],
    ['media-engine-get-capture-target-thumbnail', { sourceId: 'window:1234:0', hwnd: '1234', title: '播放器', kind: 'window' }]
  ];
  for (const [channel, options] of operations) assert.deepEqual(await f.invoke(channel, options), [options]);
  for (const [channel, options] of [
    ['media-engine-start-host-session', { frameRate: '60' }],
    ['media-engine-start-host-session', { bitrateKbps: Infinity }],
    ['media-engine-start-audio-session', { pid: 1.5 }],
    ['media-engine-prepare-obs-ingest', { port: 65536 }],
    ['media-engine-get-capture-target-thumbnail', {}]
  ]) await assert.rejects(f.invoke(channel, options), { code: 'IPC_INVALID_ARGUMENT' });
});

test('surface and media binding operations preserve negative monitor coordinates', async () => {
  const f = fixture();
  for (const [channel, options] of [
    ['media-engine-attach-peer-media-source', { peerId: 'downstream', source: 'peer-video:upstream' }],
    ['media-engine-detach-peer-media-source', { peerId: 'downstream' }],
    ['media-engine-attach-surface', { surface: 'viewer', target: 'peer-video:upstream', embedded: true, visible: true, x: -1920, y: -1080, width: 1920, height: 1080 }],
    ['media-engine-update-surface', { surface: 'viewer', visible: false }],
    ['media-engine-detach-surface', { surface: 'viewer' }]
  ]) assert.deepEqual(await f.invoke(channel, options), [options]);
  for (const [channel, options] of [
    ['media-engine-attach-peer-media-source', { peerId: 'p' }],
    ['media-engine-attach-surface', { surface: 'viewer', target: {} }],
    ['media-engine-update-surface', { surface: 'viewer', x: NaN }],
    ['media-engine-detach-surface', {}]
  ]) await assert.rejects(f.invoke(channel, options), { code: 'IPC_INVALID_ARGUMENT' });
});

test('NAT mapping accepts string and RTC-style candidates while bounding each candidate', async () => {
  const f = fixture();
  const options = {
    peerId: 'p', lifetimeSeconds: 180,
    candidates: ['candidate:1 1 udp 1 192.168.5.1 40000 typ host', { candidate: 'candidate:2 1 udp 1 ::1 40001 typ host', sdpMid: null, sdpMLineIndex: null }]
  };
  assert.deepEqual(await f.invoke('p2p-open-nat-mapping', options), [options]);
  for (const candidates of [{}, [12], [{ candidate: 'x'.repeat(16385) }], [{ candidate: 'x', sdpMLineIndex: '1' }]]) {
    await assert.rejects(f.invoke('p2p-open-nat-mapping', { candidates }), { code: 'IPC_INVALID_ARGUMENT' });
  }
});

test('options reject arrays, non-records, non-finite nested numbers and cycles', async () => {
  const f = fixture();
  const cycle = {};
  cycle.self = cycle;
  for (const value of [[], null, 1, true, 'options', new Date(), { future: { value: NaN } }, { future: [Infinity] }, { future: 1n }, cycle]) {
    await assert.rejects(f.invoke('media-engine-get-stats', value), { code: 'IPC_INVALID_ARGUMENT' });
  }
  const shared = { nested: 1 };
  const legitimate = { first: shared, second: shared, futureArray: [shared] };
  assert.deepEqual(await f.invoke('media-engine-get-stats', legitimate), [legitimate]);
});

test('debug configuration supports legacy booleans and current category/channel flags', async () => {
  const f = fixture();
  for (const config of [true, false, {}, { video: true }, { categories: { video: true, connection: false }, channels: { renderer: true, futureChannel: false } }]) {
    assert.deepEqual(await f.invoke('renderer-debug-config-changed', config), [config]);
  }
  for (const config of [[], null, { video: 'yes' }, { categories: [] }, { channels: { renderer: 1 } }]) {
    await assert.rejects(f.invoke('renderer-debug-config-changed', config), { code: 'IPC_INVALID_ARGUMENT' });
  }
});

test('unknown channels cannot silently bypass argument validation', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('new-unreviewed-operation'), { code: 'IPC_UNKNOWN_CHANNEL' });
});
