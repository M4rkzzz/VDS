// One reconnect operation per live viewer session. This owns control-plane
// timers only; it never closes a healthy media connection.
export class SignalingRecovery {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private running = false;

  constructor(private readonly resume: (isCurrent: () => boolean) => Promise<void>) {}

  get active(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    void this.attempt(this.generation);
  }

  disconnected(): void {
    if (!this.running) { this.start(); return; }
    // The replacement socket can also die before its resume acknowledgement.
    // Supersede that attempt now instead of waiting for the ack deadline.
    this.generation++;
    this.retry(this.generation);
  }

  stop(): void {
    this.generation++;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async attempt(generation: number): Promise<void> {
    const isCurrent = () => this.running && generation === this.generation;
    if (!isCurrent()) return;
    this.attempts++;
    try {
      await this.resume(isCurrent);
      if (!isCurrent()) return;
      // A socket open does not mean that the server accepted our session.
      this.timer = setTimeout(() => this.retry(generation), 10000);
    } catch {
      if (isCurrent()) this.retry(generation);
    }
  }

  private retry(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.attempts - 1, 5));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt(generation);
    }, delay);
  }
}
