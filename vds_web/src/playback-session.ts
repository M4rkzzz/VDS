import { EncodedFrameReassembler } from './datachannel-protocol';
import { WebCodecsAudioPlayer } from './webcodecs-audio-player';
import { WebCodecsVideoPlayer } from './webcodecs-player';
import { AdaptivePlaybackDelay, playbackNowMs, SourceEpochGate, VideoSequenceReorder } from './playback-policy';

type PlaybackState = 'stopped' | 'waiting-media' | 'decoding' | 'playing';
type PlaybackCallbacks = {
  video: ConstructorParameters<typeof WebCodecsVideoPlayer>[1];
  audio: ConstructorParameters<typeof WebCodecsAudioPlayer>[0];
  onState: (state: PlaybackState) => void;
  onKeyframeNeeded?: () => void;
  onMetrics?: (metrics: WebPlaybackMetrics) => void;
  onSourceChanged?: (sourceEpoch: string) => void;
};

export type WebPlaybackMetrics = {
  video: ReturnType<WebCodecsVideoPlayer['getMetrics']>;
  audio: ReturnType<WebCodecsAudioPlayer['getMetrics']>;
  reorderDepth: number;
  reorderTargetMs: number;
  sourceEpoch: string | null;
  retiredSourceEpochs: number;
};

export class EncodedMediaPlaybackSession {
  private readonly reassembler = new EncodedFrameReassembler();
  private readonly video: WebCodecsVideoPlayer;
  private readonly audio: WebCodecsAudioPlayer;
  private readonly reorderDelay = new AdaptivePlaybackDelay();
  private readonly videoOrder = new VideoSequenceReorder(this.reorderDelay);
  private readonly sourceEpoch = new SourceEpochGate();
  private videoPumpTimer: number | null = null;
  private lastKeyframeRequestMs = -Infinity;
  private lastMetricsMs = -Infinity;
  private manualAudioDelayMs = 0;
  private active = false;
  private generation = 0;
  private state: PlaybackState = 'stopped';

  constructor(canvas: HTMLCanvasElement, private readonly callbacks: PlaybackCallbacks) {
    this.video = new WebCodecsVideoPlayer(canvas, {
      ...callbacks.video,
      onDecodedFrame: () => {
        if (!this.active) return;
        this.setState('playing');
        callbacks.video.onDecodedFrame();
        this.publishMetrics();
      },
      onKeyframeNeeded: () => this.requestKeyframe()
    });
    this.audio = new WebCodecsAudioPlayer({ ...callbacks.audio,
      onDecodedBlock: () => { callbacks.audio.onDecodedBlock(); this.publishMetrics(); } });
    this.video.setPlaybackClock(() => {
      const clock = this.audio.getPlaybackClock();
      // Manual audio delay must not move video later by the same amount.
      return clock ? { ...clock, ptsUs: clock.ptsUs + this.manualAudioDelayMs * 1000 } : null;
    });
  }

  start(): void {
    if (this.active) this.resetMedia();
    // The join gesture may already have unlocked audio before the first media session.
    this.generation += 1;
    this.reassembler.clear();
    this.sourceEpoch.clear();
    this.active = true;
    this.setState('waiting-media');
  }

  close(): void {
    this.stopMedia(true);
  }

  resetMedia(): void {
    this.stopMedia(false);
  }

  private stopMedia(closeAudio: boolean): void {
    this.active = false;
    this.generation += 1;
    if (this.videoPumpTimer !== null) window.clearTimeout(this.videoPumpTimer);
    this.videoPumpTimer = null;
    this.videoOrder.clear(); this.reorderDelay.reset(); this.lastKeyframeRequestMs = -Infinity;
    this.reassembler.clear();
    this.sourceEpoch.clear();
    this.video.close();
    if (closeAudio) this.audio.close();
    else this.audio.resetMedia();
    this.setState('stopped');
    this.publishMetrics(true);
  }

