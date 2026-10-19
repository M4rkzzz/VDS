const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { buildPcpMapRequest, parsePcpMapResponse } = require('../../desktop/pcp-packet');

const root = path.resolve(__dirname, '../..');
function loadFunction(relative, name, globals) {
  const source = ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.ES2022, true);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, name);
  return new Function(...Object.keys(globals), `${declaration.getText(source)}; return ${name};`)(...Object.values(globals));
}

test('only real passive TCP listeners are eligible for explicit mapping', () => {
  const isValidIpv4 = loadFunction('desktop/main.js', 'isValidIpv4', {});
  const parse = loadFunction('desktop/main.js', 'parseIceCandidateForMapping', { isValidIpv4 });
  const make = loadFunction('desktop/main.js', 'buildMappedIceCandidate', { isValidIpv4 });
  for (const tail of ['tcptype active', 'tcptype so', '', 'tcptype unknown']) {
    assert.equal(parse(`candidate:t 1 TCP 200 192.0.2.1 9 typ host ${tail}`), null);
  }
  const passive = parse('candidate:t 1 TCP 200 192.0.2.1 54321 typ host tcptype passive');
  assert.equal(passive.transport, 'tcp');
  assert.equal(make(passive, { externalAddress: '198.51.100.2', externalPort: 60000 }).candidate,
    'candidate:tmp 1 tcp 1 198.51.100.2 60000 typ srflx raddr 192.0.2.1 rport 54321 tcptype passive');
  assert.equal(parse('candidate:u 1 UDP 200 192.0.2.1 54321 typ host').transport, 'udp');
});

test('renderer keeps TCP passive listeners and balances mapping slots with UDP interfaces', () => {
  const meta = { localMappableHostCandidates: [] };
  const remember = loadFunction('server/public/native/native-peer-controller.js', 'rememberLocalIceCandidate', {
    getPeerMeta: () => meta, normalizeIceCandidate: (candidate) => ({ candidate }), scheduleEarlyNatMapping() {}
  });
  const choose = loadFunction('server/public/native/native-peer-controller.js', 'getLocalMappableHostCandidates', { getPeerMeta: () => meta });
  for (let i = 1; i <= 5; ++i) remember('peer', `candidate:u${i} 1 udp 200 192.0.2.${i} 50000 typ host`);
  remember('peer', 'candidate:v6 1 udp 200 ::1 50000 typ host');
  remember('peer', 'candidate:a 1 tcp 200 192.0.2.1 9 typ host tcptype active');
  remember('peer', 'candidate:p 1 tcp 200 192.0.2.1 50000 typ host tcptype passive');
  const selected = choose('peer');
  assert.equal(selected.length, 4);
  assert.match(selected[1].candidate, /tcp .*tcptype passive/);
  assert.ok(selected.every((c) => !c.candidate.includes('::1') && !c.candidate.includes('tcptype active')));
});

test('same numeric UDP and TCP ports receive distinct gateway leases and candidates', async () => {
  const keys = [], started = [];
  const map = loadFunction('desktop/main.js', 'openP2PNatMappings', {
    natMappingLeases: { getPeer: () => ({}), acquire: (_owner, key, create) => { keys.push(key); return create().then((lease) => lease.mapping); } },
    parseIceCandidateForMapping: (candidate) => candidate,
    resolveDefaultGatewayIpv4: async () => '192.0.2.1',
    createP2PNatLease: async (_gateway, candidate) => { started.push(candidate.transport); return { mapping: { externalPort: 50001 } }; },
    buildMappedIceCandidate: (candidate) => candidate
  });
  const result = await map({ candidates: ['udp', 'tcp'].map((transport) => ({ address: '192.0.2.2', port: 50000, transport })) });
  assert.deepEqual(started.sort(), ['tcp', 'udp']);
  assert.equal(new Set(keys).size, 2);
  assert.equal(result.candidates.length, 2);
});

