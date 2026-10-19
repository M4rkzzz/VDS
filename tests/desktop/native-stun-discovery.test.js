const assert = require('node:assert/strict');
const test = require('node:test');
const { NativeStunDiscovery, prepareNativeStunConfiguration } = require('../../desktop/native-stun-discovery');
const { getStunServerPool } = require('../../desktop/stun-server-selector');
const tcp = 'stun:turn.cloudflare.com:3478?transport=tcp';
const pool = [1, 2, 3, 4].map((i) => `stun:udp${i}.example:3478`).concat(tcp);
const fake = async () => [{ address: '198.18.1.0', family: 4 }];
const answer = (address = '141.101.90.1', ttl = 30) => ({ Status: 0,
  Question: [{ name: 'turn.cloudflare.com.', type: 1 }],
  Answer: [{ name: 'turn.cloudflare.com.', type: 1, TTL: ttl, data: address }] });
const response = (value) => ({ ok: true, json: async () => value });

test('fake-IP recovery preserves UDP slots, uses DNS TTL and shares concurrent discovery', async () => {
  let now = 0, requests = 0, lookups = 0;
  const resolver = new NativeStunDiscovery({ now: () => now,
    lookup: async () => { lookups += 1; return fake(); },
    fetch: async () => { requests += 1; return response(answer()); } });
  const expected = [...pool.slice(0, 4), 'stun:141.101.90.1:3478?transport=tcp', tcp];
  const results = await Promise.all([resolver.resolve(pool), resolver.resolve(pool)]);
  assert.deepEqual(results, [expected, expected]);
  assert.equal(lookups, 1);
  assert.equal(requests, 2, 'one request per resolver, shared by simultaneous peers');
  now = 29999;
  assert.deepEqual(await resolver.resolve(pool), expected);
  assert.equal(lookups, 1);
  now = 30001;
  await resolver.resolve(pool);
  assert.equal(lookups, 2, 'expired DNS addresses must be refreshed');
  assert.equal(pool.length, 5, 'caller configuration must not be mutated');
});

test('ordinary DNS and custom endpoints do not invoke public DNS fallback', async () => {
  let lookups = 0;
  const resolver = new NativeStunDiscovery({
    lookup: async () => { lookups += 1; return [{ address: '141.101.90.1', family: 4 }]; },
    fetch: async () => { assert.fail('normal DNS must not query HTTPS resolvers'); } });
  assert.deepEqual(await resolver.resolve(pool), pool);
  const custom = ['stun:private.example?transport=tcp'];
  assert.deepEqual(await resolver.resolve(custom), custom);
  assert.equal(lookups, 1);
});

test('configured TCP endpoints are retained when adding a recovered address', async () => {
  const resolver = new NativeStunDiscovery({ lookup: fake, fetch: async () => response(answer()) });
  const custom = [tcp, 'stun:one.example?transport=tcp', 'stun:two.example?transport=tcp'];
  assert.deepEqual(await resolver.resolve(custom), ['stun:141.101.90.1:3478?transport=tcp', ...custom]);
  const full = custom.concat('stun:three.example?transport=tcp');
  assert.deepEqual(await resolver.resolve(full), full);
});

test('one unreachable HTTPS resolver does not prevent the other from recovering DNS', async () => {
  const resolver = new NativeStunDiscovery({ lookup: fake,
    fetch: async (url) => { if (url.includes('cloudflare-dns')) throw new Error('ECONNRESET'); return response(answer()); } });
  assert.ok((await resolver.resolve(pool)).includes('stun:141.101.90.1:3478?transport=tcp'));
});

test('failed, mismatched and non-public DNS answers retain usable original ICE configuration', async () => {
  for (const value of [
    { ...answer(), Status: 2 }, { ...answer(), TC: true }, { ...answer(), Question: [] },
    answer('198.18.1.0'), answer('127.0.0.1'), answer('10.0.0.1'), answer('100.64.0.1'),
    answer('192.168.1.1'), answer('203.0.113.77'), answer('not-an-ip'), answer('141.101.90.1', -1)
  ]) {
    const resolver = new NativeStunDiscovery({ lookup: fake, fetch: async () => response(value) });
    assert.deepEqual(await resolver.resolve(pool), pool);
  }
});

