const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const http = require('node:http');
const { parseXml, UpnpPortMapper } = require('../../desktop/upnp-port-mapper');

// Local gateway stand-in: control requests enable a TCP byte forwarder. This is
// a test-only address/port translation, never an application relay or WAN test.
async function tcpMappingRouter(protocol, options = {}) {
  const control = dgram.createSocket('udp4'), ssdp = dgram.createSocket('udp4');
  const entries = new Map(), connections = new Set(), servers = new Set(), errors = [], calls = [];
  let bytes = 0;
  const bind = (socket, address = '127.0.0.1') => new Promise((resolve) => socket.bind(0, address, resolve));
  await Promise.all([bind(control, options.controlAddress || '127.0.0.1'), bind(ssdp)]);
  async function map(transport, internalPort, lifetime, identity, requestedExternal) {
    const key = `${transport}:${internalPort}`;
    let entry = entries.get(key);
    calls.push({ transport, internalPort, lifetime, identity });
    if (!lifetime) {
      if (entry) { assert.equal(entry.identity, identity); entries.delete(key); }
      return { externalPort: 0, lifetime: 0 };
    }
    if (entry) {
      assert.equal(entry.identity, identity);
      assert.equal(requestedExternal, entry.externalPort);
      entry.expires = Date.now() + 2000;
      return entry;
    }
    entry = { internalPort, transport, identity, lifetime: 2, expires: Date.now() + 2000 };
    if (transport === 'tcp') {
      const server = net.createServer((incoming) => {
        if (entries.get(key) !== entry || entry.expires <= Date.now()) return incoming.destroy();
        const outgoing = net.connect({ host: '127.0.0.1', port: internalPort });
        for (const socket of [incoming, outgoing]) {
          connections.add(socket); socket.on('close', () => connections.delete(socket));
          socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
          socket.on('data', (data) => { bytes += data.length; });
        }
        incoming.pipe(outgoing); outgoing.pipe(incoming);
      });
      servers.add(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(protocol === 'upnp' ? requestedExternal : 0, protocol === 'upnp' ? '127.0.0.2' : '127.0.0.1', resolve); });
      entry.externalPort = server.address().port;
    } else entry.externalPort = internalPort;
    entries.set(key, entry); return entry;
  }
  control.on('message', async (request, peer) => {
    try {
      let response;
      if (request[0] === 0 && request[1] === 0) {
        response = Buffer.alloc(12); response[1] = 128;
        if (protocol !== 'nat-pmp') response.writeUInt16BE(1, 2);
        else Buffer.from([127, 0, 0, 1]).copy(response, 8);
      } else if (request[0] === 0) {
        response = Buffer.alloc(16); response[1] = request[1] | 128;
        if (protocol !== 'nat-pmp') response.writeUInt16BE(1, 2);
        else {
          assert.ok([1, 2].includes(request[1]));
          const entry = await map(request[1] === 2 ? 'tcp' : 'udp', request.readUInt16BE(4), request.readUInt32BE(8), 'pmp', request.readUInt16BE(6));
          response.writeUInt16BE(request.readUInt16BE(4), 8); response.writeUInt16BE(entry.externalPort, 10);
          response.writeUInt32BE(entry.lifetime, 12);
        }
      } else {
        assert.equal(request[0], 2); assert.equal(request[1], 1);
        response = Buffer.alloc(60); response[0] = 2; response[1] = 0x81;
        request.copy(response, 24, 24, 44);
        if (protocol !== 'pcp') response[3] = 4;
        else {
          assert.ok([6, 17].includes(request[36]));
          assert.equal(request.subarray(20, 24).toString('hex'), Buffer.from(peer.address.split('.').map(Number)).toString('hex'), 'PCP client address must match actual control socket source');
          const entry = await map(request[36] === 6 ? 'tcp' : 'udp', request.readUInt16BE(40), request.readUInt32BE(4), request.subarray(24, 36).toString('hex'), request.readUInt16BE(42));
          response.writeUInt32BE(entry.lifetime, 4); response.writeUInt16BE(entry.externalPort, 42);
          if (entry.lifetime) Buffer.from('00000000000000000000ffff7f000001', 'hex').copy(response, 44);
        }
      }
      control.send(response, peer.port, peer.address);
    } catch (error) { errors.push(error); }
  });
  const service = 'urn:schemas-upnp-org:service:WANIPConnection:1';
  const web = http.createServer(async (req, res) => {
    const reply = (name, values) => res.end(`<Envelope><Body><${name}Response>${Object.entries(values).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</${name}Response></Body></Envelope>`);
    const fault = (code) => { res.statusCode = 500; res.end(`<Envelope><Body><Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></Fault></Body></Envelope>`); };
    try {
      if (req.url === '/device.xml') return res.end(`<root><device><serviceList><service><serviceType>${service}</serviceType><controlURL>/control</controlURL></service></serviceList></device></root>`);
      let body = ''; for await (const chunk of req) body += chunk;
      const action = parseXml(body).children[0].children[0].children[0];
      const args = Object.fromEntries(action.children.map((field) => [field.name, field.text]));
      const transport = args.NewProtocol?.toLowerCase();
      const current = [...entries.values()].find((e) => e.externalPort === Number(args.NewExternalPort) && e.transport === transport);
      if (action.name === 'GetStatusInfo') return reply(action.name, { NewConnectionStatus: 'Connected' });
      if (action.name === 'GetExternalIPAddress') return reply(action.name, { NewExternalIPAddress: '127.0.0.2' });
      if (action.name === 'GetSpecificPortMappingEntry') {
        if (!current) return fault(714);
        return reply(action.name, { NewInternalClient: '127.0.0.1', NewInternalPort: current.internalPort,
          NewPortMappingDescription: current.identity, NewEnabled: 1, NewLeaseDuration: 2 });
      }
      if (action.name === 'AddPortMapping') {
        await map(transport, Number(args.NewInternalPort), Number(args.NewLeaseDuration), args.NewPortMappingDescription, Number(args.NewExternalPort));
        return reply(action.name, {});
      }
      if (action.name === 'DeletePortMapping') {
        if (!current) return fault(714);
        await map(transport, current.internalPort, 0, current.identity); return reply(action.name, {});
      }
      fault(401);
    } catch (error) { errors.push(error); res.destroy(); }
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  ssdp.on('message', (_packet, peer) => ssdp.send(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${web.address().port}/device.xml\r\n\r\n`, peer.port, peer.address));
  return { entries, calls, errors, get bytes() { return bytes; }, controlPort: control.address().port,
    mapper: new UpnpPortMapper({ discoveryAddress: '127.0.0.1', discoveryPort: ssdp.address().port }),
    async stop() {
      for (const socket of connections) socket.destroy();
      await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
      web.closeAllConnections();
      await Promise.all([new Promise((resolve) => web.close(resolve)), ...[ssdp, control].map((socket) => new Promise((resolve) => socket.close(resolve)))]);
    }
  };
}
module.exports = { tcpMappingRouter };
