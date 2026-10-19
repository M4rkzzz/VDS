const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { NatMappingLeases } = require('../desktop/nat-mapping-leases');
const { buildPcpMapRequest, parsePcpMapResponse } = require('../desktop/pcp-packet');
const { loadMappingFunctions } = require('../tests/fixtures/nat-main-functions');
const { tcpMappingRouter } = require('../tests/fixtures/tcp-mapping-router');

async function verify(protocol) {
  const router = await tcpMappingRouter(protocol);
  const errors = [];
  const leases = new NatMappingLeases({ random: () => 0, onError: (error) => errors.push(error) });
  const ticket = leases.beginCreate({ peerId: 'mapped-native' });
  leases.completeCreate(ticket, { peerId: ticket.peerId, transportGeneration: 'mapped-generation' });
  const functions = loadMappingFunctions({ dgram, crypto, buildPcpMapRequest, parsePcpMapResponse,
    natMappingLeases: leases, upnpPortMapper: router.mapper,
    resolveDefaultGatewayIpv4: async () => '127.0.0.1',
    sendToRenderer: () => assert.fail('unchanged endpoint must not be reannounced'),
    gatewayRequest: (request, address, _port, ...args) => request(address, router.controlPort, ...args) });
  const exe = path.resolve(__dirname, '../media-agent/build/Release/vds-tcp-ice-e2e.exe');
  const child = spawn(exe, ['--mapped-tcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', mappingFlight, mapped;
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => child.kill(), 25000);
  child.stderr.on('data', (data) => { output += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    output += line + '\n';
    const match = line.match(/^MAP_LISTENER (\d+)$/);
    if (!match) return;
    if (mappingFlight) { errors.push(new Error('duplicate listener announcement')); child.kill(); return; }
    mappingFlight = (async () => {
      mapped = await functions.openP2PNatMappings({ peerId: ticket.peerId, transportGeneration: ticket.generation,
        candidates: [{ candidate: `candidate:native 1 TCP 1284504319 127.0.0.1 ${match[1]} typ host tcptype passive`, sdpMid: '0' }] });
      assert.equal(mapped.ok, true, JSON.stringify(mapped)); assert.equal(mapped.protocol, protocol);
      assert.equal(mapped.candidates.length, 1);
      assert.match(mapped.candidates[0].candidate, / tcp .* typ srflx raddr .* rport \d+ tcptype passive$/);
      child.stdin.end(mapped.candidates[0].candidate + '\n');
    })().catch((error) => { errors.push(error); child.kill(); });
  });
  try {
    const exit = await exited;
    if (mappingFlight) await mappingFlight;
    assert.deepEqual(exit, { code: 0, signal: null }, output);
    assert.ok(mapped?.ok, output);
    assert.match(output, /PASS direct TCP .*cleanup=true/);
    assert.ok(router.bytes > 4096 * 20, 'actual native TCP stream must cross mapped port');
    const creates = router.calls.filter((call) => call.lifetime > 0 && call.transport === 'tcp');
    assert.ok(creates.length >= 3, 'short lease must renew during seven-second native transfer');
    assert.equal(new Set(creates.map((call) => call.identity)).size, 1, 'nonce/owner survives renewal');
    await leases.dispose();
    assert.equal(router.entries.size, 0);
    assert.ok(router.calls.some((call) => call.transport === 'tcp' && call.lifetime === 0));
    assert.deepEqual(router.errors, []); assert.deepEqual(errors, []);
    console.log(output.trim());
    console.log(JSON.stringify({ protocol, nativeTcp: true, bytes: router.bytes, createsAndRenewals: creates.length, released: true }));
  } finally {
    clearTimeout(timer); lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await leases.dispose(); await router.stop();
  }
}
async function main() { for (const protocol of ['pcp', 'nat-pmp', 'upnp']) await verify(protocol); }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
