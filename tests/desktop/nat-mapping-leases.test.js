const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NatMappingLeases } = require('../../desktop/nat-mapping-leases');

const flush = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function harness() {
  let now = 0, id = 0;
  const timers = new Map(), errors = [];
  const leases = new NatMappingLeases({ now: () => now, random: () => 0,
    timers: { setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
      clearTimeout(key) { timers.delete(key); } }, onError: (error) => errors.push(error.message) });
  const peer = (peerId = 'p', generation = 'g') => {
    const owner = leases.beginCreate({ peerId });
    assert.equal(leases.completeCreate(owner, { peerId, transportGeneration: generation }), true);
    return owner;
  };
  async function tick(ms) {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = target; await flush();
  }
  return { leases, timers, errors, peer, tick };
}
const mapping = (lifetimeSeconds = 4, externalPort = 55000) => ({
  lifetimeSeconds, externalPort, externalAddress: '198.51.100.5', protocol: 'pcp'
});

test('router-granted lifetime drives renewal, failed renewal retries before expiry, and a changed endpoint is announced', async () => {
  const h = harness(), owner = h.peer(), updates = [], releases = [];
  let calls = 0;
  await h.leases.acquire(owner, 'gateway:ip:port', async () => ({ mapping: mapping(),
    renew: async () => { if (++calls === 1) throw new Error('lost-response'); return mapping(2, 55001); },
    release: async (value) => releases.push(value)
  }), (value) => updates.push(value));
  await h.tick(1999); assert.equal(calls, 0);
  await h.tick(1); assert.equal(calls, 1);
  await h.tick(1000); assert.equal(calls, 2);
  assert.equal(updates[0].externalPort, 55001);
  await h.tick(1000); assert.equal(calls, 3);
  assert.equal(updates.length, 1, 'unchanged renewals produce no signaling traffic');
  await h.leases.dispose();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].externalPort, 55001);
  assert.equal(h.timers.size, 0);
});

test('shared internal socket tuple has one lease and survives closing one of its owners', async () => {
  const h = harness(); const first = h.peer('a'), second = h.peer('b');
  let creates = 0, releases = 0;
  const create = async () => { ++creates; return { mapping: mapping(), renew: async () => mapping(), release: async () => { ++releases; } }; };
  await Promise.all([h.leases.acquire(first, 'tuple', create), h.leases.acquire(second, 'tuple', create)]);
  assert.equal(creates, 1);
  h.leases.closePeer({ peerId: 'a', transportGeneration: 'g' }); await flush();
  assert.equal(releases, 0); assert.equal(h.timers.size, 1);
  h.leases.closePeer({ peerId: 'b', transportGeneration: 'g' }); await flush();
  assert.equal(releases, 1); assert.equal(h.leases.leases.size, 0);
});

test('close during allocation releases its late result and never arms a renewal', async () => {
  const h = harness(), owner = h.peer(), opening = deferred(); let releases = 0;
  const pending = h.leases.acquire(owner, 'tuple', () => opening.promise);
  h.leases.closePeer({ peerId: 'p', transportGeneration: 'g' });
  opening.resolve({ mapping: mapping(), renew: async () => assert.fail('closed lease renewed'), release: async () => { ++releases; } });
  assert.equal(await pending, null); await flush();
  assert.equal(releases, 1); assert.equal(h.timers.size, 0); assert.equal(h.leases.leases.size, 0);
});

test('renewal, deletion, and reuse of a NAT-PMP tuple are ordered across native generations', async () => {
  const h = harness(), owner = h.peer(), renewing = deferred(), deleting = deferred(); const events = [];
  await h.leases.acquire(owner, 'tuple', async () => ({ mapping: mapping(),
    renew: () => { events.push('renew'); return renewing.promise; },
    release: () => { events.push('delete'); return deleting.promise; }
  }), () => assert.fail('closed generation published a changed endpoint'));
  await h.tick(2000);
  const next = h.peer('p', 'next');
  const reopening = h.leases.acquire(next, 'tuple', async () => {
    events.push('new'); return { mapping: mapping(), renew: async () => mapping(), release: async () => {} };
  });
  await flush(); assert.deepEqual(events, ['renew']);
  renewing.resolve(mapping(4, 56000)); await flush();
  assert.deepEqual(events, ['renew', 'delete']);
  deleting.resolve(); await reopening;
  assert.deepEqual(events, ['renew', 'delete', 'new']);
  h.leases.closePeer({ peerId: 'p', transportGeneration: 'g' });
  assert.equal(h.leases.getPeer({ peerId: 'p', transportGeneration: 'next' }), next);
  await h.leases.dispose(); assert.equal(h.timers.size, 0);
});

