// Native ICE may spend 15 s on gathering and then attempt a direct router mapping.
const CONNECT_TIMEOUT_MS = 30000;
const DISCONNECT_GRACE_MS = 3000;

// One recovery request per peer. A replaced peer or a normal leave cancels its timer.
export class UpstreamRecovery {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recover: ((reason: string) => void) | null = null;
  private requested = false;
  private ready = false;
  private states = new Map<string, string>();
  private timerReason = '';
  private terminalReason = '';

  start(recover: (reason: string) => void): void {
    this.stop();
    this.recover = recover;
    this.requested = false;
    this.ready = false;
    this.arm(CONNECT_TIMEOUT_MS, 'upstream-connect-timeout');
  }

  stateChanged(state: string, layer: 'connection' | 'ice' | 'datachannel' = 'connection'): void {
    if (!this.recover || this.requested) return;
    this.states.set(layer, state);
    if (state === 'failed' || state === 'closed') {
      this.terminalReason ||= `upstream-${state}`;
    }
    // A healthy ICE notification cannot revive closed SCTP/DTLS, and decoded
    // frames already queued for display cannot prove a disconnected path works.
    if (this.terminalReason) {
      this.arm(0, this.terminalReason);
    } else if (this.pathInterrupted()) {
      this.arm(DISCONNECT_GRACE_MS, 'upstream-disconnected');
    } else if (state === 'connected' || state === 'completed') {
      if (this.ready) this.clearTimer();
      else this.arm(CONNECT_TIMEOUT_MS, 'upstream-media-handshake-timeout');
    }
  }

  mediaReady(): void {
    if (!this.recover || this.requested) return;
    this.ready = true;
    if (!this.terminalReason && !this.pathInterrupted()) this.clearTimer();
  }

  stop(): void {
    this.generation += 1;
    this.clearTimer();
    this.recover = null;
    this.states.clear();
    this.terminalReason = '';
  }

  private pathInterrupted(): boolean {
    return [...this.states.values()].some(state => state === 'disconnected' ||
      (this.ready && (state === 'checking' || state === 'connecting')));
  }

  private arm(delayMs: number, reason: string): void {
    // Repeated notifications do not extend the deadline of the same outage.
    if (this.timer !== null && this.timerReason === reason) return;
    this.clearTimer();
    this.timerReason = reason;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation || !this.recover || this.requested) return;
      this.requested = true;
      this.recover(reason);
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerReason = '';
  }
}
