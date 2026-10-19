const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { NatMappingLeases } = require('../../desktop/nat-mapping-leases');
const { buildPcpMapRequest, parsePcpMapResponse } = require('../../desktop/pcp-packet');

const baseline = process.env.VDS_NAT_LEASE_BASELINE === '1';
const filename = path.resolve(__dirname, baseline ? '../../tmp/nat-lease-before/main.js' : '../../desktop/main.js');
function loadFunctions(names, globals) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declarations = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.set(node.name.text, node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of names) assert.ok(declarations.has(name), name);
  return new Function(...Object.keys(globals), `${[...declarations.values()].join('\n')}\nreturn {${names.join(',')}};`)(...Object.values(globals));
}
const bind = (socket) => new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
const close = (socket) => new Promise((resolve) => socket.close(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const protocol of ['pcp', 'nat-pmp']) {
  test(`${protocol}: real UDP path survives a shortened lease and lost renewal, then closes cleanly`, { timeout: 20000 }, async () => {
    const router = dgram.createSocket('udp4'), publicPort = dgram.createSocket('udp4');
    const host = dgram.createSocket('udp4'), viewer = dgram.createSocket('udp4');
    await Promise.all([router, publicPort, host, viewer].map(bind));
    let expiresAt = 0, nonce = null, active = false, mappedPort = 0;
    let mapRequests = 0, renewals = 0, deletes = 0, expiredDrops = 0, received = 0, packetNumber = 0;
    const requests = [], errors = [], payloads = new Map();
    const failures = [];
    const leases = new NatMappingLeases({ random: () => 0, onError: (error) => errors.push(error.message) });
    const owner = leases.beginCreate({ peerId: 'viewer' });
    leases.completeCreate(owner, { peerId: 'viewer', transportGeneration: 'wire-g1' });
    router.on('message', (request, peer) => {
      try {
        let response;
        if (request[0] === 0 && request[1] === 0) {
          response = Buffer.alloc(12); response[1] = 128;
          if (protocol !== 'nat-pmp') response.writeUInt16BE(1, 2);
          else Buffer.from([127, 0, 0, 1]).copy(response, 8);
        } else if (request[0] === 0 && protocol === 'pcp') {
          response = Buffer.alloc(16); response[1] = 129; response.writeUInt16BE(1, 2);
        } else {
          const pcp = request[0] === 2;
          assert.equal(pcp ? 'pcp' : 'nat-pmp', protocol);
          const lifetime = pcp ? request.readUInt32BE(4) : request.readUInt32BE(8);
          const internalPort = pcp ? request.readUInt16BE(40) : request.readUInt16BE(4);
          assert.equal(internalPort, host.address().port);
          if (pcp) {
            if (!nonce) nonce = Buffer.from(request.subarray(24, 36));
            assert.ok(nonce.equals(request.subarray(24, 36)), 'PCP nonce must survive renew and delete');
            assert.equal(request.subarray(8, 24).toString('hex'), '00000000000000000000ffff7f000001');
          }
          requests.push({ lifetime, suggestedPort: request.readUInt16BE(pcp ? 42 : 6) });
          if (lifetime) {
            ++mapRequests;
            if (mapRequests > 1) {
              assert.equal(request.readUInt16BE(pcp ? 42 : 6), publicPort.address().port);
              if (pcp) assert.equal(request.subarray(44, 60).toString('hex'), '00000000000000000000ffff7f000001');
              // Lose the first renewal request entirely: do not extend its lease.
              if (++renewals === 1) return;
            }
            mappedPort = internalPort; active = true; expiresAt = Date.now() + 4000;
          } else {
            ++deletes; active = false;
            assert.equal(request.readUInt16BE(pcp ? 42 : 6), 0);
            if (pcp) assert.ok(request.subarray(44, 60).every((byte) => byte === 0));
          }
          if (pcp) {
            response = Buffer.alloc(60); response[0] = 2; response[1] = 0x81;
            request.copy(response, 24, 24, 44); response.writeUInt32BE(lifetime ? 4 : 0, 4);
            response.writeUInt16BE(lifetime ? publicPort.address().port : 0, 42);
            if (lifetime) Buffer.from('00000000000000000000ffff7f000001', 'hex').copy(response, 44);
          } else {
            response = Buffer.alloc(16); response[1] = 129;
            response.writeUInt16BE(internalPort, 8);
            response.writeUInt16BE(lifetime ? publicPort.address().port : 0, 10);
            response.writeUInt32BE(lifetime ? 4 : 0, 12);
          }
        }
        router.send(response, peer.port, peer.address);
      } catch (error) { failures.push(error); }
    });
    // The public socket forwards only while an explicit lease is active. The
    // host must actually echo the 4096-byte payload; the router cannot fake it.
    publicPort.on('message', (packet, peer) => {
      if (!active || Date.now() >= expiresAt) { ++expiredDrops; return; }
      if (peer.port === host.address().port) publicPort.send(packet, viewer.address().port, '127.0.0.1');
      else publicPort.send(packet, mappedPort, '127.0.0.1');
    });
    host.on('message', (packet, peer) => host.send(packet, peer.port, peer.address));
    viewer.on('message', (packet) => {
      const expected = payloads.get(packet.readUInt32BE(0));
      if (!expected || !packet.equals(expected)) failures.push(new Error('payload-corrupted-or-duplicated'));
      else { ++received; payloads.delete(packet.readUInt32BE(0)); }
    });
    let sending;
    try {
      const { udpRequest } = loadFunctions(['udpRequest'], { dgram });
      const names = ['requestNatPmpExternalAddress', 'requestNatPmpMapping', 'requestPcpMapping',
        'parseIceCandidateForMapping', 'isValidIpv4', 'bufferToIpv4', 'buildMappedIceCandidate', 'openP2PNatMappings'];
      if (!baseline) names.push('createP2PNatLease');
      const functions = loadFunctions(names, {
        crypto, buildPcpMapRequest, parsePcpMapResponse, natMappingLeases: leases,
        udpRequest: (address, _port, payload, timeout, localAddress) => udpRequest(address, router.address().port, payload, timeout, localAddress),
        resolveDefaultGatewayIpv4: async () => '127.0.0.1', sendToRenderer: () => assert.fail('unchanged endpoint reannounced')
      });
      const result = await functions.openP2PNatMappings({ peerId: 'viewer', transportGeneration: 'wire-g1', lifetimeSeconds: 180,
        candidates: [{ candidate: `candidate:h 1 udp 200 127.0.0.1 ${host.address().port} typ host`, sdpMid: 'data' }] });
      assert.equal(result.ok, true);
      assert.match(result.candidates[0].candidate, new RegExp(` ${publicPort.address().port} typ srflx`));
      sending = setInterval(() => {
        const packet = Buffer.alloc(4096, 0x5a); packet.writeUInt32BE(++packetNumber, 0);
        payloads.set(packetNumber, packet); viewer.send(packet, publicPort.address().port, '127.0.0.1');
      }, 25);
      await pause(8500);
      clearInterval(sending); sending = null; await pause(100);
      console.log(JSON.stringify({ protocol, baseline, requests: requests.length, renewals, received, sent: packetNumber, expiredDrops, errors }));
      assert.deepEqual(failures, []);
      assert.equal(expiredDrops, 0, 'router-granted lease expired while the native peer was still alive');
      assert.equal(received, packetNumber);
      assert.ok(received > 200);
      assert.ok(renewals >= 3);
      assert.ok(errors.includes('udp-request-timeout'));
      await leases.dispose();
      assert.equal(deletes, 1); assert.equal(active, false);
      const afterClose = requests.length; await pause(100);
      assert.equal(requests.length, afterClose, 'closed peer kept renewing');
    } finally {
      if (sending) clearInterval(sending);
      await leases.dispose();
      await Promise.all([router, publicPort, host, viewer].map(close));
    }
  });
}
