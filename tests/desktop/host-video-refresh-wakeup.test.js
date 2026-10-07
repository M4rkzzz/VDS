const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HostVideoRefreshWakeup } = require('../../desktop/host-video-refresh-wakeup');

function harness() {
  let now = 0;
  let nextTimer = 1;
  const scheduled = new Map();
  const requests = [];
  const errors = [];
  let running = true;
  const wakeup = new HostVideoRefreshWakeup({
    isRunning: () => running,
    invokeStats: () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ promise, resolve, reject });
      return promise;
    },
    onError: (error) => errors.push(error),
    timers: {
      setTimeout(callback, delay) {
        const id = nextTimer++;
        scheduled.set(id, { at: now + delay, callback });
        return id;
      },
      clearTimeout: (id) => scheduled.delete(id)
    }
  });
  function advance(delta) {
    const target = now + delta;
    while (true) {
      const due = [...scheduled].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      scheduled.delete(due[0]);
      due[1].callback();
    }
    now = target;
  }
  const register = (peerId = 'viewer', generation = 'g1', role = 'host-downstream') => {
    const ticket = wakeup.beginCreate({ peerId, role });
    return wakeup.completeCreate(ticket, { peerId, transportGeneration: generation });
  };
  const refresh = (sequence = 1, peerId = 'viewer', generation = 'g1') => wakeup.handleEvent({
    event: 'host-video-refresh-requested', params: { peerId, transportGeneration: generation, requestSequence: sequence }
  });
  const closed = (peerId = 'viewer', generation = 'g1') => wakeup.handleEvent({
    event: 'peer-state', params: { peerId, transportGeneration: generation, state: 'closed' }
  });
  return { wakeup, requests, errors, scheduled, advance, register, refresh, closed,
    setRunning: (value) => { running = value; }, stop: () => { running = false; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('only successful host create registration can wake the controller, without a validation stats RPC', () => {
  const h = harness();
  const ticket = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  assert.equal(h.refresh(), false, 'pending create is not an authenticated local registration');
  assert.equal(h.requests.length, 0);
  assert.equal(h.wakeup.completeCreate(ticket, { peerId: 'viewer', transportGeneration: 'g1' }), true);
  assert.equal(h.refresh(), true);
  assert.equal(h.requests.length, 0, 'validation must never call getStats first');
  h.advance(499);
  assert.equal(h.requests.length, 0);
  h.advance(1);
  assert.equal(h.requests.length, 1);
});

test('cold create survives the real helper startup status rule and wakes after its successful reply', () => {
  const h = harness();
  h.setRunning(false);
  const ticket = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  h.wakeup.handleAgentStatus({ state: 'starting', running: false });
  assert.equal(h.wakeup.peers.get('viewer'), ticket);
  assert.equal(h.refresh(), false);
  h.setRunning(true);
  h.wakeup.handleAgentStatus({ state: 'running', running: true });
  assert.equal(h.wakeup.completeCreate(ticket, { peerId: 'viewer', transportGeneration: 'g1' }), true);
  assert.equal(h.refresh(), true);
  h.advance(500);
  assert.equal(h.requests.length, 1);
});

test('actual inactive agent status clears pending creates, timers and registrations', () => {
  for (const state of ['idle', 'stopped', 'failed', 'unavailable']) {
    const h = harness();
    h.register();
    h.refresh();
    const ticket = h.wakeup.beginCreate({ peerId: 'other', role: 'host-downstream' });
    h.setRunning(false);
    h.wakeup.handleAgentStatus({ state, running: false });
    assert.equal(h.wakeup.peers.size, 0, state);
    assert.equal(h.scheduled.size, 0, state);
    assert.equal(h.wakeup.completeCreate(ticket, { peerId: 'other', transportGeneration: 'g2' }), false, state);
    h.advance(500);
    assert.equal(h.requests.length, 0, state);
  }
});

test('stopping a host cancels queued refresh but retains live transport identity for a later host reattach', () => {
  const h = harness();
  h.register();
  h.refresh();
  h.wakeup.cancelPending();
  h.advance(500);
  assert.equal(h.requests.length, 0);
  assert.equal(h.wakeup.peers.size, 1);
  assert.equal(h.refresh(2), true);
  h.advance(500);
  assert.equal(h.requests.length, 1);
});

test('unknown peers, other roles, wrong generations and invalid or replayed counters are rejected', () => {
  const h = harness();
  assert.equal(h.register('relay', 'r1', 'relay-downstream'), false);
  assert.equal(h.register('upstream', 'u1', 'viewer-upstream'), false);
  assert.equal(h.refresh(1, 'relay', 'r1'), false);
  assert.equal(h.refresh(1, 'unknown', 'g1'), false);
  h.register();
  assert.equal(h.refresh(1, 'viewer', 'old-generation'), false);
  for (const value of [0, -1, '1', true, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(h.refresh(value), false);
  }
  assert.equal(h.refresh(2), true);
  assert.equal(h.refresh(2), false);
  assert.equal(h.refresh(1), false);
  h.advance(500);
  assert.equal(h.requests.length, 1);
});

test('multiple peers and counters coalesce, and events during a pending RPC stay singleflight', async () => {
  const h = harness();
  h.register();
  h.register('viewer2', 'g2');
  h.refresh(1);
  h.refresh(2);
  h.refresh(1, 'viewer2', 'g2');
  h.advance(500);
  assert.equal(h.requests.length, 1);
  h.refresh(3);
  h.refresh(2, 'viewer2', 'g2');
  h.advance(5000);
  assert.equal(h.requests.length, 1, 'a slow native owner must not accumulate concurrent stats RPCs');
  h.requests[0].resolve({});
  await settle();
  h.advance(499);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  assert.equal(h.requests.length, 2);
});

test('close begins cancel pending wakeups, while stale closes preserve the replacement generation', () => {
  const h = harness();
  h.register();
  h.refresh();
  assert.equal(h.wakeup.closePeer({ peerId: 'viewer', transportGeneration: 'old' }), false);
  assert.equal(h.wakeup.closePeer({ peerId: 'viewer', transportGeneration: null }), false);
  assert.equal(h.closed('viewer', 'old'), false);
  assert.equal(h.wakeup.closePeer({ peerId: 'viewer', transportGeneration: 'g1' }), true);
  assert.equal(h.scheduled.size, 0);
  h.advance(500);
  assert.equal(h.requests.length, 0);
  assert.equal(h.refresh(2), false);
  h.register('viewer', 'g2');
  assert.equal(h.closed(), false);
  assert.equal(h.refresh(1, 'viewer', 'g2'), true);
  assert.equal(h.closed('viewer', 'g2'), true);
  h.advance(500);
  assert.equal(h.requests.length, 0);
});

test('late create replies cannot revive a closed, failed, replaced or stopped peer', () => {
  const h = harness();
  const first = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  h.wakeup.closePeer({ peerId: 'viewer' });
  assert.equal(h.wakeup.completeCreate(first, { peerId: 'viewer', transportGeneration: 'g1' }), false);
  const failed = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  h.wakeup.failCreate(failed);
  assert.equal(h.wakeup.completeCreate(failed, { peerId: 'viewer', transportGeneration: 'g1' }), false);
  const old = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  h.register('viewer', 'g2');
  assert.equal(h.wakeup.completeCreate(old, { peerId: 'viewer', transportGeneration: 'g1' }), false);
  assert.equal(h.refresh(1, 'viewer', 'g2'), true);
  const pending = h.wakeup.beginCreate({ peerId: 'other', role: 'host-downstream' });
  h.wakeup.reset();
  assert.equal(h.wakeup.completeCreate(pending, { peerId: 'other', transportGeneration: 'g3' }), false);
});

test('a closed event ahead of its create reply rejects only the matching generation', () => {
  const h = harness();
  const ticket = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  for (let index = 0; index < 5; ++index) h.closed('viewer', `old-${index}`);
  assert.equal(h.wakeup.peers.get('viewer'), ticket, 'old close history cannot discard the pending new transport');
  assert.equal(h.wakeup.completeCreate(ticket, { peerId: 'viewer', transportGeneration: 'g1' }), true);
  assert.equal(h.refresh(), true);
  const closedTicket = h.wakeup.beginCreate({ peerId: 'viewer', role: 'host-downstream' });
  for (let index = 0; index < 5; ++index) h.closed('viewer', `old-${index}`);
  h.closed('viewer', 'g2');
  assert.equal(h.wakeup.completeCreate(closedTicket, { peerId: 'viewer', transportGeneration: 'g2' }), false);
});

test('stopped agents and quit cancel timers and never invoke an auto-starting manager', () => {
  const h = harness();
  h.register();
  h.refresh();
  h.stop();
  h.advance(500);
  assert.equal(h.requests.length, 0, 'the flush guard must prevent manager.invoke from restarting the child');
  assert.equal(h.wakeup.peers.size, 0);
  const quit = harness();
  quit.register();
  quit.refresh();
  quit.wakeup.dispose();
  quit.advance(500);
  assert.equal(quit.requests.length, 0);
  assert.equal(quit.scheduled.size, 0);
  assert.equal(quit.register(), false);
});

test('an old RPC completion cannot clear the replacement agent flight or schedule stale work', async () => {
  const h = harness();
  h.register();
  h.refresh();
  h.advance(500);
  h.wakeup.reset();
  h.register('viewer', 'g2');
  h.refresh(1, 'viewer', 'g2');
  h.advance(500);
  assert.equal(h.requests.length, 2);
  h.refresh(2, 'viewer', 'g2');
  h.requests[0].reject(new Error('old process exited'));
  await settle();
  h.advance(5000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.errors.length, 0, 'stale completion must not report an error for the new process');
  h.requests[1].resolve({});
  await settle();
  h.advance(500);
  assert.equal(h.requests.length, 3);
});

test('all 512 active host peers remain registered and their requests coalesce into one flight', async () => {
  const h = harness();
  for (let index = 0; index < 512; ++index) {
    assert.equal(h.register(`viewer-${index}`, `generation-${index}`), true);
    assert.equal(h.refresh(1, `viewer-${index}`, `generation-${index}`), true);
  }
  assert.equal(h.wakeup.peers.size, 512);
  assert.equal(h.wakeup.pending.size, 512);
  h.advance(500);
  assert.equal(h.requests.length, 1);
  for (let index = 0; index < 512; ++index) h.wakeup.closePeer({ peerId: `viewer-${index}` });
  assert.equal(h.wakeup.peers.size, 0, 'registrations follow the actual peer close lifecycle');
  h.requests[0].resolve({});
  await settle();
  h.advance(500);
  assert.equal(h.requests.length, 1);
});

test('failed wakeups do not retry or restart the native agent', async () => {
  const h = harness();
  h.register();
  h.refresh();
  h.advance(500);
  h.requests[0].reject(new Error('native owner unavailable'));
  await settle();
  h.advance(5000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.errors.length, 1);
  assert.equal(h.scheduled.size, 0);
});
