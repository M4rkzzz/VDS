// Own explicit router leases for the lifetime of the native transport that
// requested them. Router operations never run on the media packet path.
class NatMappingLeases {
  constructor({ timers = globalThis, now = () => performance.now(), random = Math.random, onError = () => {} } = {}) {
    this.timers = timers;
    this.now = now;
    this.random = random;
    this.onError = onError;
    this.peers = new Map();
    this.leases = new Map();
    this.disposed = false;
  }

  beginCreate({ peerId } = {}) {
    if (!peerId || this.disposed) return null;
    this.forget(this.peers.get(peerId));
    const ticket = { peerId, generation: '', closedGenerations: new Set() };
    this.peers.set(peerId, ticket);
    return ticket;
  }

  completeCreate(ticket, result = {}) {
    if (!this.current(ticket)) return false;
    const generation = result.transportGeneration;
    if (!generation || result.peerId !== ticket.peerId || ticket.closedGenerations.has(generation)) {
      this.forget(ticket);
      return false;
    }
    ticket.generation = generation;
    ticket.closedGenerations.clear();
    return true;
  }

  current(ticket) { return Boolean(ticket && !this.disposed && this.peers.get(ticket.peerId) === ticket); }
  getPeer({ peerId, transportGeneration } = {}) {
    const ticket = this.peers.get(peerId);
    return this.current(ticket) && ticket.generation && ticket.generation === transportGeneration ? ticket : null;
  }

  closePeer({ peerId, transportGeneration } = {}) {
    const ticket = this.peers.get(peerId);
    if (!ticket || !transportGeneration) return;
    if (!ticket.generation) { ticket.closedGenerations.add(transportGeneration); return; }
    if (ticket.generation === transportGeneration) this.forget(ticket);
  }

  handleEvent({ event, params = {} } = {}) {
    if (event === 'peer-state' && ['failed', 'closed'].includes(params.state)) this.closePeer(params);
  }

  handleAgentStatus(status = {}) {
    if (status.running === false && status.state !== 'starting') this.reset();
  }

  forget(ticket) {
    if (!ticket || this.peers.get(ticket.peerId) !== ticket) return;
    this.peers.delete(ticket.peerId);
    for (const lease of this.leases.values()) {
      lease.owners.delete(ticket);
      if (!lease.owners.size) this.retire(lease);
    }
  }

  async acquire(ticket, key, create, onChange = () => {}) {
    if (!this.current(ticket)) return null;
    let lease = this.leases.get(key);
    // Finish deleting an old mapping before reusing its internal socket tuple.
    // Otherwise an old lifetime=0 packet can erase a new NAT-PMP mapping.
    if (lease && lease.closing) {
      await lease.closing;
      return this.acquire(ticket, key, create, onChange);
    }
    if (!lease) {
      lease = { key, owners: new Map(), timer: null, value: null, flight: null, closing: null, expiresAt: 0 };
      this.leases.set(key, lease);
      lease.flight = Promise.resolve().then(() => create(() =>
        !this.disposed && !lease.closing && lease.owners.size > 0)).then((value) => {
        lease.value = value;
        this.accept(lease, value.mapping);
        return value;
      });
    }
    lease.owners.set(ticket, onChange);
    try {
      await lease.flight;
      return this.current(ticket) && !lease.closing ? lease.value.mapping : null;
    } catch (error) {
      this.retire(lease);
      throw error;
    }
  }

  accept(lease, mapping) {
    const seconds = mapping && mapping.lifetimeSeconds;
    if (seconds === 0 && mapping.permanent === true) {
      lease.value.mapping = mapping;
      lease.expiresAt = Infinity;
      this.schedule(lease, 90000);
      return;
    }
    if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('nat-mapping-invalid-lifetime');
    lease.value.mapping = mapping;
    lease.expiresAt = this.now() + seconds * 1000;
    // RFC 6887 11.2.1: renew in the half-to-five-eighths interval.
    this.schedule(lease, seconds * 1000 * (0.5 + this.random() * 0.125));
  }

  schedule(lease, delay) {
    if (lease.closing || !lease.owners.size || this.disposed) return;
    if (lease.timer !== null) this.timers.clearTimeout(lease.timer);
    lease.timer = this.timers.setTimeout(() => {
      lease.timer = null;
      this.renew(lease);
    }, Math.min(0x7fffffff, Math.max(1, delay)));
    lease.timer?.unref?.();
  }

  renew(lease) {
    if (lease.closing || !lease.owners.size || !lease.value) return;
    const previous = lease.value.mapping;
    lease.flight = Promise.resolve().then(() => lease.value.renew(previous)).then((mapping) => {
      this.accept(lease, mapping);
      if (!lease.closing && (previous.externalAddress !== mapping.externalAddress || previous.externalPort !== mapping.externalPort)) {
        for (const [ticket, notify] of lease.owners) if (this.current(ticket)) notify(mapping);
      }
    }).catch((error) => {
      if (lease.closing) return;
      this.onError(error);
      // Retry before expiry after a lost response. After expiry continue gentle
      // renewal while the peer lives; never close ICE or throttle its packets.
      const remaining = lease.expiresAt - this.now();
      this.schedule(lease, Number.isFinite(remaining) && remaining > 0 ? Math.max(250, remaining / 2) : 5000);
    });
  }

  retire(lease) {
    if (lease.closing) return lease.closing;
    if (lease.timer !== null) this.timers.clearTimeout(lease.timer);
    lease.timer = null;
    lease.closing = Promise.resolve(lease.flight).catch(() => {}).then(async () => {
      // Allocation/renewal may have completed after its peer closed. It still
      // owns a router mapping, and must be released with the original nonce.
      if (lease.value) await lease.value.release(lease.value.mapping);
    }).catch((error) => this.onError(error)).finally(() => {
      if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
    });
    return lease.closing;
  }

  reset() {
    this.peers.clear();
    return Promise.all([...this.leases.values()].map((lease) => {
      lease.owners.clear();
      return this.retire(lease);
    }));
  }

  dispose() { this.disposed = true; return this.reset(); }
}

module.exports = { NatMappingLeases };
