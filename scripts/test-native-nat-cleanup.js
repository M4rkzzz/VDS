// Windows fixture regression: distinguish owned leaks from another process
// claiming a port after close. No public network, routing or firewall changes.
const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

async function runCase(executable, mode, output) {
  const env = { ...process.env, VDS_NAT_ALLOCATION_TRACE: '1' };
  delete env.VDS_NAT_TEST_CLOSED_PORT;
  if (mode !== 'foreign') env.VDS_NAT_TEST_CLOSED_PORT = mode;
  const child = spawn(executable, ['--random-invalid'], {
    cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '', lines = '', port, socket, bound = false, attempts = 0, done = false, retry;
  let timeout = false, parseError;
  const timer = setTimeout(() => { timeout = true; child.kill(); }, 20000);
  const claim = () => {
    if (done || bound) return;
    ++attempts;
    const candidate = dgram.createSocket('udp4'); socket = candidate;
    candidate.once('error', () => {
      candidate.close();
      if (!done) retry = setTimeout(claim, 5);
    });
    candidate.once('listening', () => { bound = true; });
    candidate.bind({ port, address: '127.0.0.10', exclusive: true });
  };
  child.stdout.on('data', data => {
    const chunk = data.toString('utf8'); text += chunk; lines += chunk;
    let end;
    while ((end = lines.indexOf('\n')) >= 0) {
      const line = lines.slice(0, end).trim(); lines = lines.slice(end + 1);
      if (mode === 'foreign' && !port && line.startsWith('ALLOCATION ')) {
        try {
          const row = JSON.parse(line.slice(11));
          if (row.scenario === 'random-invalid-ice-no-false-connect' && row.side === 0) {
            port = row.source; claim();
          }
        } catch (error) { parseError = error; child.kill(); }
      }
    }
  });
  child.stderr.on('data', data => { text += data.toString('utf8'); });
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally {
    done = true; clearTimeout(timer); clearTimeout(retry);
    if (socket) { try { socket.close(); } catch {} }
    fs.writeFileSync(path.join(output, mode + '.log'), text);
  }
  assert.ifError(parseError);
  assert(!timeout, 'native cleanup fixture timed out');
  assert(text.includes('STUN fingerprint check failed'), 'corrupt ICE control was not exercised');
  assert.equal(code, mode === 'leak' ? 1 : 0, `${mode}: unexpected native exit; see ${output}`);
  let ownership;
  if (mode === 'leak') {
    ownership = text.split(/\r?\n/).find(line => line.startsWith('FAIL nat traversal E2E:') &&
      line.includes(`currentPid=${child.pid} owners=[`) && line.includes(`{pid=${child.pid},`));
    assert(ownership, 'a held own socket must fail with actual owning PID evidence');
  } else {
    const results = text.split(/\r?\n/).filter(line => line.startsWith('{"scenario":')).map(line => JSON.parse(line));
    assert.equal(results.length, 1);
    assert(!results[0].connected && !results[0].channelOpen && results[0].forwardedDatagrams > 0,
      'teardown verification must not turn corrupted ICE into a connected result');
    assert(text.includes('CLOSE-RELEASE random-invalid-ice-no-false-connect'));
    if (mode === 'foreign') {
      assert(bound && port, 'supervisor did not acquire the released source port');
      ownership = text.split(/\r?\n/).find(line => line.startsWith('CLOSE-PORT-REASSIGNED ') &&
        line.includes(`currentPid=${child.pid} owners=[`) && line.includes(`{pid=${process.pid},`));
      assert(ownership, 'must observe the actual supervisor as foreign owner');
    }
  }
  return { mode, exitCode: code, supervisorPid: process.pid, fixturePid: child.pid,
    takeoverPort: port, bound, attempts, ownership };
}

async function main() {
  assert.equal(process.platform, 'win32', 'native cleanup verification requires Windows');
  const executable = path.resolve(process.argv[2] || path.join(root, 'media-agent/build/seeded-egress/Release/vds-nat-seeded-egress.exe'));
  const output = path.resolve(process.argv[3] || path.join(root, 'tmp/native-nat-cleanup'));
  fs.mkdirSync(output, { recursive: true });
  const report = { runId: randomUUID(), executable, state: 'running', cases: [] };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  try {
    for (const mode of ['leak', 'release', 'foreign']) {
      report.cases.push(await runCase(executable, mode, output)); save();
    }
    report.state = 'passed'; save();
    console.log(`Native cleanup ownership: 3/3 passed; report: ${output}`);
  } catch (error) { report.state = 'failed'; report.error = error.message; save(); throw error; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
