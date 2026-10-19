const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { StunServerSelector, normalizeStunUrls, getStunServerPool, getNativeStunServerPool } = require('../../desktop/stun-server-selector');
const { prepareNativeStunConfiguration } = require('../../desktop/native-stun-discovery');

async function stunFixture(reply) {
  const socket = dgram.createSocket('udp4');
  let received = 0;
  socket.on('message', (request, peer) => {
    received++;
    if (!reply) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101);
    response.writeUInt16BE(12, 2);
    request.copy(response, 4, 4, 20);
    response.writeUInt16BE(0x0020, 20);
    response.writeUInt16BE(8, 22);
    response[25] = 1;
    response.writeUInt16BE(peer.port ^ 0x2112, 26);
    for (let i = 0; i < 4; i++) response[28 + i] = Number(peer.address.split('.')[i]) ^ request[4 + i];
    socket.send(reply(response), peer.port, peer.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    url: `stun:127.0.0.1:${socket.address().port}`,
    received: () => received,
    close: () => new Promise((resolve) => socket.close(resolve))
  };
}

test('selects a responding STUN over a silent first entry and shares the selection across peers', async () => {
  const silent = await stunFixture(null);
  const responding = await stunFixture((response) => response);
  try {
    const selector = new StunServerSelector({ timeoutMs: 150 });
    const servers = [{ urls: [silent.url, responding.url] }];
    const results = await Promise.all([selector.select(servers), selector.select(servers)]);
    assert.deepEqual(results[0], { url: responding.url, reachable: true });
    assert.equal(results[1].url, responding.url);
    assert.equal(responding.received(), 1, 'parallel peers share a probe');
    await selector.select(servers);
    assert.equal(responding.received(), 1, 'later peers use the short cache');
  } finally { await silent.close(); await responding.close(); }
});

test('a forged transaction or truncated mapped address is not a usable STUN response', async () => {
  const forged = await stunFixture((response) => { response[8] ^= 1; return response; });
  const truncated = await stunFixture((response) => response.subarray(0, 30));
  try {
    const selector = new StunServerSelector({ timeoutMs: 80 });
    assert.deepEqual(await selector.select([{ urls: [forged.url, truncated.url] }]), { url: forged.url, reachable: false });
  } finally { await forged.close(); await truncated.close(); }
});

test('only STUN URLs can reach native selection and unavailable STUN does not reject LAN peers', async () => {
  assert.deepEqual(normalizeStunUrls([
    { urls: ['turn:relay.example:3478', 'turns:relay.example:5349', 'stun:user:password@example.org', 'stun:example.org:0'] },
    { urls: ['stun:example.org:3478', 'stun:[::1]:3478', 'stun:example.org:3478'] }
  ]), ['stun:example.org:3478', 'stun:[::1]:3478']);
  assert.deepEqual(normalizeStunUrls([{ urls: ['STUN:EXAMPLE.ORG:03478', 'stun:[:::]:3478', 'stun:-invalid:3478'] }]), ['stun:example.org:3478']);
  assert.deepEqual(normalizeStunUrls([{ urls: ['stun:[::ffff:127.0.0.1]:3478'] }]), ['stun:[::ffff:127.0.0.1]:3478']);
  const silent = await stunFixture(null);
  try {
    const selector = new StunServerSelector({ timeoutMs: 50 });
    const choice = await selector.select([{ urls: [silent.url, 'turn:blocked.example:3478'] }]);
    assert.equal(choice.url, silent.url);
    assert.equal(choice.reachable, false);
  } finally { await silent.close(); }
});

function createPeerIpcHandler(globals) {
  globals = { prepareNativeStunConfiguration, nativeStunDiscovery: { resolve: async (pool) => pool }, ...globals };
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, '../../desktop/main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const call = source.statements.map((statement) => statement.expression).find((expression) =>
    expression && ts.isCallExpression(expression) && expression.expression.getText(source) === 'ipcBoundary.handle' &&
    expression.arguments[0]?.getText(source) === 'ipcMain' && expression.arguments[1]?.text === 'media-engine-create-peer');
  assert.ok(call, 'production createPeer IPC handler exists');
  return new Function(...Object.keys(globals), `return (${call.arguments[2].getText(source)});`)(...Object.values(globals));
}

test('TCP STUN survives the real IPC handler without displacing the four UDP probes', async () => {
  const udp = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `stun:udp${n}.example:3478`);
  const tcp = ['stun:[::1]:3478?transport=tcp', 'stun:tcp.example?transport=tcp'];
  const servers = [{ urls: [...udp, ...tcp, 'turn:relay.example?transport=tcp'] }];
  let received;
  const handler = createPeerIpcHandler({
    nativeStunSelector: { select: async () => ({ url: udp[2], reachable: true }) },
    getNativeStunServerPool,
    logMainProcessDebug: () => {},
    invokeMediaEngine: async (_method, options) => { received = options; }
  });
  await handler(null, { peerId: 'mixed', iceServers: servers });
  assert.deepEqual(received.stunServers, [udp[2], udp[0], udp[1], udp[3], ...tcp]);
  assert.deepEqual(normalizeStunUrls([{ urls: [
    'STUN:[::1]:03478?TRANSPORT=TCP', 'stun:udp.example?transport=udp',
    'stun:udp.example', 'stun:bad.example?transport=tls',
    'stun:bad.example?transport=tcp&transport=udp', 'stun:?transport=tcp'
  ] }]), ['stun:[::1]:3478?transport=tcp', 'stun:udp.example']);
});

