const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { NatMappingLeases } = require('../../desktop/nat-mapping-leases');
const { UpnpMappingJournal } = require('../../desktop/upnp-mapping-journal');
const { buildPcpMapRequest, parsePcpMapResponse } = require('../../desktop/pcp-packet');
const { loadMappingFunctions } = require('../fixtures/nat-main-functions');
const { tcpMappingRouter } = require('../fixtures/tcp-mapping-router');

for (const protocol of ['pcp', 'nat-pmp', 'upnp']) {
  test(`${protocol}: same-port TCP closure leaves the UDP owner's lease intact`, { timeout: 15000 }, async () => {
    const router = await tcpMappingRouter(protocol), leases = new NatMappingLeases();
    const sockets = new Set();
    const host = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    const functions = loadMappingFunctions({ dgram, crypto, buildPcpMapRequest, parsePcpMapResponse, natMappingLeases: leases,
      upnpPortMapper: router.mapper, resolveDefaultGatewayIpv4: async () => '127.0.0.1', sendToRenderer() {},
      gatewayRequest: (request, address, _port, ...args) => request(address, router.controlPort, ...args) });
    const port = host.address().port;
    let viewer;
    try {
      for (const transport of ['udp', 'tcp']) {
        const owner = leases.beginCreate({ peerId: transport });
        leases.completeCreate(owner, { peerId: transport, transportGeneration: 'g' });
        const result = await functions.openP2PNatMappings({ peerId: transport, transportGeneration: 'g', candidates: [
          { candidate: `candidate:${transport} 1 ${transport} 200 127.0.0.1 ${port} typ host${transport === 'tcp' ? ' tcptype passive' : ''}` }
        ] });
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      assert.equal(leases.leases.size, 2); assert.equal(router.entries.size, 2);
      const mapped = router.entries.get(`tcp:${port}`);
      viewer = net.connect({ host: protocol === 'upnp' ? '127.0.0.2' : '127.0.0.1', port: mapped.externalPort });
      await once(viewer, 'connect');
      const payload = crypto.randomBytes(4096);
      const echo = new Promise((resolve, reject) => {
        let received = Buffer.alloc(0);
        viewer.on('error', reject); viewer.on('data', (data) => { received = Buffer.concat([received, data]); if (received.length >= payload.length) resolve(received); });
      });
      viewer.write(payload); assert.deepEqual(await echo, payload);
      leases.closePeer({ peerId: 'tcp', transportGeneration: 'g' });
      await Promise.all([...leases.leases.values()].map((lease) => lease.closing).filter(Boolean));
      assert.equal(router.entries.has(`tcp:${port}`), false);
      assert.equal(router.entries.has(`udp:${port}`), true);
      assert.equal(router.calls.filter((call) => call.lifetime === 0 && call.transport === 'udp').length, 0);
      await leases.dispose(); assert.equal(router.entries.size, 0); assert.deepEqual(router.errors, []);
    } finally {
      viewer?.destroy(); for (const socket of sockets) socket.destroy();
      await leases.dispose(); await router.stop(); await new Promise((resolve) => host.close(resolve));
    }
  });
}

test('UPnP journal recovery retains TCP transport and never deletes same-port UDP', async () => {
  const parent = path.resolve(__dirname, '../../tmp'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'tcp-journal-'));
  const router = await tcpMappingRouter('upnp');
  const listener = net.createServer(); await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const candidate = { address: '127.0.0.1', port: listener.address().port };
  let udp;
  try {
    udp = await router.mapper.createLease('127.0.0.1', candidate, 180);
    const journal = new UpnpMappingJournal({ directory, isAlive: () => false });
    router.mapper.journal = journal;
    await router.mapper.createLease('127.0.0.1', { ...candidate, transport: 'tcp' }, 180);
    const [record] = await journal.orphans();
    assert.equal(record.transport, 'tcp');
    await router.mapper.recoverOrphans();
    assert.equal(router.entries.has(`tcp:${candidate.port}`), false);
    assert.equal(router.entries.has(`udp:${candidate.port}`), true);
    assert.deepEqual(await journal.orphans(), []);
    assert.deepEqual(router.errors, []);
    await assert.rejects(journal.remember({ ...record, transport: 'sctp' }), /invalid-record/);
    const legacy = router.entries.get(`udp:${candidate.port}`);
    await journal.remember({ ...record, description: legacy.identity, transport: undefined, externalPort: legacy.externalPort });
    await router.mapper.recoverOrphans();
    assert.equal(router.entries.size, 0, 'historical records without transport still release their UDP lease');
  } finally {
    await udp?.release(); await router.stop(); await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(directory), parent);
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  }
});
