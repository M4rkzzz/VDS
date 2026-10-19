const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');
const { randomBytes, randomInt } = require('node:crypto');
const sax = require('sax');

const MAX_XML = 128 * 1024;
const SERVICE = /^urn:schemas-upnp-org:service:(WANIPConnection:[12]|WANPPPConnection:1)$/;
const failure = (reason, code) => Object.assign(new Error(`upnp-${reason}`), { upnpCode: code });
const escapeXml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const budget = (ms) => { const end = performance.now() + ms; return () => {
  const remaining = end - performance.now();
  if (remaining <= 0) throw failure('timeout');
  return remaining;
}; };

function parseXml(xml) {
  if (Buffer.byteLength(xml) > MAX_XML) throw failure('xml-too-large');
  const parser = sax.parser(true, { xmlns: true });
  const root = { children: [] }, stack = [root];
  parser.ondoctype = () => { throw failure('doctype-not-supported'); };
  parser.onopentag = (tag) => {
    if (stack.length >= 64) throw failure('xml-too-deep');
    const node = { name: tag.local, children: [], text: '' };
    stack.at(-1).children.push(node); stack.push(node);
  };
  parser.ontext = parser.oncdata = (text) => { if (stack.length > 1) stack.at(-1).text += text; };
  parser.onclosetag = () => stack.pop();
  parser.write(xml).close();
  return root;
}
function find(node, name) {
  return node.name === name ? [node] : node.children.flatMap((child) => find(child, name));
}
function value(node, name) { return node.children.find((child) => child.name === name)?.text.trim() || ''; }

function gatewayUrl(raw, gateway, base) {
  const url = new URL(raw, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== gateway || url.username || url.password || url.hash) {
    throw failure('off-gateway-url');
  }
  return url;
}

function requestXml(url, localAddress, remaining, body, headers = {}) {
  const timeout = Math.min(1200, remaining());
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: body === undefined ? 'GET' : 'POST', localAddress, agent: false,
      headers: { Connection: 'close', ...headers, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) }
    });
    const timer = setTimeout(() => request.destroy(failure('http-timeout')), timeout);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    request.on('response', (response) => {
      let size = 0; const chunks = [];
      response.on('error', reject);
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_XML) request.destroy(failure('xml-too-large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.end(body);
  });
}

async function rpc(service, localAddress, action, args, remaining) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${Object.entries(args).map(([key, val]) => `<${key}>${escapeXml(val)}</${key}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const response = await requestXml(service.url, localAddress, remaining, body, {
    'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.type}#${action}"`
  });
  const document = parseXml(response.text);
  const fault = find(document, 'errorCode')[0];
  if (fault) throw failure(`fault-${fault.text.trim()}`, Number(fault.text.trim()));
  const result = find(document, `${action}Response`);
  if (response.status !== 200 || result.length !== 1) throw failure(`invalid-${action}-response`);
  return result[0];
}

class UpnpPortMapper {
  constructor({ discoveryAddress = '239.255.255.250', discoveryPort = 1900, journal = null, onError = () => {} } = {}) {
    this.discoveryAddress = discoveryAddress;
    this.discoveryPort = discoveryPort;
    this.discovering = new Map();
    this.journal = journal;
    this.onError = onError;
    this.recovering = new Map();
  }

  async recoverOrphans(gateway, localAddress) {
    if (!this.journal) return;
    const records = (await this.journal.orphans()).filter((record) =>
      (!gateway || record.gateway === gateway) && (!localAddress || record.localAddress === localAddress));
    // Recover in small batches; these requests never enter the media path.
    for (let index = 0; index < records.length; index += 4) {
      await Promise.all(records.slice(index, index + 4).map((record) => this.recoverRecord(record)));
    }
  }

  recoverRecord(record) {
    if (this.recovering.has(record.description)) return this.recovering.get(record.description);
    const flight = (async () => {
      const claimed = await this.journal.claim(record);
      if (!claimed) return;
      try {
        await this.deleteOwnedRecord(claimed);
        await this.journal.finishClaim(claimed);
      } catch (error) {
        await this.journal.finishClaim(claimed, true).catch(this.onError);
        throw error;
      }
    })().catch((error) => this.onError(error)).finally(() => this.recovering.delete(record.description));
    this.recovering.set(record.description, flight);
    return flight;
  }

