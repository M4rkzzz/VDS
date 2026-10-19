const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const { test } = require('node:test');
const { UpnpPortMapper, parseXml, gatewayUrl } = require('../../desktop/upnp-port-mapper');
const { NatMappingLeases } = require('../../desktop/nat-mapping-leases');

const { fixture } = require('../fixtures/upnp-router');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('UPnP-only gateway becomes a real UDP route through the production protocol fallback and lease manager', { timeout: 15000 }, async () => {
  const f = await fixture();
  const leases = new NatMappingLeases({ random: () => 0 });
  let timer;
  try {
    const owner = leases.beginCreate({ peerId: 'peer' });
    leases.completeCreate(owner, { peerId: 'peer', transportGeneration: 'upnp-generation' });
    const filename = path.resolve(__dirname, '../../desktop/main.js');
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createP2PNatLease');
    const disabled = process.env.VDS_UPNP_BASELINE === '1';
    const factory = new Function('requestNatPmpExternalAddress', 'requestNatPmpMapping', 'requestPcpMapping', 'upnpPortMapper', 'crypto',
      `${declaration.getText(source)}; return createP2PNatLease;`)(
      async () => { throw new Error('nat-pmp-unsupported'); }, async () => { throw new Error('nat-pmp-unsupported'); },
      async () => { throw new Error('pcp-unsupported'); }, disabled ? { createLease: async () => { throw new Error('upnp-path-absent'); } } : f.mapper, crypto);
    const mapping = await leases.acquire(owner, `127.0.0.1:${f.candidate.port}`, (isActive) => factory('127.0.0.1', f.candidate, 180, isActive));
    assert.equal(mapping.protocol, 'upnp'); assert.equal(mapping.lifetimeSeconds, 2);
    let sent = 0, received = 0; const pending = new Map();
    f.viewer.on('message', (packet) => {
      const number = packet.readUInt32BE(0);
      assert.deepEqual(packet, pending.get(number)); pending.delete(number); ++received;
    });
    timer = setInterval(() => {
      const packet = Buffer.alloc(4096, 0x75); packet.writeUInt32BE(++sent, 0); pending.set(sent, packet);
      f.viewer.send(packet, mapping.externalPort, mapping.externalAddress);
    }, 25);
    await pause(4500); clearInterval(timer); timer = null; await pause(100);
    assert.equal(received, sent); assert.ok(received > 100);
    assert.ok(f.calls.filter((call) => call.action === 'AddPortMapping').length >= 3);
    await leases.dispose(); assert.equal(f.entries.size, 0);
    assert.deepEqual(f.failures, []);
    assert.ok(f.sources.every((address) => address === f.candidate.address));
    console.log(JSON.stringify({ protocol: mapping.protocol, sent, received, renewed: true, released: f.entries.size === 0 }));
  } finally { if (timer) clearInterval(timer); await leases.dispose(); await f.stop(); }
});

test('conflicting external ports and disconnected WAN services do not overwrite someone else’s mapping', async () => {
  const f = await fixture({ conflict: true, services: ['WANIPConnection:2', 'WANPPPConnection:1'], disconnectedV2: true });
  try {
    const original = { ...f.entries.get(f.candidate.port) };
    const lease = await f.mapper.createLease('127.0.0.1', f.candidate, 180);
    assert.notEqual(lease.mapping.externalPort, f.candidate.port);
    assert.deepEqual(f.entries.get(f.candidate.port), original);
    assert.ok(f.calls.some((call) => call.action === 'AddPortMapping' && call.type.endsWith('WANPPPConnection:1')));
    await lease.release(); assert.equal(f.entries.size, 1);
    assert.deepEqual(f.entries.get(f.candidate.port), original); assert.deepEqual(f.failures, []);
  } finally { await f.stop(); }
});

test('permanent-only routers are verified without repeated Add, and only owned mappings are deleted', async () => {
  const f = await fixture({ permanentOnly: true });
  try {
    const lease = await f.mapper.createLease('127.0.0.1', f.candidate, 180);
    assert.equal(lease.mapping.permanent, true); assert.equal(lease.mapping.lifetimeSeconds, 0);
    const adds = f.calls.filter((call) => call.action === 'AddPortMapping');
    assert.deepEqual(adds.map((call) => call.args.NewLeaseDuration), ['180', '0']);
    await lease.renew(lease.mapping);
    assert.equal(f.calls.filter((call) => call.action === 'AddPortMapping').length, 2);
    f.entries.get(lease.mapping.externalPort).NewPortMappingDescription = 'replacement-owner';
    await assert.rejects(lease.renew(lease.mapping), /owner-changed/);
    await lease.release(); assert.equal(f.entries.size, 1);
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 0);
    assert.deepEqual(f.failures, []);
  } finally { await f.stop(); }
});

test('a lost Add response cleans up the mapping installed by that request', async () => {
  const f = await fixture({ dropAddResponse: true });
  try {
    await assert.rejects(f.mapper.createLease('127.0.0.1', f.candidate, 180));
    assert.equal(f.entries.size, 0);
    assert.equal(f.calls.filter((call) => call.action === 'DeletePortMapping').length, 1);
    assert.deepEqual(f.failures, []);
  } finally { await f.stop(); }
});

test('device XML uses a strict parser and control URLs stay on the selected gateway', () => {
  assert.throws(() => parseXml('<root><broken></root>'));
  assert.throws(() => parseXml('<!DOCTYPE root [<!ENTITY a "x">]><root>&a;</root>'), /doctype/);
  assert.throws(() => parseXml('<a>'.repeat(65) + '</a>'.repeat(65)), /too-deep/);
  assert.throws(() => parseXml('x'.repeat(128 * 1024 + 1)), /too-large/);
  assert.equal(gatewayUrl('control?a=1&b=2', '192.0.2.1', 'http://192.0.2.1:123/base/').href, 'http://192.0.2.1:123/base/control?a=1&b=2');
  for (const url of ['http://192.0.2.2/control', 'http://router.invalid/control', 'http://user@192.0.2.1/control', 'file:///data']) {
    assert.throws(() => gatewayUrl(url, '192.0.2.1'), /off-gateway/);
  }
});

test('closing the native transport during router lookup cannot create a late mapping', async () => {
  let active = true;
  const f = await fixture({ onAction: (name) => { if (name === 'GetSpecificPortMappingEntry') active = false; } });
  try {
    await assert.rejects(f.mapper.createLease('127.0.0.1', f.candidate, 180, () => active), /cancelled/);
    assert.equal(f.entries.size, 0);
    assert.equal(f.calls.filter((call) => call.action === 'AddPortMapping').length, 0);
    assert.deepEqual(f.failures, []);
  } finally { await f.stop(); }
});
