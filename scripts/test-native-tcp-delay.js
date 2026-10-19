// Loopback-only latency fixture for the isolated delayed-poll native test DLL.
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
async function main() {
  const executable = path.resolve(process.argv[2] || 'media-agent/build/tcp-delay/Release/vds-tcp-delay-e2e.exe');
  const sockets = new Set();
  let listenerPort, responseHeld = false, responseBytes = 0, timer;
  const server = net.createServer((incoming) => {
    const outgoing = net.connect({ host: '127.0.0.1', port: listenerPort });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing);
    // Hold only the first return flight. Bytes are preserved in order; no
    // generated credentials, alternate candidate, or synthetic STUN response.
    let pending = [], released = false;
    outgoing.on('data', (data) => {
      responseBytes += data.length;
      if (released) return incoming.write(data);
      pending.push(data);
      if (!responseHeld) {
        responseHeld = true;
        timer = setTimeout(() => { released = true; for (const chunk of pending) incoming.write(chunk); pending = []; }, 4000);
      }
    });
    outgoing.on('end', () => incoming.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(executable, ['--mapped-tcp'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => child.kill(), 35000);
  let stdout = '';
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    stdout += line + '\n'; console.log(line);
    const match = /^MAP_LISTENER (\d+)$/.exec(line);
    if (match) {
      listenerPort = Number(match[1]);
      child.stdin.end(`candidate:delayed 1 TCP 100 127.0.0.1 ${server.address().port} typ srflx raddr 127.0.0.1 rport ${listenerPort} tcptype passive\n`);
    }
  });
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    console.log(JSON.stringify({ code, responseHeld, responseBytes }));
    assert.equal(code, 0, 'delayed TCP native test failed');
    assert.ok(responseHeld && responseBytes > 65536 && stdout.includes('cleanup=true'), 'missing delayed authentic media/cleanup evidence');
    console.log(JSON.stringify({ ok: true, responseDelayMs: 4000, responseBytes, nativePollDelayMs: 5000 }));
  } finally {
    clearTimeout(deadline); clearTimeout(timer); lines.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