  acceptMessage(data: unknown): ReturnType<EncodedFrameReassembler['push']> {
    if (!this.active) return null;
    if (!(data instanceof ArrayBuffer)) throw new Error('datachannel-frame-invalid');
    const frame = this.reassembler.push(data);
    if (!frame) return null;
    const epoch = this.sourceEpoch.accept(frame.header.sourceEpoch);
    if (!epoch.accepted) {
      const reason = `web-playback-source-epoch-${epoch.reason}`;
      if (frame.header.streamType === 'video') this.callbacks.video.onDroppedFrame(reason);
      else this.callbacks.audio.onDroppedBlock(reason);
      return null;
    }
    if (epoch.changed) this.resetSource(frame.header.sourceEpoch!);

    // Local decoding is independent of callers forwarding this complete encoded frame.
    const generation = this.generation;
    void Promise.resolve().then(() => {
      if (!this.isCurrent(generation)) return;
      if (this.state !== 'playing') this.setState('decoding');
      if (frame.header.streamType === 'video') {
        const now = playbackNowMs();
        this.reorderDelay.observe(now, frame.header.timestampUs);
        this.videoOrder.push(frame, now);
        this.pumpVideo(generation);
      } else {
        return this.audio.pushFrame(frame.header, frame.payload);
      }
      this.publishMetrics();
    }).catch((error) => {
      if (!this.isCurrent(generation)) return;
      const reason = error instanceof Error ? error.message : 'web-playback-failed';
      if (frame.header.streamType === 'video') this.callbacks.video.onDroppedFrame(reason);
      else this.callbacks.audio.onDroppedBlock(reason);
    });
    return frame;
  }

  resumeAudio(): Promise<void> {
    return this.audio.resume();
  }

  setVolume(value: number): void {
    this.audio.setVolume(value);
  }

  setDelayMs(value: number): void {
    this.manualAudioDelayMs = Math.max(0, Math.min(300, Number.isFinite(value) ? Math.trunc(value) : 0));
    this.audio.setDelayMs(value);
  }

  setAudioFormat(sampleRate: number, channels: number): void {
    this.audio.setFormat(sampleRate, channels);
  }

  setVideoDisplaySize(width: number, height: number, frameRate = 0): void {
    this.video.setExpectedDisplaySize(width, height, frameRate);
  }

  private pumpVideo(generation: number): void {
    if (!this.isCurrent(generation)) return;
    if (this.videoPumpTimer !== null) window.clearTimeout(this.videoPumpTimer);
    this.videoPumpTimer = null;
    const ordered = this.videoOrder.drain(playbackNowMs());
    if (ordered.reset) this.video.close();
    for (let index = 0; index < ordered.dropped; index += 1) this.callbacks.video.onDroppedFrame('web-video-sequence-discontinuity');
    if (ordered.requestKeyframe) this.requestKeyframe();
    for (const frame of ordered.frames) {
      void this.video.pushFrame(frame.header, frame.payload).catch((error) => {
        if (this.isCurrent(generation)) this.callbacks.video.onDroppedFrame(error instanceof Error ? error.message : 'web-playback-failed');
      });
    }
    if (ordered.waitMs !== null) this.videoPumpTimer = window.setTimeout(() => this.pumpVideo(generation), Math.max(1, ordered.waitMs));
    this.publishMetrics();
  }

  private requestKeyframe(): void {
    if (!this.active || playbackNowMs() - this.lastKeyframeRequestMs < 500) return;
    this.lastKeyframeRequestMs = playbackNowMs();
    this.callbacks.onKeyframeNeeded?.();
  }

  private resetSource(sourceEpoch: string): void {
    this.generation += 1;
    if (this.videoPumpTimer !== null) window.clearTimeout(this.videoPumpTimer);
    this.videoPumpTimer = null;
    this.videoOrder.clear(); this.reorderDelay.reset(); this.reassembler.clear();
    this.lastKeyframeRequestMs = -Infinity;
    this.video.close(); this.audio.resetMedia();
    this.setState('waiting-media');
    this.callbacks.onSourceChanged?.(sourceEpoch);
    this.publishMetrics(true);
  }

  private publishMetrics(force = false): void {
    if (!this.callbacks.onMetrics || (!force && playbackNowMs() - this.lastMetricsMs < 250)) return;
    this.lastMetricsMs = playbackNowMs();
    this.callbacks.onMetrics({ video: this.video.getMetrics(), audio: this.audio.getMetrics(),
      reorderDepth: this.videoOrder.size, reorderTargetMs: this.reorderDelay.value,
      sourceEpoch: this.sourceEpoch.current ?? null, retiredSourceEpochs: this.sourceEpoch.retiredCount });
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private setState(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState(state);
  }
}
