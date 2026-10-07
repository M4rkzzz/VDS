const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');

// Match the first four endpoints already configured by the signaling server.
// Native ICE resolves and deduplicates endpoints before using mapping samples.
const DEFAULT_STUN_SERVERS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.linphone.org:3478',
  'stun:stun.freeswitch.org:3478',
  'stun:stun.pjsip.org:3478'
];
const MAGIC_COOKIE = 0x2112a442;

function normalizeStunUrls(servers) {
  const urls = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    for (const value of Array.isArray(server?.urls) ? server.urls : [server?.urls]) {
      const input = String(value || '').trim();
      // TURN and relay credentials never cross into the native transport.
      const match = /^stun:(\[[\da-f:.]+\]|[a-z\d.-]+)(?::(\d+))?$/i.exec(input);
      if (!match || input.length > 256) continue;
      const host = match[1].toLowerCase();
      if (host.startsWith('[')) {
        if (net.isIP(host.slice(1, -1)) !== 6) continue;
      } else if (host.replace(/\.$/, '').split('.').some((label) =>
        !label || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) continue;
      const port = Number(match[2] || 3478);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const url = `stun:${host}${match[2] ? `:${port}` : ''}`;
      if (!urls.includes(url)) urls.push(url);
      if (urls.length === 8) return urls;
    }
  }
  return urls;
}

function getStunServerPool(servers) {
  const configured = normalizeStunUrls(servers);
  return configured.length ? configured : [...DEFAULT_STUN_SERVERS];
}

function hasMappedAddress(message, transaction) {
  if (message.length < 20 || message.readUInt16BE(0) !== 0x0101 ||
      message.readUInt32BE(4) !== MAGIC_COOKIE || !message.subarray(8, 20).equals(transaction)) return false;
  const end = 20 + message.readUInt16BE(2);
  if (end > message.length) return false;
  for (let offset = 20; offset + 4 <= end;) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    if (offset + 4 + length > end) return false;
    if ((type === 0x0020 || type === 0x0001) &&
        ((length === 8 && message[offset + 5] === 1) || (length === 20 && message[offset + 5] === 2))) return true;
    offset += 4 + Math.ceil(length / 4) * 4;
  }
  return false;
}

function probeStunServer(url, timeoutMs = 1500) {
  const match = /^stun:(\[[\da-f:.]+\]|[a-z\d.-]+)(?::(\d+))?$/i.exec(url);
  const host = match[1].replace(/^\[|\]$/g, '');
  const port = Number(match[2] || 3478);
  const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  const transaction = crypto.randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt32BE(MAGIC_COOKIE, 4);
  transaction.copy(request, 8);
  let complete;
  let finished = false;
  let timer;
  let retry;
  const promise = new Promise((resolve) => { complete = resolve; });
  const finish = (reachable) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(retry);
    try { socket.close(); } catch { /* DNS errors can arrive before bind. */ }
    complete(reachable ? url : null);
  };
  socket.on('error', () => finish(false));
  socket.on('message', (message) => { if (hasMappedAddress(message, transaction)) finish(true); });
  timer = setTimeout(() => finish(false), timeoutMs);
  socket.connect(port, host, () => {
    if (finished) return;
    const send = () => { if (!finished) socket.send(request, (error) => { if (error) finish(false); }); };
    send();
    retry = setTimeout(send, Math.min(500, timeoutMs / 2));
  });
  return { promise, cancel: () => finish(false) };
}

class StunServerSelector {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 1500;
    this.cache = new Map();
    this.pending = new Map();
  }

  async select(servers) {
    const urls = getStunServerPool(servers);
    const key = JSON.stringify(urls);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (this.pending.has(key)) return this.pending.get(key);
    const selection = this.selectUncached(urls).then((result) => {
      // Retry unavailable servers soon; successful probes are shared between peers.
      this.cache.set(key, { result, expiresAt: Date.now() + (result.reachable ? 120000 : 10000) });
      while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, selection);
    return selection;
  }

  async selectUncached(urls) {
    const probes = urls.map((url) => probeStunServer(url, this.timeoutMs));
    try {
      const url = await Promise.any(probes.map(({ promise }) => promise.then((result) => {
        if (!result) throw new Error('stun-unreachable');
        return result;
      })));
      return { url, reachable: true };
    } catch {
      // STUN may be blocked while LAN host candidates still work. Let ICE proceed.
      return { url: urls[0], reachable: false };
    } finally {
      for (const probe of probes) probe.cancel();
    }
  }
}

module.exports = { StunServerSelector, normalizeStunUrls, getStunServerPool };
