import { encodeFrameMessages } from './datachannel-protocol';

type FrameHeader = Parameters<typeof encodeFrameMessages>[0];
type Channel = Pick<RTCDataChannel, 'readyState' | 'bufferedAmount' | 'send'>;
const QUEUE_BYTES = 8 * 1024 * 1024;
const AUDIO_RESERVE_BYTES = 256 * 1024;
export const RELAY_BUFFERED_LOW_BYTES = 2 * 1024 * 1024;

// Admission is for a complete access unit. The queue budget is not a bitrate or
// frame-size limit: an empty queue admits any valid frame, including a large IDR.
export class EncodedRelaySender {
  private waitingForFreshKeyframe = false;
  private lastRequestMs = -Infinity;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(readonly channel: Channel, private readonly requestKeyframe: () => void,
    private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.generation++;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.waitingForFreshKeyframe = false;
    this.lastRequestMs = -Infinity;
  }

  onBufferedLow(): void {
    if (!this.waitingForFreshKeyframe) return;
    if (this.channel.readyState !== 'open') { this.reset(); return; }
    if (this.channel.bufferedAmount <= RELAY_BUFFERED_LOW_BYTES && this.now() - this.lastRequestMs >= 2000) {
      const generation = this.generation;
      this.lastRequestMs = this.now();
      // Control delivery is best effort. A failed/lost request must not depend
      // on another video packet or bufferedamountlow edge to make progress.
      try { this.requestKeyframe(); } catch {
        if (generation === this.generation) this.lastRequestMs = -Infinity;
      }
    }
    this.scheduleRecoveryRetry();
  }

  private scheduleRecoveryRetry(): void {
    if (!this.waitingForFreshKeyframe || this.retryTimer !== null) return;
    const generation = this.generation;
    // A drain callback can send between timer ticks. Keep its next retry on the
    // request deadline instead of rounding it up to another full polling period.
    const remaining = 2000 - (this.now() - this.lastRequestMs);
    this.retryTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.retryTimer = null;
      this.onBufferedLow();
    }, remaining > 0 ? remaining : 2000);
  }

  send(header: FrameHeader, payload: ArrayBuffer, bootstrap = false): boolean {
    if (this.channel.readyState !== 'open') return false;
    const video = header.streamType === 'video';
    if (video && this.waitingForFreshKeyframe && (!header.keyframe || bootstrap)) {
      this.onBufferedLow();
      return false;
    }
    const messages = encodeFrameMessages(header, payload);
    const bytes = messages.reduce((total, message) => total + message.byteLength, 0);
    const budget = Math.max(QUEUE_BYTES, bytes) + (video ? 0 : AUDIO_RESERVE_BYTES);
    if (this.channel.bufferedAmount + bytes > budget) {
      if (video) this.waitingForFreshKeyframe = true;
      this.onBufferedLow();
      return false;
    }
    try {
      // JavaScript callbacks cannot interleave this loop. Rechecking the queue
      // between chunks would abandon an already admitted frame halfway through.
      for (const message of messages) this.channel.send(message);
    } catch (error) {
      if (video) this.waitingForFreshKeyframe = true;
      this.onBufferedLow();
      // RTCDataChannel may still reject a send because its native queue filled.
      // Recover at a fresh keyframe instead of declaring the protocol unsupported.
      if (error instanceof Error && error.name === 'OperationError') return false;
      throw error;
    }
    if (video && header.keyframe) this.reset();
    return true;
  }
}