  async deleteOwnedRecord(record) {
    const limit = budget(2500);
    const service = { type: record.serviceType, url: gatewayUrl(record.controlUrl, record.gateway) };
    const args = { NewRemoteHost: '', NewExternalPort: record.externalPort, NewProtocol: (record.transport || 'udp').toUpperCase() };
    let current;
    try { current = await rpc(service, record.localAddress, 'GetSpecificPortMappingEntry', args, limit); }
    catch (error) { if (error.upnpCode === 714) return; throw error; }
    if (value(current, 'NewInternalClient') !== record.localAddress ||
        Number(value(current, 'NewInternalPort')) !== record.internalPort ||
        value(current, 'NewPortMappingDescription') !== record.description) return;
    try { await rpc(service, record.localAddress, 'DeletePortMapping', args, limit); }
    catch (error) { if (error.upnpCode !== 714) throw error; }
  }

  async discover(gateway, localAddress) {
    if (isIP(gateway) !== 4 || isIP(localAddress) !== 4) throw failure('invalid-interface');
    const key = `${gateway}:${localAddress}`;
    if (this.discovering.has(key)) return this.discovering.get(key);
    const flight = this.discoverOnce(gateway, localAddress);
    this.discovering.set(key, flight);
    try { return await flight; }
    finally { if (this.discovering.get(key) === flight) this.discovering.delete(key); }
  }

