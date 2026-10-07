import type { EncodedFrameHeader } from './datachannel-protocol';

export type MediaPlaybackClock = { ptsUs: number; performanceMs: number };
export type OrderedMediaFrame = { header: EncodedFrameHeader; payload: ArrayBuffer };

export function playbackNowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export class SourceEpochGate {
  private observed = false;
  private epoch: string | undefined;
  private readonly retired = new Set<string>();

  get current(): string | undefined { return this.epoch; }
  get retiredCount(): number { return this.retired.size; }

  clear(): void { this.observed = false; this.epoch = undefined; this.retired.clear(); }

  accept(epoch?: string): { accepted: boolean; changed: boolean; reason?: string } {
    if (epoch !== undefined && (typeof epoch !== 'string' || epoch.length < 1 || epoch.length > 128)) {
      return { accepted: false, changed: false, reason: 'invalid' };
    }
    if (!this.observed) {
      this.observed = true; this.epoch = epoch;
      return { accepted: true, changed: false };
    }
    if (epoch === this.epoch) return { accepted: true, changed: false };
    if (epoch === undefined) return { accepted: false, changed: false, reason: 'legacy-after-epoch' };
    if (this.retired.has(epoch)) return { accepted: false, changed: false, reason: 'retired' };
    if (this.epoch !== undefined) this.retired.add(this.epoch);
    this.epoch = epoch;
    return { accepted: true, changed: true };
  }
}

export class AdaptivePlaybackDelay {
  private targetMs = 20;
  private lastArrivalMs: number | null = null;
  private lastPtsUs: number | null = null;
  private stableSinceMs: number | null = null;

  get value(): number { return this.targetMs; }

  reset(): void {
    this.targetMs = 20;
    this.lastArrivalMs = null;
    this.lastPtsUs = null;
    this.stableSinceMs = null;
  }

  observe(arrivalMs: number, ptsUs: number): number {
    if (this.lastArrivalMs !== null && this.lastPtsUs !== null) {
      const sourceDeltaMs = (ptsUs - this.lastPtsUs) / 1000;
      const arrivalDeltaMs = arrivalMs - this.lastArrivalMs;
      // B-frame PTS and clock discontinuities are not network jitter samples.
      if (sourceDeltaMs > 0 && sourceDeltaMs < 1000 && arrivalDeltaMs >= 0 && arrivalDeltaMs < 1000) {
        if (arrivalDeltaMs - sourceDeltaMs > 10) {
          this.targetMs = Math.min(60, this.targetMs + 10);
          this.stableSinceMs = arrivalMs;
        } else {
          this.stableSinceMs ??= arrivalMs;
          if (arrivalMs - this.stableSinceMs >= 5000) {
            this.targetMs = Math.max(20, this.targetMs - 5);
            this.stableSinceMs = arrivalMs;
          }
        }
      }
    }
    this.lastArrivalMs = arrivalMs;
    this.lastPtsUs = ptsUs;
    return this.targetMs;
  }
}

export class VideoSequenceReorder {
  private pending = new Map<number, OrderedMediaFrame>();
  private expected: number | null = null;
  private delivered = -1;
  private gapSinceMs: number | null = null;
  private needsReset = false;
  private needsKeyframe = false;
  private dropped = 0;

  constructor(private readonly delay: AdaptivePlaybackDelay, private readonly limit = 12) {}

  get size(): number { return this.pending.size; }

  clear(): void {
    this.pending.clear(); this.expected = null; this.delivered = -1;
    this.gapSinceMs = null; this.needsReset = false; this.needsKeyframe = false; this.dropped = 0;
  }

  push(frame: OrderedMediaFrame, nowMs: number): void {
    const sequence = frame.header.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence <= this.delivered || this.pending.has(sequence)) {
      this.dropped += 1;
      return;
    }
    this.pending.set(sequence, frame);
    if (this.expected === null && frame.header.keyframe) this.restartAt(sequence);
    if (this.pending.size > this.limit) {
      const keyframe = this.nextKeyframe();
      if (keyframe !== undefined) this.restartAt(keyframe);
      else this.abandon();
      if (this.pending.size > this.limit) this.abandon();
    }
    this.gapSinceMs ??= nowMs;
  }

  drain(nowMs: number): { frames: OrderedMediaFrame[]; reset: boolean; requestKeyframe: boolean; dropped: number; waitMs: number | null } {
    const frames: OrderedMediaFrame[] = [];
    if (this.pending.size && this.gapSinceMs !== null && nowMs - this.gapSinceMs >= this.delay.value &&
      (this.expected === null || !this.pending.has(this.expected))) {
      const keyframe = this.nextKeyframe();
      if (keyframe !== undefined) this.restartAt(keyframe);
      else this.abandon();
    }
    while (this.expected !== null && this.pending.has(this.expected)) {
      const sequence = this.expected;
      frames.push(this.pending.get(sequence)!);
      this.pending.delete(sequence); this.delivered = sequence; this.expected = sequence + 1;
      this.gapSinceMs = null;
    }
    if (this.pending.size) this.gapSinceMs ??= nowMs;
    else this.gapSinceMs = null;
    const result = { frames, reset: this.needsReset, requestKeyframe: this.needsKeyframe,
      dropped: this.dropped, waitMs: this.gapSinceMs === null ? null : Math.max(0, this.delay.value - (nowMs - this.gapSinceMs)) };
    this.needsReset = false; this.needsKeyframe = false; this.dropped = 0;
    return result;
  }

  private nextKeyframe(): number | undefined {
    return [...this.pending].filter(([sequence, frame]) => sequence > this.delivered && frame.header.keyframe)
      .map(([sequence]) => sequence).sort((a, b) => a - b)[0];
  }

  private restartAt(keyframe: number): void {
    let beginning = keyframe;
    // Config messages consume sequence numbers too; the player inspects their NAL units.
    while (this.pending.get(beginning - 1)?.header.config) beginning -= 1;
    for (const sequence of this.pending.keys()) if (sequence < beginning) { this.pending.delete(sequence); this.dropped += 1; }
    this.expected = beginning; this.needsReset = true; this.gapSinceMs = null;
  }

  private abandon(): void {
    this.dropped += Math.max(1, this.pending.size); this.pending.clear(); this.expected = null;
    this.gapSinceMs = null; this.needsReset = true; this.needsKeyframe = true;
  }
}