test('early native close, stale create replies, and agent exit cannot adopt or retain a mapping', async () => {
  const h = harness(); const old = h.leases.beginCreate({ peerId: 'p' });
  h.leases.handleEvent({ event: 'peer-state', params: { peerId: 'p', transportGeneration: 'g', state: 'closed' } });
  assert.equal(h.leases.completeCreate(old, { peerId: 'p', transportGeneration: 'g' }), false);
  const pending = h.leases.beginCreate({ peerId: 'p' });
  const next = h.peer('p', 'new');
  assert.equal(h.leases.completeCreate(pending, { peerId: 'p', transportGeneration: 'old' }), false);
  let releases = 0;
  await h.leases.acquire(next, 'tuple', async () => ({ mapping: mapping(), renew: async () => mapping(), release: async () => { ++releases; } }));
  assert.equal(h.leases.getPeer({ peerId: 'p' }), null, 'mapping requests must name the native generation');
  h.leases.handleAgentStatus({ state: 'stopped', running: false }); await flush();
  assert.equal(releases, 1); assert.equal(h.timers.size, 0); assert.equal(h.leases.peers.size, 0);
});

test('expiry never closes the peer and later router recovery can restore the mapping', async () => {
  const h = harness(), owner = h.peer(); let online = false, calls = 0;
  await h.leases.acquire(owner, 'tuple', async () => ({ mapping: mapping(1),
    renew: async () => { ++calls; if (!online) throw new Error('offline'); return mapping(); }, release: async () => {}
  }));
  await h.tick(7000); assert.equal(h.leases.current(owner), true);
  const before = calls; online = true; await h.tick(5000);
  assert.ok(calls > before); assert.equal(h.leases.leases.get('tuple').value.mapping.lifetimeSeconds, 4);
  await h.leases.dispose();
});

test('large router-granted lifetimes cannot overflow a Node timer into a one-millisecond renewal loop', async () => {
  const h = harness(), owner = h.peer();
  await h.leases.acquire(owner, 'tuple', async () => ({ mapping: mapping(0xffffffff),
    renew: async () => assert.fail('premature renewal'), release: async () => {}
  }));
  const timer = [...h.timers.values()][0];
  assert.equal(timer.at, 0x7fffffff);
  await h.tick(10000);
  await h.leases.dispose();
});

test('permanent UPnP leases use explicit refresh checks and still release on native close', async () => {
  const h = harness(), owner = h.peer(); let refreshed = 0, released = 0;
  const permanent = { ...mapping(0), protocol: 'upnp', permanent: true };
  await h.leases.acquire(owner, 'tuple', async () => ({ mapping: permanent,
    renew: async () => { ++refreshed; return permanent; }, release: async () => { ++released; }
  }));
  await h.tick(89999); assert.equal(refreshed, 0);
  await h.tick(1); assert.equal(refreshed, 1);
  h.leases.closePeer({ peerId: 'p', transportGeneration: 'g' }); await flush();
  assert.equal(released, 1); assert.equal(h.timers.size, 0);
});

test('mapping cancellation follows all lease owners, not only the peer that created it', async () => {
  const h = harness(), first = h.peer('first'), second = h.peer('second'); let active;
  const create = async (isActive) => {
    active = isActive;
    return { mapping: mapping(), renew: async () => { assert.equal(isActive(), true); return mapping(); }, release: async () => {} };
  };
  await h.leases.acquire(first, 'shared-tuple', create);
  await h.leases.acquire(second, 'shared-tuple', create);
  h.leases.closePeer({ peerId: 'first', transportGeneration: 'g' });
  assert.equal(active(), true);
  await h.tick(2000);
  h.leases.closePeer({ peerId: 'second', transportGeneration: 'g' });
  assert.equal(active(), false); await flush();
  assert.equal(h.timers.size, 0);
});
