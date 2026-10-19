// Offline diagnostic for the strict, destination-dependent random NAT fixture.
// A hit on a mapped port is not a working path: the reverse filter must point
// back at the actual external source. This does not predict real router behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const publicAddresses = [0x7f000002, 0x7f000003];
function endpoint(text) {
  assert.equal(typeof text, 'string', 'missing remote endpoint');
  const match = /^(\d+):(\d+)$/.exec(text);
  assert(match, 'invalid fixture endpoint');
  const ip = Number(match[1]), port = Number(match[2]);
  assert(Number.isSafeInteger(ip) && ip > 0 && ip <= 0xffffffff && port > 0 && port <= 65535,
    'invalid fixture address or port');
  return { ip, port };
}
function analyzeMappings(rows, scenario) {
  assert(/^random-nat-seed-\d+-offset-\d+$/.test(scenario),
    'only strict random/random fixture scenarios have one allowed endpoint per trace record');
  const selected = rows.filter(r => r.scenario === scenario);
  assert(selected.length, 'missing allocation trace');
  assert(selected.every(r => r.side === 0 || r.side === 1), 'invalid NAT side');
  const sides = [0, 1].map(side => {
    const records = selected.filter(r => r.side === side).sort((a, b) => a.sequence - b.sequence);
    assert(records.length > 0 && records.length <= 256, 'invalid mapping table size');
    const ports = new Map(), keys = new Set();
    records.forEach((r, i) => {
      assert.equal(r.sequence, i, 'missing or duplicate mapping sequence');
      assert(Number.isInteger(r.publicPort) && r.publicPort > 0 && r.publicPort <= 65535,
        'invalid public port');
      assert(Number.isInteger(r.source) && r.source > 0 && r.source <= 65535, 'invalid source port');
      assert(!ports.has(r.publicPort), 'duplicate external mapping');
      const remote = endpoint(r.remote), key = `${r.source}/${r.remote}`;
      assert(!keys.has(key), 'duplicate source/destination allocation');
      keys.add(key); ports.set(r.publicPort, { ...r, remote });
    });
    return ports;
  });
  const witnesses = [];
  const counts = sides.map((mappings, side) => {
    const result = { mappings: mappings.size, nonPeerTargets: 0, targetNotMapped: 0,
      targetMappedForNonPeer: 0, reversePortMismatch: 0, reciprocal: 0 };
    for (const [port, mapping] of mappings) {
      if (mapping.remote.ip !== publicAddresses[1 - side]) { ++result.nonPeerTargets; continue; }
      const opposite = sides[1 - side].get(mapping.remote.port);
      if (!opposite) { ++result.targetNotMapped; continue; }
      if (opposite.remote.ip !== publicAddresses[side]) { ++result.targetMappedForNonPeer; continue; }
      if (opposite.remote.port === port) { ++result.reciprocal; continue; }
      ++result.reversePortMismatch;
      if (witnesses.filter(w => w.side === side).length < 2)
        witnesses.push({ side, sourcePublicPort: port, targetPublicPort: mapping.remote.port,
          targetAllowsPublicPort: opposite.remote.port });
    }
    assert.equal(result.mappings, result.nonPeerTargets + result.targetNotMapped +
      result.targetMappedForNonPeer + result.reversePortMismatch + result.reciprocal);
    return result;
  });
  assert.equal(counts[0].reciprocal, counts[1].reciprocal, 'asymmetric reciprocal pair accounting');
  return { scenario, metric: 'allocation graph at trace time, not authentication or successful transport',
    reciprocalPairs: counts[0].reciprocal, sides: counts, witnesses };
}
function analyzeLog(text) {
  const rows = text.split(/\r?\n/).filter(line => line.startsWith('ALLOCATION '))
    .map(line => JSON.parse(line.slice(11)));
  const scenarios = [...new Set(rows.map(r => r.scenario))].filter(name => /^random-nat-seed-/.test(name));
  assert(scenarios.length, 'no strict random NAT allocation traces found');
  return scenarios.map(name => analyzeMappings(rows, name));
}
module.exports = { analyzeMappings, analyzeLog };
if (require.main === module) {
  try {
    assert(process.argv.length > 2, 'provide one or more allocation-trace logs');
    console.log(JSON.stringify(process.argv.slice(2).flatMap(file => analyzeLog(fs.readFileSync(file, 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
