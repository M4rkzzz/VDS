const dns = require('node:dns').promises;
const net = require('node:net');
const { getStunServerPool, getNativeStunServerPool } = require('./stun-server-selector');

const HOST = 'turn.cloudflare.com';
const ENDPOINT = `stun:${HOST}:3478?transport=tcp`;
const PUBLIC_UDP_ENDPOINTS = new Set(getStunServerPool());

function isSyntheticAddress(address) {
  return net.isIP(address) === 4 && /^198\.(18|19)\./.test(address);
}

function isPublicIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && b === 0 && (c === 0 || c === 2)) &&
    !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113) &&
    !isSyntheticAddress(address);
}

async function withDeadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('dns-deadline')), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

class NativeStunDiscovery {
  constructor({ lookup = dns.lookup, fetch = globalThis.fetch, now = Date.now, timeoutMs = 1500 } = {}) {
    this.lookup = lookup;
    this.fetch = fetch;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cached = new Map();
    this.pending = new Map();
  }

  async resolve(pool) {
    const tcpCount = pool.filter((url) => url.endsWith('?transport=tcp')).length;
    const tcpAddresses = pool.includes(ENDPOINT) && tcpCount < 4 ? this.addresses(HOST) : Promise.resolve([]);
    // Resolve only known public defaults. A numeric address names the same UDP
    // service and occupies the same slot; custom/private names stay untouched.
    const udp = await Promise.all(pool.filter((url) => !url.endsWith('?transport=tcp')).map(async (url) => {
      if (!PUBLIC_UDP_ENDPOINTS.has(url)) return url;
      const host = url.slice(5).split(':')[0];
      const addresses = await this.addresses(host);
      return addresses.length ? `stun:${addresses[0]}:3478` : url;
    }));
    const addresses = await tcpAddresses;
    const additions = addresses.map((ip) => `stun:${ip}:3478?transport=tcp`)
      .filter((url) => !pool.includes(url)).slice(0, 4 - tcpCount);
    return [...udp, ...additions, ...pool.filter((url) => url.endsWith('?transport=tcp'))];
  }

  async addresses(host) {
    const cached = this.cached.get(host);
    if (cached && cached.expiresAt > this.now()) return cached.addresses;
    if (this.pending.has(host)) return this.pending.get(host);
    const pending = this.discover(host).catch(() => ({ addresses: [], ttlMs: 10000 })).then((result) => {
      this.cached.set(host, { ...result, expiresAt: this.now() + result.ttlMs });
      return result.addresses;
    }).finally(() => { this.pending.delete(host); });
    this.pending.set(host, pending);
    return pending;
  }

  async discover(host) {
    const system = await withDeadline(this.lookup(host, { all: true }), Math.min(500, this.timeoutMs)).catch(() => []);
    if (system.length && !system.some(({ address }) => isSyntheticAddress(address))) {
      return { addresses: [], ttlMs: 30000 };
    }
    // A proxy's fake-IP may yield the proxy exit's mapped endpoint, which is
    // not the local socket's direct NAT mapping. Resolve dynamically over HTTPS
    // while retaining the hostname as a fallback; never pin provider IPs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const name = encodeURIComponent(host);
      const resolvers = [`https://cloudflare-dns.com/dns-query?name=${name}&type=A`,
        `https://dns.google/resolve?name=${name}&type=A&edns_client_subnet=0.0.0.0/0`];
      return await Promise.any(resolvers.map(async (url) => {
        const response = await this.fetch(url, { headers: { accept: 'application/dns-json' }, signal: controller.signal });
        if (!response.ok) throw new Error('dns-http-failed');
        const answer = await response.json();
        if (answer.Status !== 0 || answer.TC || !answer.Question?.some((q) =>
          q.type === 1 && String(q.name).toLowerCase().replace(/\.$/, '') === host)) throw new Error('dns-answer-mismatch');
        const records = (Array.isArray(answer.Answer) ? answer.Answer : []).filter((record) =>
          record.type === 1 && String(record.name).toLowerCase().replace(/\.$/, '') === host &&
          Number.isFinite(record.TTL) && record.TTL >= 0 && isPublicIpv4(record.data));
        if (!records.length) throw new Error('dns-public-address-missing');
        return { addresses: [...new Set(records.map((r) => r.data))],
          ttlMs: Math.min(300000, ...records.map((r) => r.TTL * 1000)) };
      }));
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

async function prepareNativeStunConfiguration(servers, selector, discovery) {
  const originalPool = getStunServerPool(servers);
  const choose = (configured, pool) => Promise.resolve().then(() => selector.select(configured))
    .catch(() => ({ url: pool.find((url) => !url.endsWith('?transport=tcp')) || pool[0], reachable: false }));
  const originalSelection = choose(servers, originalPool);
  const tcpPool = getNativeStunServerPool(servers).filter((url) => url.endsWith('?transport=tcp'));
  const originalUdp = originalPool.filter((url) => !url.endsWith('?transport=tcp'));
  const resolved = await discovery.resolve([...originalUdp, ...tcpPool]);
  const resolvedUdp = resolved.filter((url) => !url.endsWith('?transport=tcp'));
  // A reachable proxy endpoint is not proof the direct endpoint responds.
  // Probe the resolved addresses and select from that pool when it changed.
  let selection = JSON.stringify(originalUdp) === JSON.stringify(resolvedUdp)
    ? await originalSelection : await choose([{ urls: resolved }], resolved);
  if (!selection.reachable) {
    const fallback = await originalSelection;
    if (fallback.reachable) {
      // DNS success alone does not make the recovered UDP route reachable.
      // Keep a responding original service in its corresponding slot rather
      // than displacing a different provider or increasing the native pool.
      const slot = originalUdp.indexOf(fallback.url);
      if (slot >= 0) resolved[slot] = fallback.url;
      selection = fallback;
    }
  }
  const stunServers = getNativeStunServerPool([{ urls: resolved }], selection.url);
  return { ...selection, stunServers };
}

module.exports = { NativeStunDiscovery, prepareNativeStunConfiguration };