test('NAT-PMP cannot mistake a UDP reply for a successful TCP mapping', async () => {
  const request = loadFunction('desktop/main.js', 'requestNatPmpMapping', {
    udpRequest: async (_gateway, _port, packet) => {
      assert.equal(packet[1], 2);
      const wrongTransport = Buffer.alloc(16);
      wrongTransport[1] = 129;
      wrongTransport.writeUInt16BE(50000, 8); wrongTransport.writeUInt16BE(55000, 10);
      wrongTransport.writeUInt32BE(180, 12);
      return wrongTransport;
    }
  });
  await assert.rejects(request('192.0.2.1', 50000, 180, '192.0.2.2', {}, 'tcp'), /nat-pmp-map-failed/);
});

test('PCP uses the connected UDP socket source address and validates the actual returned mapping', async () => {
  const router = dgram.createSocket('udp4');
  const requests = [];
  router.on('message', (request, peer) => {
    requests.push(request);
    const response = Buffer.alloc(60);
    response[0] = 2; response[1] = 0x81;
    request.copy(response, 24, 24, 44);
    response.writeUInt32BE(180, 4);
    response.writeUInt16BE(55000, 42);
    Buffer.from('00000000000000000000ffffc6336405', 'hex').copy(response, 44);
    const source = Buffer.from('00000000000000000000ffff7f000001', 'hex');
    if (!request.subarray(8, 24).equals(source)) response[3] = 12;
    router.send(response, peer.port, peer.address);
  });
  await new Promise((resolve) => router.bind(0, '127.0.0.1', resolve));
  try {
    const udpRequest = loadFunction('desktop/main.js', 'udpRequest', { dgram });
    const requestMapping = loadFunction('desktop/main.js', 'requestPcpMapping', {
      crypto, buildPcpMapRequest, parsePcpMapResponse,
      udpRequest: (address, _port, payload, timeout, localAddress) => udpRequest(address, router.address().port, payload, timeout, localAddress)
    });
    const result = await requestMapping('127.0.0.1', 50000, 180, '127.0.0.1');
    assert.equal(result.externalPort, 55000);
    assert.equal(result.externalAddress, '198.51.100.5');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].subarray(8, 24).equals(Buffer.from('00000000000000000000ffff7f000001', 'hex')));
  } finally { await new Promise((resolve) => router.close(resolve)); }
});

test('same UDP port on different interfaces maps through each matching gateway concurrently', async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const addresses = ['192.0.2.10', '192.0.2.20'];
  const map = loadFunction('desktop/main.js', 'openP2PNatMappings', {
    natMappingLeases: { getPeer: () => ({}), acquire: (_owner, _key, create) => create().then((lease) => lease.mapping) },
    parseIceCandidateForMapping: (candidate) => candidate,
    resolveDefaultGatewayIpv4: async (address) => address === addresses[0] ? '192.0.2.1' : '192.0.2.2',
    createP2PNatLease: async (gateway, { port, address }) => {
      started.push({ gateway, port, address });
      await gate;
      return { mapping: { externalAddress: '198.51.100.5', externalPort: port } };
    },
    buildMappedIceCandidate: (candidate, mapping) => ({ address: candidate.address, port: mapping.externalPort })
  });
  const pending = map({ candidates: addresses.map((address) => ({ address, port: 50000 })) });
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = started.slice();
  release();
  const result = await pending;
  assert.deepEqual(concurrent, addresses.map((address, index) => ({ address, port: 50000, gateway: `192.0.2.${index + 1}` })));
  assert.equal(result.candidates.length, 2);
});

test('late NAT mapping success cannot publish a candidate or overwrite a replacement peer', async () => {
  let complete;
  const mapping = new Promise((resolve) => { complete = resolve; });
  let handle = { closed: false };
  const effects = [];
  const run = loadFunction('server/public/native/native-peer-controller.js', 'attemptLastChanceNatMapping', {
    options: { mediaEngine: { openNatMapping: () => mapping } },
    getPeerHandle: () => handle,
    beginNatMappingAttempt: () => ({ started: true, candidates: [] }),
    logNativeStep() {},
    applyNatMappingResult: () => effects.push('apply'),
    applyNatMappingError: () => effects.push('error'),
    sendNatMappedCandidatesAndArmWait: () => effects.push('send'),
    finishNatMappingAttempt: () => effects.push('finish')
  });
  const pending = run('viewer', 'timeout');
  handle = { closed: false };
  complete({ ok: true, candidates: [{ candidate: 'candidate:new' }] });
  assert.equal(await pending, false);
  assert.deepEqual(effects, []);
});
