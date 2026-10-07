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

  start(recover: (reason: string) => void): void {
    this.stop();
    this.recover = recover;
    this.requested = false;
    this.ready = false;
    this.arm(CONNECT_TIMEOUT_MS, 'upstream-connect-timeout');
  }

  stateChanged(state: string): void {
    if (!this.recover || this.requested) return;
    if (state === 'failed' || state === 'closed') {
      this.arm(0, `upstream-${state}`);
    } else if (state === 'disconnected') {
      this.arm(DISCONNECT_GRACE_MS, 'upstream-disconnected');
    } else if (state === 'connected' || state === 'completed') {
      this.clearTimer();
      if (!this.ready) this.arm(CONNECT_TIMEOUT_MS, 'upstream-media-handshake-timeout');
    }
  }

  mediaReady(): void {
    if (!this.recover || this.requested) return;
    this.ready = true;
    this.clearTimer();
  }

  stop(): void {
    this.generation += 1;
    this.clearTimer();
    this.recover = null;
  }

  private arm(delayMs: number, reason: string): void {
    this.clearTimer();
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
  }
}
