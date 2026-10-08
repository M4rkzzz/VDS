const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { StunServerSelector, normalizeStunUrls, getStunServerPool } = require('../../desktop/stun-server-selector');

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
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, '../../desktop/main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const call = source.statements.map((statement) => statement.expression).find((expression) =>
    expression && ts.isCallExpression(expression) && expression.expression.getText(source) === 'ipcBoundary.handle' &&
    expression.arguments[0]?.getText(source) === 'ipcMain' && expression.arguments[1]?.text === 'media-engine-create-peer');
  assert.ok(call, 'production createPeer IPC handler exists');
  return new Function(...Object.keys(globals), `return (${call.arguments[2].getText(source)});`)(...Object.values(globals));
}

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
    getStunServerPool,
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
    getStunServerPool,
    logMainProcessDebug: () => {},
    invokeMediaEngine: async (_method, received) => { options = received; }
  });
  await handler(null, { peerId: 'native-defaults' });
  assert.deepEqual(options.stunServers, [defaults[1], defaults[0], defaults[2], defaults[3]]);
  assert.equal(options.stunServer, defaults[1]);
  assert.equal('iceServers' in options, false);
  assert.deepEqual(getStunServerPool([{ urls: ['turn:blocked.example:3478'] }]), defaults);
});