  async discoverOnce(gateway, localAddress) {
    const location = await new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4'); let done = false;
      const finish = (error, url) => {
        if (done) return;
        done = true; clearTimeout(timer);
        try { socket.close(); } catch { /* A failed bind may already have closed it. */ }
        if (error) reject(error); else resolve(url);
      };
      const timer = setTimeout(() => finish(failure('discovery-timeout')), 1500);
      socket.on('error', (error) => finish(error));
      socket.on('message', (data, peer) => {
        if (peer.address !== gateway || data.length > 8192) return;
        const message = data.toString('utf8');
        if (!/^HTTP\/1\.[01] 200\b/.test(message)) return;
        const locations = [...message.matchAll(/^location:[ \t]*(.+)\r?$/gim)];
        if (locations.length !== 1) return;
        try { finish(null, gatewayUrl(locations[0][1].trim(), gateway)); } catch { /* Ignore unrelated advertisements. */ }
      });
      socket.bind(0, localAddress, () => {
        if (done) return;
        try {
          if (this.discoveryAddress === '239.255.255.250') {
            socket.setMulticastInterface(localAddress); socket.setMulticastTTL(2);
          }
          const message = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${this.discoveryAddress}:${this.discoveryPort}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`);
          socket.send(message, this.discoveryPort, this.discoveryAddress, (error) => { if (error) finish(error); });
        } catch (error) { finish(error); }
      });
    });
    const response = await requestXml(location, localAddress, budget(1500));
    if (response.status !== 200) throw failure('description-http-status');
    const description = parseXml(response.text);
    const baseText = find(description, 'URLBase')[0]?.text.trim();
    const base = baseText ? gatewayUrl(baseText, gateway, location) : location;
    const services = find(description, 'service').flatMap((node) => {
      const type = value(node, 'serviceType'), control = value(node, 'controlURL');
      if (!SERVICE.test(type) || !control) return [];
      try { return [{ type, url: gatewayUrl(control, gateway, base) }]; } catch { return []; }
    });
    if (!services.length) throw failure('no-wan-service');
    return services.sort((a, b) => Number(b.type.endsWith(':2')) - Number(a.type.endsWith(':2')));
  }

  async createLease(gateway, candidate, lifetimeSeconds, isActive = () => true) {
    if (!isActive()) throw failure('cancelled');
    // Finish any old deletion for this gateway/interface before allocating a
    // fresh external port there; a delayed Delete must not erase a new lease.
    await this.recoverOrphans(gateway, candidate.address);
    if (!isActive()) throw failure('cancelled');
    const services = await this.discover(gateway, candidate.address);
    const remaining = budget(3500);
    let lastError = failure('no-connected-wan');
    for (const service of services) {
      try {
        if (!isActive()) throw failure('cancelled');
        const status = await rpc(service, candidate.address, 'GetStatusInfo', {}, remaining);
        if (value(status, 'NewConnectionStatus') !== 'Connected') continue;
        return await this.mapService(service, candidate, lifetimeSeconds, remaining, isActive);
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }

  async mapService(service, candidate, lifetimeSeconds, remaining, isActive) {
    const transport = candidate.transport || 'udp';
    if (!['udp', 'tcp'].includes(transport)) throw failure('invalid-transport');
    const description = `VDS-${randomBytes(8).toString('hex')}`;
    let externalPort = candidate.port, permanent = false, addAttempted = false, intentRecorded = false;
    const record = () => ({ description, gateway: service.url.hostname, controlUrl: service.url.href,
      serviceType: service.type, localAddress: candidate.address, internalPort: candidate.port, externalPort, transport });
    const args = () => ({ NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: transport.toUpperCase() });
    const invoke = (action, fields, limit) => rpc(service, candidate.address, action, fields, limit);
    const entry = async (limit) => {
      try { return await invoke('GetSpecificPortMappingEntry', args(), limit); }
      catch (error) { if (error.upnpCode === 714) return null; throw error; }
    };
    const owns = (node) => node && value(node, 'NewInternalClient') === candidate.address &&
      Number(value(node, 'NewInternalPort')) === candidate.port && value(node, 'NewPortMappingDescription') === description;
    const release = async () => {
      await this.deleteOwnedRecord(record());
      if (this.journal) await this.journal.forget(description);
    };
    const snapshot = async (node, limit) => {
      if (!owns(node) || !['1', 'true'].includes(value(node, 'NewEnabled'))) throw failure('mapping-not-owned');
      const duration = value(node, 'NewLeaseDuration');
      if (!/^\d+$/.test(duration)) throw failure('invalid-lease-duration');
      const seconds = Number(duration);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffffffff) throw failure('invalid-lease-duration');
      const address = value(await invoke('GetExternalIPAddress', {}, limit), 'NewExternalIPAddress');
      if (isIP(address) !== 4 || address === '0.0.0.0') throw failure('no-external-address');
      permanent = seconds === 0;
      return { protocol: 'upnp', internalPort: candidate.port, externalPort, externalAddress: address,
        lifetimeSeconds: seconds, permanent, refreshAfterSeconds: 90 };
    };
    const add = async (limit) => {
      if (!isActive()) throw failure('cancelled');
      // Commit intent before the router can create a persistent mapping, even
      // if its Add response is lost or this process exits immediately afterwards.
      if (this.journal) { await this.journal.remember(record()); intentRecorded = true; }
      if (!isActive()) throw failure('cancelled');
      const fields = { ...args(), NewInternalPort: candidate.port, NewInternalClient: candidate.address,
        NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: permanent ? 0 : lifetimeSeconds };
      addAttempted = true;
      try { await invoke('AddPortMapping', fields, limit); }
      catch (error) {
        if (error.upnpCode !== 725 || permanent) throw error;
        if (!isActive()) throw failure('cancelled');
        permanent = true; fields.NewLeaseDuration = 0;
        await invoke('AddPortMapping', fields, limit);
      }
    };
    try {
      for (let attempt = 0; attempt < 8; ++attempt) {
        const existing = await entry(remaining);
        if (existing) { externalPort = randomInt(1024, 65536); continue; }
        try { await add(remaining); }
        catch (error) { if (error.upnpCode === 718) { externalPort = randomInt(1024, 65536); continue; } throw error; }
        const mapping = await snapshot(await entry(remaining), remaining);
        return { mapping, release, renew: async () => {
          const limit = budget(3500), current = await entry(limit);
          if (current && !owns(current)) throw failure('mapping-owner-changed');
          if (!current || !permanent) await add(limit);
          return snapshot(await entry(limit), limit);
        } };
      }
      throw failure('port-conflicts');
    } catch (error) {
      // An Add response can be lost after the router already installed it.
      // Remove only the exact mapping bearing this lease's ownership marker.
      if (addAttempted) await release().catch(() => {});
      else if (intentRecorded) await this.journal.forget(description).catch(() => {});
      throw error;
    }
  }
}

module.exports = { UpnpPortMapper, parseXml, gatewayUrl };
