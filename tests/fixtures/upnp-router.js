const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');
const { UpnpPortMapper, parseXml } = require('../../desktop/upnp-port-mapper');

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bind = (socket, address = '127.0.0.1', port = 0) => new Promise((resolve, reject) => {
  socket.once('error', reject); socket.bind(port, address, resolve);
});
const close = (socket) => new Promise((resolve) => socket.close(resolve));

async function fixture(options = {}) {
  const ssdp = dgram.createSocket('udp4');
  const entries = new Map(), publicSockets = new Map(), calls = [], sources = [], failures = [];
  const host = dgram.createSocket('udp4'), viewer = dgram.createSocket('udp4');
  await Promise.all([bind(ssdp), bind(host), bind(viewer, '127.0.0.3')]);
  const internalPort = host.address().port;
  const candidate = { port: internalPort, address: '127.0.0.1' };
  if (options.conflict) entries.set(internalPort, { NewInternalClient: '192.0.2.55', NewInternalPort: '1234',
    NewEnabled: '1', NewPortMappingDescription: 'other-app', NewLeaseDuration: '0', expires: Infinity });
  const serviceTypes = options.services || ['WANIPConnection:1'];
  const server = http.createServer(async (req, res) => {
    sources.push(req.socket.remoteAddress);
    const reply = (action, type, values) => {
      res.setHeader('Content-Type', 'text/xml');
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${type}">${Object.entries(values).map(([key, val]) => `<${key}>${xml(val)}</${key}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`);
    };
    const fault = (code) => {
      res.statusCode = 500;
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    };
    try {
      if (req.url === '/device.xml') {
        res.end(`<root xmlns="urn:schemas-upnp-org:device-1-0"><URLBase>http://127.0.0.1:${server.address().port}/base/</URLBase><device><serviceList>${serviceTypes.map((type, index) => `<service><serviceType>urn:schemas-upnp-org:service:${type}</serviceType><controlURL>control${index}?a=1&amp;b=2</controlURL></service>`).join('')}</serviceList></device></root>`);
        return;
      }
      assert.match(req.url, /^\/base\/control\d\?a=1&b=2$/);
      let body = ''; for await (const chunk of req) body += chunk;
      const document = parseXml(body);
      const action = document.children[0].children[0].children[0];
      const type = String(req.headers.soapaction).split('#')[0].slice(1);
      const args = Object.fromEntries(action.children.map((item) => [item.name, item.text]));
      calls.push({ action: action.name, args, type });
      options.onAction?.(action.name);
      const port = Number(args.NewExternalPort);
      let current = entries.get(port);
      if (current && current.expires <= Date.now()) { entries.delete(port); current = null; }
      if (action.name === 'GetStatusInfo') return reply(action.name, type, { NewConnectionStatus: type.endsWith(':2') && options.disconnectedV2 ? 'Disconnected' : 'Connected' });
      if (action.name === 'GetExternalIPAddress') return reply(action.name, type, { NewExternalIPAddress: '127.0.0.2' });
      if (action.name === 'GetSpecificPortMappingEntry') {
        if (!current) return fault(714);
        return reply(action.name, type, { ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'expires')),
          NewLeaseDuration: current.expires === Infinity ? 0 : Math.max(1, Math.ceil((current.expires - Date.now()) / 1000)) });
      }
      if (action.name === 'AddPortMapping') {
        assert.equal(args.NewProtocol, 'UDP'); assert.equal(args.NewInternalClient, candidate.address);
        assert.equal(Number(args.NewInternalPort), internalPort);
        if (options.permanentOnly && Number(args.NewLeaseDuration) !== 0) return fault(725);
        if (current && current.NewPortMappingDescription !== args.NewPortMappingDescription) return fault(718);
        const duration = options.permanentOnly ? 0 : 2;
        if (!publicSockets.has(port)) {
          const socket = dgram.createSocket('udp4');
          try { await bind(socket, '127.0.0.2', port); }
          catch (error) {
            socket.close();
            // Windows excluded ports and other fixtures can occupy this simulated
            // gateway's external port. Report a router conflict, not a broken HTTP
            // connection or a successfully installed mapping with no UDP route.
            if (error.code === 'EACCES' || error.code === 'EADDRINUSE') return fault(718);
            throw error;
          }
          publicSockets.set(port, socket);
          socket.on('message', (packet, peer) => {
            const active = entries.get(port);
            if (!active || active.expires <= Date.now()) return;
            if (peer.address === candidate.address && peer.port === internalPort) socket.send(packet, viewer.address().port, '127.0.0.3');
            else socket.send(packet, internalPort, candidate.address);
          });
        }
        entries.set(port, { NewInternalClient: args.NewInternalClient, NewInternalPort: args.NewInternalPort,
          NewEnabled: args.NewEnabled, NewPortMappingDescription: args.NewPortMappingDescription,
          NewLeaseDuration: String(duration), expires: duration ? Date.now() + duration * 1000 : Infinity });
        options.onMappingAdded?.({ port, description: args.NewPortMappingDescription });
        if (options.holdAddResponse) return;
        if (options.dropAddResponse) { res.destroy(); return; }
        return reply(action.name, type, {});
      }
      if (action.name === 'DeletePortMapping') {
        if (options.failDelete?.()) return fault(501);
        if (!current) return fault(714);
        entries.delete(port); return reply(action.name, type, {});
      }
      fault(401);
    } catch (error) { failures.push(error); res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ssdp.on('message', (packet, peer) => {
    sources.push(peer.address);
    if (!packet.toString().includes('ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1')) failures.push(new Error('wrong-discovery-target'));
    ssdp.send(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${server.address().port}/device.xml\r\n\r\n`, peer.port, peer.address);
  });
  host.on('message', (packet, peer) => host.send(packet, peer.port, peer.address));
  const mapper = new UpnpPortMapper({ discoveryAddress: '127.0.0.1', discoveryPort: ssdp.address().port });
  return { mapper, candidate, calls, entries, sources, failures, host, viewer,
    async stop() { await Promise.all([ssdp, host, viewer, ...publicSockets.values()].map(close)); await new Promise((resolve) => server.close(resolve)); } };
}


module.exports = { fixture };