test('DNS timeouts cannot prevent peer creation and are briefly cached', async () => {
  let requests = 0;
  const resolver = new NativeStunDiscovery({ lookup: fake, timeoutMs: 30,
    fetch: (_url, { signal }) => new Promise((_, reject) => {
      requests += 1;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  assert.deepEqual(await resolver.resolve(pool), pool);
  assert.deepEqual(await resolver.resolve(pool), pool);
  assert.equal(requests, 2);
});

test('known UDP defaults recover their own addresses concurrently without consuming extra UDP slots', async () => {
  const defaults = getStunServerPool();
  const names = defaults.map((url) => url.slice(5).split(':')[0]);
  const ips = ['141.101.90.1', '8.8.8.8', '1.1.1.1', '9.9.9.9'];
  const lookups = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resolver = new NativeStunDiscovery({ lookup: async (host) => { lookups.push(host); await gate; return fake(); },
    fetch: async (url) => {
      const host = new URL(url).searchParams.get('name');
      const value = answer(ips[names.indexOf(host)] || '141.101.90.1');
      value.Question[0].name = value.Answer[0].name = host + '.';
      return response(value);
    } });
  const pending = resolver.resolve([...defaults, tcp, 'stun:private.example:3478']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(lookups), new Set([...names, 'turn.cloudflare.com']));
  release();
  const resolved = await pending;
  assert.deepEqual(resolved.filter((url) => !url.endsWith('?transport=tcp')),
    [...ips.map((ip) => `stun:${ip}:3478`), 'stun:private.example:3478']);
  assert.deepEqual(defaults, getStunServerPool(), 'default hostname list remains immutable');
});

test('one failed UDP DNS recovery retains that hostname while the other known default recovers', async () => {
  const defaults = getStunServerPool().slice(0, 2);
  const resolver = new NativeStunDiscovery({ lookup: fake, fetch: async (url) => {
    const host = new URL(url).searchParams.get('name');
    if (host !== 'stun.cloudflare.com') throw new Error('unavailable');
    const value = answer(); value.Question[0].name = value.Answer[0].name = host + '.';
    return response(value);
  } });
  assert.deepEqual(await resolver.resolve(defaults), ['stun:141.101.90.1:3478', defaults[1]]);
});

test('UDP selection probes the resolved endpoints instead of trusting the proxy preflight', async () => {
  const original = [{ urls: getStunServerPool() }];
  const chosen = 'stun:141.101.90.1:3478';
  const calls = [];
  const selector = { select: async (servers) => {
    calls.push(servers);
    if (servers === original) return { url: original[0].urls[0], reachable: true };
    assert.equal(servers[0].urls[0], chosen);
    return { url: chosen, reachable: true };
  } };
  const config = await prepareNativeStunConfiguration(original, selector,
    { resolve: async (urls) => [chosen, ...urls.slice(1)] });
  assert.equal(calls.length, 2);
  assert.equal(config.url, chosen);
  assert.equal(config.stunServers[0], chosen);
  assert.equal(config.stunServers.filter((url) => !url.endsWith('?transport=tcp')).length, 4);
});

test('resolved selection can finish while the original lookup is still pending', async () => {
  const original = [{ urls: getStunServerPool() }];
  const chosen = 'stun:141.101.90.1:3478';
  const config = await prepareNativeStunConfiguration(original,
    { select: (servers) => servers === original ? new Promise(() => {}) : Promise.resolve({ url: chosen, reachable: true }) },
    { resolve: async (urls) => [chosen, ...urls.slice(1)] });
  assert.equal(config.url, chosen);
});

test('unexpected preflight errors still hand the original ICE pool to the native agent', async () => {
  const config = await prepareNativeStunConfiguration(undefined,
    { select: async () => { throw new Error('socket-unavailable'); } }, { resolve: async (pool) => pool });
  assert.equal(config.reachable, false);
  assert.equal(config.url, getStunServerPool()[0]);
  assert.equal(config.stunServers.length, 5);
});

test('unreachable recovered UDP addresses retain the responding original service in its own slot', async () => {
  const defaults = getStunServerPool();
  const original = [{ urls: defaults }];
  const direct = defaults.map((_url, i) => `stun:8.8.8.${i + 1}:3478`);
  const config = await prepareNativeStunConfiguration(original, {
    select: async (servers) => servers === original
      ? { url: defaults[2], reachable: true }
      : { url: direct[0], reachable: false }
  }, { resolve: async () => [...direct, tcp] });
  assert.equal(config.reachable, true);
  assert.equal(config.url, defaults[2]);
  assert.deepEqual(config.stunServers, [defaults[2], direct[0], direct[1], direct[3], tcp]);
  assert.equal(config.stunServers.filter((url) => !url.endsWith('?transport=tcp')).length, 4);
});

test('original UDP fallback after the fourth entry remains selectable', async () => {
  const urls = Array.from({ length: 6 }, (_, i) => `stun:udp${i}.example:3478`);
  const original = [{ urls }];
  const config = await prepareNativeStunConfiguration(original, {
    select: async (servers) => servers === original
      ? { url: urls[5], reachable: true }
      : { url: 'stun:8.8.8.8:3478', reachable: false }
  }, { resolve: async () => ['stun:8.8.8.8:3478', ...urls.slice(1), tcp] });
  assert.equal(config.url, urls[5]);
  assert.equal(config.stunServers[0], urls[5]);
  assert.equal(config.stunServers.filter((url) => !url.endsWith('?transport=tcp')).length, 4);
  assert.ok(config.stunServers.includes(tcp));
});

test('failed original and recovered probes do not block ICE or discard recovered addresses', async () => {
  const urls = getStunServerPool();
  const recovered = ['stun:8.8.8.8:3478', ...urls.slice(1), tcp];
  const config = await prepareNativeStunConfiguration([{ urls }], {
    select: async () => { throw new Error('udp-blocked'); }
  }, { resolve: async () => recovered });
  assert.equal(config.reachable, false);
  assert.equal(config.url, recovered[0]);
  assert.deepEqual(config.stunServers, recovered);
});
