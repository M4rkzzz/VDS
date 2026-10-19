// Wake the native RPC owner after an accepted host keyframe request. Peer
// identity comes from createPeer replies, never from a stats RPC that mutates it.
class HostVideoRefreshWakeup {
  constructor({ invokeStats, isRunning, onError = () => {}, timers = globalThis }) {
    this.invokeStats = invokeStats;
    this.isRunning = isRunning;
    this.onError = onError;
    this.timers = timers;
    this.peers = new Map();
    this.pending = new Map();
    this.timer = null;
    this.flight = null;
    this.disposed = false;
  }

  beginCreate(params = {}) {
    const peerId = this.identifier(params.peerId);
    if (!peerId || this.disposed) return null;
    this.forget(peerId);
    if (params.role !== 'host-downstream') return null;
    const ticket = { peerId, generation: null, lastSequence: 0, lastFailedProducer: 0, closedGenerations: new Set() };
    this.peers.set(peerId, ticket);
    return ticket;
  }

  completeCreate(ticket, result = {}) {
    if (!ticket || this.disposed || this.peers.get(ticket.peerId) !== ticket) return false;
    const generation = this.identifier(result.transportGeneration);
    if (result.peerId !== ticket.peerId || !generation || ticket.closedGenerations.has(generation)) {
      this.failCreate(ticket);
      return false;
    }
    ticket.generation = generation;
    ticket.closedGenerations.clear();
    if (ticket.pendingFailure) {
      const pending = ticket.pendingFailure;
      delete ticket.pendingFailure;
      this.handleEvent(pending);
    }
    return true;
  }

  failCreate(ticket) {
    if (ticket && this.peers.get(ticket.peerId) === ticket) this.forget(ticket.peerId);
  }

  closePeer(params = {}) {
    const peerId = this.identifier(params.peerId);
    const entry = this.peers.get(peerId);
    if (!entry) return false;
    const generation = this.identifier(params.transportGeneration);
    if (Object.prototype.hasOwnProperty.call(params, 'transportGeneration') && !generation) return false;
    if (generation && entry.generation && generation !== entry.generation) return false;
    if (generation && !entry.generation) {
      // A close event can precede its create reply. Remember only that exact
      // generation, so a late close for an older transport cannot close a new one.
      entry.closedGenerations.add(generation);
      return true;
    }
    this.forget(peerId);
    return true;
  }

  handleEvent(event = {}) {
    const params = event.params || {};
    if (event.event === 'peer-state' && params.state === 'closed') {
      if (!this.identifier(params.transportGeneration)) return false;
      return this.closePeer(params);
    }
    const producerFailed = event.event === 'host-video-producer-failed';
    if ((!producerFailed && event.event !== 'host-video-refresh-requested') || this.disposed || !this.isRunning()) return false;
    const peerId = this.identifier(params.peerId);
    const entry = this.peers.get(peerId);
    const sequence = producerFailed ? params.producerId : params.requestSequence;
    const sequenceField = producerFailed ? 'lastFailedProducer' : 'lastSequence';
    if (producerFailed && entry && !entry.generation && this.identifier(params.transportGeneration) &&
        !entry.closedGenerations.has(params.transportGeneration) && Number.isSafeInteger(sequence) && sequence > 0) {
      // FFmpeg can exit before createPeer's reply. Replay only after the reply
      // authenticates this transport generation, without losing the one-shot wake.
      entry.pendingFailure = event;
      return false;
    }
    if (!entry || !entry.generation || entry.generation !== params.transportGeneration ||
        !Number.isSafeInteger(sequence) || sequence <= entry[sequenceField] || sequence < 1) return false;
    entry[sequenceField] = sequence;
    this.pending.set(peerId, entry);
    this.schedule();
    return true;
  }

  handleAgentStatus(status = {}) {
    // A cold create can be waiting for the startup ping. It has no transport
    // identity yet, and must survive that startup transition until its reply.
    if (status.running || status.state === 'starting') return;
    this.reset();
  }

  schedule() {
    if (this.disposed || this.timer !== null || this.flight || this.pending.size === 0) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
  }

  flush() {
    if (this.disposed || this.flight || this.pending.size === 0) return;
    if (!this.isRunning()) {
      this.reset();
      return;
    }
    const current = [...this.pending].some(([peerId, entry]) => this.peers.get(peerId) === entry && entry.generation);
    this.pending.clear();
    if (!current) return;
    const flight = {};
    this.flight = flight;
    // No await between the live-process guard and invocation: invokeStats must
    // synchronously call the existing manager, whose invoke auto-starts otherwise.
    let request;
    try {
      request = this.invokeStats();
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then((stats) => {
      if (this.flight !== flight || this.disposed || !this.isRunning()) return;
      for (const peer of stats?.peers || []) {
        const entry = this.peers.get(peer.peerId);
        if (entry && peer.mediaBinding?.recoveryPending &&
            peer.peerTransport?.transportGeneration === entry.generation) this.pending.set(peer.peerId, entry);
      }
    }).catch((error) => {
      if (this.flight === flight && !this.disposed) this.onError(error);
    }).finally(() => {
      if (this.flight !== flight) return;
      this.flight = null;
      this.schedule();
    });
  }

  forget(peerId) {
    this.peers.delete(peerId);
    this.pending.delete(peerId);
    if (this.pending.size === 0 && this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  cancelPending() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  reset() {
    this.cancelPending();
    this.flight = null;
    this.peers.clear();
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }

  identifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
  }
}

module.exports = { HostVideoRefreshWakeup };
