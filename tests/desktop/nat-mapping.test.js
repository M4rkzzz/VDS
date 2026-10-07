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
    const requestMapping = loadFunction('desktop/main.js', 'requestPcpUdpMapping', {
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
    parseIceCandidateForMapping: (candidate) => candidate,
    resolveDefaultGatewayIpv4: async (address) => address === addresses[0] ? '192.0.2.1' : '192.0.2.2',
    requestNatPmpExternalAddress: async () => '',
    requestNatPmpUdpMapping: async () => { throw new Error('router-supports-pcp'); },
    requestPcpUdpMapping: async (gateway, port, _lifetime, address) => {
      started.push({ gateway, port, address });
      await gate;
      return { externalAddress: '198.51.100.5', externalPort: port };
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
