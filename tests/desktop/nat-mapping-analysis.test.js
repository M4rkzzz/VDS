const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMappings, analyzeLog } = require('../../scripts/analyze-native-nat-mappings');
const scenario = 'random-nat-seed-1-offset-64';
const row = (side, sequence, port, remote) =>
  ({ scenario, side, sequence, publicPort: port, source: 50000 + side, remote });
test('an allocated destination with a different reverse endpoint cannot pass the filter', () => {
  const graph = analyzeMappings([
    row(0, 0, 40000, '2130706435:41000'), row(1, 0, 41000, '2130706434:40001'),
  ], scenario);
  assert.equal(graph.reciprocalPairs, 0);
  assert.equal(graph.sides[0].reversePortMismatch, 1);
  assert.equal(graph.sides[1].targetNotMapped, 1);
  assert.deepEqual(graph.witnesses[0], { side: 0, sourcePublicPort: 40000,
    targetPublicPort: 41000, targetAllowsPublicPort: 40001 });
});
test('only the exact reverse endpoint creates a reciprocal pair', () => {
  const graph = analyzeMappings([
    row(0, 0, 40000, '2130706435:41000'), row(1, 0, 41000, '2130706434:40000'),
  ], scenario);
  assert.equal(graph.reciprocalPairs, 1);
  assert.deepEqual(graph.sides.map(s => s.reciprocal), [1, 1]);
});
test('a STUN-only occupied port is distinguished from an unmapped port', () => {
  const rows = [row(0, 0, 40000, '2130706435:41000'), row(1, 0, 41000, '2130706433:3478')];
  const graph = analyzeLog(rows.map(r => 'ALLOCATION ' + JSON.stringify(r)).join('\n'))[0];
  assert.equal(graph.reciprocalPairs, 0);
  assert.equal(graph.sides[0].targetMappedForNonPeer, 1);
  assert.equal(graph.sides[1].nonPeerTargets, 1);
});
test('missing records, duplicate external ports and unsupported stable mappings fail closed', () => {
  const rows = [row(0, 0, 40000, '2130706435:41000'), row(1, 0, 41000, '2130706434:40000')];
  assert.throws(() => analyzeMappings([rows[0], { ...rows[1], sequence: 1 }], scenario), /sequence/);
  assert.throws(() => analyzeMappings([...rows, row(0, 1, 40000, '2130706435:41001')], scenario), /external/);
  assert.throws(() => analyzeMappings(rows, 'stable-to-random-exact-filtering'), /only strict/);
  assert.throws(() => analyzeLog('CASE-BEGIN random-nat-seed-1-offset-64'), /no strict/);
});
