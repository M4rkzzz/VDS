// Comparative measurement, not a connectivity-rate pass/fail gate.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { analyzeLog } = require('./analyze-native-nat-mappings');
const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(root, 'media-agent/build/seeded-egress/Release/vds-nat-seeded-egress.exe'));
const output = path.resolve(process.argv[3] || path.join(root, 'tmp/nat-replay'));

function planningSeed(scenario, side, plan) {
  let value = (scenario * 65537 + side * 193 + plan * 7919 + 17) >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return value >>> 0;
}

// Opt-in fixture evidence. These allocations precede the sustained-media
// phase, so their count may be smaller than the final scenario snapshot.
function summarizeAllocations(text, scenario) {
  const rows = text.split(/\r?\n/).filter((line) => line.startsWith('ALLOCATION '))
    .map((line) => JSON.parse(line.slice('ALLOCATION '.length)))
    .filter((item) => item.scenario === scenario);
  if (!rows.length) return null;
  return [0, 1].map((side) => {
    const mappings = rows.filter((item) => item.side === side).sort((a, b) => a.sequence - b.sequence);
    assert(mappings.length > 0 && mappings.length <= 256, 'invalid allocation trace size');
    const targets = new Map();
    mappings.forEach((item, index) => {
      assert.equal(item.sequence, index, 'allocation trace is incomplete or duplicated');
      if (!targets.has(item.remote)) targets.set(item.remote, new Set());
      const sources = targets.get(item.remote);
      assert(!sources.has(item.source), 'same source/target unexpectedly allocated twice');
      sources.add(item.source);
    });
    return { mappings: mappings.length, uniqueTargets: targets.size,
      extraSourceMappings: mappings.length - targets.size,
      filledAtMs: mappings.length === 256 ? mappings[mappings.length - 1].atMs : null };
  });
}

function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { metric: 'real local ICE/DTLS/SCTP and sustained echo; not UU parity',
    fixedPlanningSeeds: true, fixedPublicPool: true, deterministicScheduling: false, runs: [] };
  const save = () => fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  for (let run = 0; run < 2; ++run) {
    const cases = [];
    for (const [offset, seeds] of [[64, [1, 2, 3]], [128, [4, 5, 6]]]) {
      // Single combined stream preserves the fixture's event ordering in logs.
      const log = path.join(output, `run-${run}-${offset}.log`);
      const fd = fs.openSync(log, 'w');
      let result;
      try {
        result = spawnSync(executable, ['--random-multi-offset', String(offset), ...seeds.map(String)],
          { cwd: root, stdio: ['ignore', fd, fd], timeout: 180000, windowsHide: true });
      } finally { fs.closeSync(fd); }
      assert.ifError(result.error);
      assert.equal(result.status, 0, `fixture failed: ${log}`);
      const text = fs.readFileSync(log, 'utf8');
      const pools = [...text.matchAll(/FIXED-NAT-POOL base=(\d+) width=(\d+)/g)];
      assert.equal(pools.length, 4, 'missing fixed-pool instrumentation');
      for (const [, base, width] of pools) { assert.equal(Number(base), 32768 + offset); assert.equal(Number(width), 256); }
      const plans = [...text.matchAll(/PLANNER-SEED scenario=(\d+) side=(\d+) plan=(\d+) value=(\d+)/g)];
      assert(plans.length > 0, 'planning RNG seam was not exercised');
      for (const [, scenario, side, plan, value] of plans)
        assert.equal(Number(value), planningSeed(Number(scenario), Number(side), Number(plan)), 'planning seed changed');
      const results = text.split(/\r?\n/).filter(line => line.startsWith('{"scenario":')).map(line => JSON.parse(line));
      const mappingGraphs = process.env.VDS_NAT_ALLOCATION_TRACE ? analyzeLog(text) : [];
      assert.equal(results.length, 4, 'missing scenario result');
      assert.equal(results.filter(item => item.scenario === 'stable-to-random-exact-filtering' && item.connected).length, 1,
        'stable/random positive control failed');
      for (const seed of seeds) {
        const item = results.find(value => value.scenario === `random-nat-seed-${seed}-offset-${offset}`);
        assert(item, 'missing random scenario');
        assert.equal(item.fullEgress, true); assert.equal(item.egressPackets, item.internalDatagrams);
        if (item.connected) assert(item.channelOpen && item.payloadReceived && item.clientHellos > 0,
          'connected result lacks actual secure channel and payload');
        const allocations = summarizeAllocations(text, item.scenario);
        if (process.env.VDS_NAT_ALLOCATION_TRACE) assert(allocations, 'missing requested allocation trace');
        if (allocations) item.allocationsAtObservationEnd = allocations;
        const graph = mappingGraphs.find(value => value.scenario === item.scenario);
        if (graph) item.mappingGraphAtObservationEnd = graph;
        cases.push(item);
      }
    }
    report.runs.push({ connected: cases.filter(item => item.connected).length, total: cases.length, cases });
    save();
    console.log(`Replay ${run + 1}: ${report.runs[run].connected}/${cases.length} connected`);
  }
  report.changedOutcomes = report.runs[0].cases.filter((item, i) => item.connected !== report.runs[1].cases[i].connected)
    .map(item => item.scenario);
  save();
  console.log(`Outcome changes despite fixed planning RNG/pool: ${report.changedOutcomes.length}; report: ${path.join(output, 'summary.json')}`);
}
module.exports = { summarizeAllocations };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