test('desktop never sends a UDP preflight to a TCP-only discovery endpoint', async () => {
  const trap = await stunFixture((response) => response);
  try {
    const tcp = `${trap.url}?transport=tcp`;
    assert.deepEqual(await new StunServerSelector({ timeoutMs: 50 }).select([{ urls: [tcp] }]),
      { url: tcp, reachable: false });
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(trap.received(), 0);
  } finally { await trap.close(); }
});

test('native IPC receives the reachable primary followed by a bounded pure STUN pool', async () => {
  const servers = [{ urls: [
    'turn:blocked.example:3478', 'stun:first.example:3478', 'stun:[::1]:3478',
    'stun:third.example:3478', 'stun:fourth.example:3478', 'stun:fifth.example:3478'
  ] }];
  let invoked;
  const handler = createPeerIpcHandler({
    nativeStunSelector: { select: async (received) => {
      assert.equal(received, servers);
      return { url: 'stun:third.example:3478', reachable: true };
    } },
    getNativeStunServerPool,
    logMainProcessDebug: () => {},
    invokeMediaEngine: async (method, options) => { invoked = { method, options }; return { ok: true }; }
  });
  assert.deepEqual(await handler(null, { iceServers: servers, peerId: 'native-pool', initiator: false }), { ok: true });
  assert.deepEqual(invoked, { method: 'createPeer', options: {
    peerId: 'native-pool', initiator: false, stunServer: 'stun:third.example:3478',
    stunServers: ['stun:third.example:3478', 'stun:first.example:3478', 'stun:[::1]:3478', 'stun:fourth.example:3478']
  } });
});

test('native IPC uses the existing server first four STUN defaults when no pool is configured', async () => {
  const defaults = getStunServerPool();
  assert.deepEqual(defaults, [
    'stun:stun.cloudflare.com:3478', 'stun:stun.linphone.org:3478',
    'stun:stun.freeswitch.org:3478', 'stun:stun.pjsip.org:3478'
  ]);
  let options;
  const handler = createPeerIpcHandler({
    nativeStunSelector: { select: async () => ({ url: defaults[1], reachable: true }) },
    getNativeStunServerPool,
    logMainProcessDebug: () => {},
    invokeMediaEngine: async (_method, received) => { options = received; }
  });
  await handler(null, { peerId: 'native-defaults' });
  assert.deepEqual(options.stunServers, [defaults[1], defaults[0], defaults[2], defaults[3],
    'stun:turn.cloudflare.com:3478?transport=tcp']);
  assert.equal(options.stunServer, defaults[1]);
  assert.equal('iceServers' in options, false);
  assert.deepEqual(getStunServerPool([{ urls: ['turn:blocked.example:3478'] }]), defaults);
});

test('normal signaling defaults activate native TCP discovery without mutating browser configuration', () => {
  const urls = [...getStunServerPool(), 'stun:fifth.example:3478'];
  const servers = [{ urls }];
  assert.deepEqual(getNativeStunServerPool(servers, urls[2]),
    [urls[2], urls[0], urls[1], urls[3], 'stun:turn.cloudflare.com:3478?transport=tcp']);
  assert.equal(urls.length, 5);
  assert.ok(!urls.some((url) => url.includes('transport=tcp')));
  const explicit = [...servers, { urls: 'stun:my-tcp.example:3478?transport=tcp' }];
  assert.deepEqual(getNativeStunServerPool(explicit, urls[0]),
    [...urls.slice(0, 4), 'stun:my-tcp.example:3478?transport=tcp']);
  assert.deepEqual(getNativeStunServerPool([{ urls: 'stun:private.example:3478' }]),
    ['stun:private.example:3478']);
});

test('parallel discovery retains a reachable UDP primary beyond the initial four endpoints', async () => {
  const urls = getStunServerPool().concat(['stun:fifth.example:3478', 'stun:sixth.example:3478']);
  const reachable = urls[5];
  let received;
  const handler = createPeerIpcHandler({
    nativeStunSelector: { select: async () => ({ url: reachable, reachable: true }) },
    nativeStunDiscovery: { resolve: async (pool) => [...pool, 'stun:141.101.90.1:3478?transport=tcp'] },
    getNativeStunServerPool, logMainProcessDebug: () => {},
    invokeMediaEngine: async (_method, options) => { received = options; }
  });
  await handler(null, { peerId: 'late-primary', iceServers: [{ urls }] });
  assert.equal(received.stunServer, reachable);
  assert.deepEqual(received.stunServers.slice(0, 4), [reachable, ...urls.slice(0, 3)]);
  assert.ok(received.stunServers.includes('stun:141.101.90.1:3478?transport=tcp'));
});
