const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const { once } = require('node:events');
const { MediaAgentManager } = require('../desktop/media-agent-manager');
const { validateNativeRuntime } = require('./native-runtime-integrity');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bindingResponse(request, address, port) {
  assert.equal(request.readUInt16BE(0), 1, 'only STUN Binding is permitted');
  assert.equal(request.readUInt32BE(4), 0x2112a442);
  const reply = Buffer.alloc(32);
  reply.writeUInt16BE(0x0101, 0);
  reply.writeUInt16BE(12, 2);
  request.copy(reply, 4, 4, 20);
  reply.writeUInt16BE(0x0020, 20);
  reply.writeUInt16BE(8, 22);
  reply[25] = 1;
  reply.writeUInt16BE(port ^ 0x2112, 26);
  address.split('.').forEach((part, index) => { reply[28 + index] = Number(part) ^ request[4 + index]; });
  return reply;
}

async function runCase(tcpFirst) {
  const events = [];
  const errors = [];
  const udpSockets = [];
  const streams = new Set();
  const udpRequests = [0, 0, 0, 0];
  const tcpRequests = [];
  let server;
  const agent = new MediaAgentManager({ logger: { log() {}, warn() {}, error() {} } });
  agent.on('event', (event) => events.push(event));
  try {
    for (let index = 0; index < 4; index += 1) {
      const socket = dgram.createSocket('udp4');
      udpSockets.push(socket);
      socket.on('error', (error) => errors.push(error));
      socket.on('message', (request, remote) => {
        try {
          const response = bindingResponse(request, remote.address, remote.port);
          udpRequests[index] += 1;
          socket.send(response, remote.port, remote.address);
        } catch (error) { errors.push(error); }
      });
      socket.bind(0, '127.0.0.1');
      await once(socket, 'listening');
    }
    server = net.createServer((socket) => {
      streams.add(socket);
      socket.on('close', () => streams.delete(socket));
      socket.on('error', (error) => errors.push(error));
      let pending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        try {
          // TCP STUN uses the STUN header length, not ICE's RFC4571 prefix.
          while (pending.length >= 20) {
            const size = 20 + pending.readUInt16BE(2);
            if (pending.length < size) break;
            const request = pending.subarray(0, size);
            pending = pending.subarray(size);
            const response = bindingResponse(request, socket.remoteAddress, socket.remotePort);
            tcpRequests.push({ address: socket.remoteAddress, port: socket.remotePort });
            const invalid = bindingResponse(request, '203.0.113.77', 40123);
            invalid[8] ^= 0x80; // A plausible mapping from an unrelated transaction must be ignored.
            socket.write(invalid);
            socket.write(response.subarray(0, 7));
            setTimeout(() => {
              if (!socket.destroyed) socket.write(response.subarray(7, 23));
              setTimeout(() => { if (!socket.destroyed) socket.write(response.subarray(23)); }, 20);
            }, 20);
          }
        } catch (error) { errors.push(error); }
      });
    });
    server.on('error', (error) => errors.push(error));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const udpUrls = udpSockets.map((socket) => `stun:127.0.0.1:${socket.address().port}`);
    const tcpUrl = `stun:127.0.0.1:${server.address().port}?transport=tcp`;
    const stunServers = tcpFirst ? [tcpUrl, ...udpUrls] : [...udpUrls, tcpUrl];
    const peerId = `tcp-stun-${tcpFirst ? 'first' : 'last'}`;
    await agent.start();
    const peer = await agent.invoke('createPeer', { peerId, role: 'viewer-upstream', initiator: true,
      stunServer: stunServers[0], stunServers });
    const candidates = () => events.filter(({ event, params }) => event === 'signal' &&
      params.peerId === peerId && params.type === 'candidate').map(({ params }) => params.candidate.candidate);
    const mappedCandidate = () => candidates().find((candidate) => tcpRequests.some(({ address, port }) =>
      candidate.includes(` ${address} ${port} typ srflx`) && / TCP /i.test(candidate) && / tcptype so(?: |$)/.test(candidate)));
    const deadline = Date.now() + 10000;
    while (!errors.length && Date.now() < deadline && (!mappedCandidate() || udpRequests.some((count) => count === 0))) {
      await delay(20);
    }
    assert.deepEqual(errors, []);
    assert.ok(udpRequests.every((count) => count > 0), `all four UDP servers must remain usable: ${udpRequests}`);
    assert.ok(tcpRequests.length > 0, 'the native RPC must cause an actual TCP Binding request');
    assert.ok(mappedCandidate(), `TCP mapping must retain the observed socket source port: ${JSON.stringify({ tcpRequests, candidates: candidates() })}`);
    assert.ok(!candidates().some((candidate) => candidate.includes('203.0.113.77')), 'wrong-transaction mapping must not be published');
    const stats = (await agent.invoke('getStats')).peers.find((item) => item.peerId === peerId).peerTransport;
    assert.deepEqual(stats.stunServers, stunServers);
    await assert.rejects(agent.invoke('createPeer', { peerId: 'excess-selected-udp', role: 'viewer-upstream',
      initiator: false, stunServer: 'stun:127.0.0.1:1', stunServers }), { code: 'BAD_REQUEST' });
    console.log(JSON.stringify({ tcpFirst, udpRequests, tcpRequests, mappedCandidate: mappedCandidate(), wrongTransactionRejected: true }));
    await agent.invoke('closePeer', { peerId, transportGeneration: peer.transportGeneration });
    assert.equal((await agent.invoke('getStats')).peers.length, 0);
  } finally {
    await agent.stop();
    for (const socket of streams) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    for (const socket of udpSockets) socket.close();
  }
}

async function main() {
  validateNativeRuntime();
  await runCase(false);
  await runCase(true);
  console.log('Native RPC TCP STUN, four independent UDP slots, fragmented replies and transaction validation passed. This is not a NAT connection-rate test.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
