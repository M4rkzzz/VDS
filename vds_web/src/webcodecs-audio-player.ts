import type { EncodedFrameHeader } from './datachannel-protocol';
import { AdaptivePlaybackDelay, playbackNowMs } from './playback-policy';

type AudioDiagnostics = {
  onState: (state: string) => void;
  onOutputState?: (state: string) => void;
  onDecodedBlock: () => void;
  onDroppedBlock: (reason: string) => void;
};

type AudioDecoderLike = {
  state: 'unconfigured' | 'configured' | 'closed';
  readonly decodeQueueSize?: number;
  ondequeue?: (() => void) | null;
  configure: (config: AudioDecoderConfig) => void;
  decode: (chunk: EncodedAudioChunk) => void;
  close: () => void;
};

type AudioClockAnchor = {
  ptsUs: number;
  contextTime: number;
  endContextTime: number;
};

type DecoderWaiter = {
  decoder: AudioDecoderLike;
  generation: number;
  resolve: (ready: boolean) => void;
  timeoutId: number | null;
};

type CodecSubmission = { arrivalMs: number; submittedAtMs: number };

type AudioContextConstructor = {
  new(contextOptions?: AudioContextOptions): AudioContext;
};

declare global {
  interface Window {
    AudioDecoder?: {
      new(init: {
        output: (data: AudioData) => void;
        error: (error: Error) => void;
      }): AudioDecoderLike;
      isConfigSupported?: (config: AudioDecoderConfig) => Promise<{ supported: boolean; config?: unknown }>;
    };
    EncodedAudioChunk?: {
      new(init: {
        type: 'key' | 'delta';
        timestamp: number;
        duration?: number;
        data: BufferSource;
      }): EncodedAudioChunk;
    };
    webkitAudioContext?: AudioContextConstructor;
  }
}

export class WebCodecsAudioPlayer {
  private decoder: AudioDecoderLike | null = null;
  private configuredCodec = '';
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private delayMs = 0;
  private volume = 1;
  private nextPlaybackTime = 0;
  private sampleRate = 48000;
  private numberOfChannels = 2;
  private configuredDescriptionKey = '';
  private generation = 0;
  private frameQueue: Promise<void> = Promise.resolve();
  private pendingFrames = 0;
  private readonly decoderWaiters = new Set<DecoderWaiter>();
  private readonly scheduledSources = new Set<AudioBufferSourceNode>();
  private readonly playbackDelay = new AdaptivePlaybackDelay();
  private timelineAnchor: { ptsUs: number; contextTime: number } | null = null;
  private clockAnchors: AudioClockAnchor[] = [];
  private lastEndPtsUs = 0;
  private appliedBufferDelayMs = 20;
  private lastOutputArrivalMs: number | null = null;
  private lastIngressArrivalMs: number | null = null;
  private readonly codecSubmissions = new Map<number, CodecSubmission>();
  private aacOutputAnchor: { ptsUs: number; elapsedUs: number; lastPtsUs: number } | null = null;
  private readonly playoutWaiters = new Set<(ready: boolean) => void>();
  private submissionAnchor: { ptsUs: number; contextTime: number; bufferMs: number } | null = null;
  private lastBlockDurationSeconds = 0;
  private decodedBlocks = 0;
  private droppedBlocks = 0;
  private lastSubmittedPtsUs: number | null = null;
  private lastSubmittedSequence: number | null = null;
  private pendingCodecOutputs = 0;
  private pendingOutputSinceMs = 0;
  private outputWatchdog: number | null = null;

  constructor(private readonly diagnostics: AudioDiagnostics) {}

  pushFrame(header: EncodedFrameHeader, payload: ArrayBuffer): Promise<void> {
    if (header.streamType !== 'audio') {
      return Promise.resolve();
    }
    if (this.pendingFrames >= 24) {
      const ptsUs = header.timestampUs;
      const canCatchUp = this.context?.state === 'running' && this.decoder?.state === 'configured' &&
        this.timelineAnchor !== null && normalizeAudioCodec(header.codec) === this.configuredCodec &&
        this.lastSubmittedPtsUs !== null && Number.isFinite(ptsUs) && ptsUs > this.lastSubmittedPtsUs &&
        this.lastSubmittedSequence !== null && header.sequence > this.lastSubmittedSequence;
      if (!canCatchUp) {
        this.dropBlock('webcodecs-audio-queue-full');
        return Promise.resolve();
      }
      // A source reconnect can flush buffered media faster than the device plays.
      // Keep the fresh input rather than preserving half a second of stale audio.
      const discardedInputs = this.pendingFrames;
      this.resetMedia();
      for (let index = 0; index < discardedInputs; index += 1) this.dropBlock('webcodecs-audio-queue-catchup');
    }
    const generation = this.generation;
    const arrivalMs = playbackNowMs();
    this.pendingFrames += 1;
    const next = this.frameQueue.then(async () => {
      if (generation !== this.generation) {
        return;
      }
      try {
        await this.processFrame(header, payload, generation, arrivalMs);
      } catch (error) {
        if (generation === this.generation) {
          this.dropBlock(error instanceof Error ? error.message : 'webcodecs-audio-decode-failed');
        }
      } finally {
        if (generation === this.generation) {
          this.pendingFrames -= 1;
        }
      }
    });
    this.frameQueue = next;
    return next;
  }

  private async processFrame(header: EncodedFrameHeader, payload: ArrayBuffer, generation: number, arrivalMs: number): Promise<void> {
    if (header.streamType !== 'audio') {
      return;
    }
    if (!window.AudioDecoder || !window.EncodedAudioChunk) {
      this.dropBlock('webcodecs-audio-decoder-unavailable');
      return;
    }

    const codec = normalizeAudioCodec(header.codec);
    if (!codec) {
      this.dropBlock('webcodecs-audio-codec-unsupported');
      return;
    }
    const description = codec === 'mp4a.40.2' ? buildAacAudioSpecificConfig(payload) : undefined;
    const descriptionKey = description ? bytesToHex(description) : '';
    if (!this.decoder || this.decoder.state !== 'configured' || this.configuredCodec !== codec || this.configuredDescriptionKey !== descriptionKey) {
      const configured = await this.configure(codec, description, generation);
      if (generation !== this.generation) {
        return;
      }
      if (!configured) {
        this.dropBlock(`webcodecs-${codec}-config-unsupported`);
        return;
      }
    }

    const decodePayload = codec === 'mp4a.40.2' ? stripAacAdtsHeader(payload) : payload;
    const decoder = this.decoder;
    if (!decoder || !await this.waitForDecoderCapacity(decoder, generation)) {
      return;
    }
    const timestampUs = Math.max(0, Math.trunc(header.timestampUs || 0));
    if ((this.lastSubmittedPtsUs !== null && timestampUs <= this.lastSubmittedPtsUs) ||
      (this.lastSubmittedSequence !== null && header.sequence <= this.lastSubmittedSequence)) {
      this.dropBlock('web-audio-stale-encoded-frame');
      return;
    }
    if (this.codecSubmissions.size >= 12) {
      this.releaseDecoder();
      this.dropBlock('webcodecs-audio-codec-output-backlog');
      return;
    }
    // Measure transport ingress, rather than asynchronous codec output batching.
    if (this.lastIngressArrivalMs === null || arrivalMs - this.lastIngressArrivalMs > 4) {
      this.playbackDelay.observe(arrivalMs, timestampUs);
    }
    this.lastIngressArrivalMs = arrivalMs;
    if (!await this.waitForPlayoutCapacity(timestampUs, codec, decoder, generation)) return;
    try {
      this.codecSubmissions.set(timestampUs, { arrivalMs, submittedAtMs: playbackNowMs() });
      this.refreshPendingOutputs();
      this.armOutputWatchdog(decoder, generation);
      decoder.decode(new window.EncodedAudioChunk({
        type: 'key',
        timestamp: timestampUs,
        data: decodePayload
      }));
      if (generation === this.generation && this.decoder === decoder) {
        this.lastSubmittedPtsUs = timestampUs;
        this.lastSubmittedSequence = header.sequence;
      }
    } catch (error) {
      if (generation === this.generation && this.decoder === decoder) {
        this.codecSubmissions.delete(timestampUs);
        this.refreshPendingOutputs();
        if (!this.pendingCodecOutputs && this.outputWatchdog !== null) {
          window.clearTimeout(this.outputWatchdog);
          this.outputWatchdog = null;
          this.pendingOutputSinceMs = 0;
        }
      }
      this.dropBlock(error instanceof Error ? error.message : 'webcodecs-audio-decode-failed');
    }
  }

  async resume(sampleRate = 48000): Promise<void> {
    const context = this.ensureContext(sampleRate);
    if (['suspended', 'interrupted'].includes(context.state)) {
      await context.resume().catch(() => {});
    }
    if (this.context === context) this.diagnostics.onOutputState?.(context.state);
  }

  resetMedia(): void {
    this.generation += 1;
    this.frameQueue = Promise.resolve();
    this.pendingFrames = 0;
    this.releaseDecoder();
  }

  close(): void {
    this.resetMedia();
    this.gainNode = null;
    if (this.context?.state !== 'closed') {
      void this.context?.close().catch(() => {});
    }
    this.context = null;
    this.decodedBlocks = 0;
    this.droppedBlocks = 0;
  }

  private releaseDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.configuredCodec = '';
    this.configuredDescriptionKey = '';
    this.lastSubmittedPtsUs = null;
    this.lastSubmittedSequence = null;
    this.codecSubmissions.clear();
    this.aacOutputAnchor = null;
    this.lastIngressArrivalMs = null;
    if (this.outputWatchdog !== null) window.clearTimeout(this.outputWatchdog);
    this.outputWatchdog = null;
    this.pendingCodecOutputs = 0;
    this.pendingOutputSinceMs = 0;
    this.resetScheduling();
    for (const waiter of this.decoderWaiters) waiter.resolve(false);
    this.decoderWaiters.clear();
    if (decoder) decoder.ondequeue = null;
    if (decoder && decoder.state !== 'closed') {
      try { decoder.close(); } catch { /* The decoder may close itself on error. */ }
    }
  }

  setDelayMs(value: number): void {
    const normalized = Number.isFinite(value) ? value : 0;
    const delayMs = Math.max(0, Math.min(300, Math.trunc(normalized)));
    if (delayMs !== this.delayMs) {
      this.delayMs = delayMs;
      this.resetScheduling();
    }
  }

  setVolume(value: number): void {
    const normalized = Number.isFinite(value) ? value : 1;
    this.volume = Math.max(0, Math.min(1, normalized));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  setFormat(sampleRate: number, numberOfChannels: number): void {
    const normalizedSampleRate = Number.isFinite(sampleRate) ? Math.trunc(sampleRate) : 48000;
    const normalizedChannels = Number.isFinite(numberOfChannels) ? Math.trunc(numberOfChannels) : 2;
    const nextSampleRate = Math.max(8000, Math.min(192000, normalizedSampleRate));
    const nextChannels = Math.max(1, Math.min(8, normalizedChannels));
    if (nextSampleRate !== this.sampleRate || nextChannels !== this.numberOfChannels) {
      this.sampleRate = nextSampleRate;
      this.numberOfChannels = nextChannels;
      this.resetMedia();
    }
  }

  getPlaybackClock(): { ptsUs: number; performanceMs: number } | null {
    if (this.volume === 0) return null;
    const context = this.context;
    if (!context || context.state !== 'running' || typeof context.getOutputTimestamp !== 'function') return null;
    try {
      const output = context.getOutputTimestamp();
      const contextTime = output.contextTime;
      const performanceMs = output.performanceTime;
      if (typeof contextTime !== 'number' || typeof performanceMs !== 'number' ||
        !Number.isFinite(contextTime) || !Number.isFinite(performanceMs) || contextTime <= 0 || performanceMs <= 0) return null;
      this.clockAnchors = this.clockAnchors.filter((anchor) => anchor.endContextTime >= contextTime - 0.08);
      const anchor = [...this.clockAnchors].reverse().find((candidate) => candidate.contextTime <= contextTime);
      if (!anchor || contextTime > anchor.endContextTime + 0.08) return null;
      return { ptsUs: anchor.ptsUs + (contextTime - anchor.contextTime) * 1000000, performanceMs };
    } catch {
      return null;
    }
  }

  getMetrics(): {
    decoderQueue: number; pendingInputs: number; scheduledSources: number;
    targetBufferMs: number; scheduledLeadMs: number; clockValid: boolean; decoded: number; dropped: number;
    pendingCodecOutputs: number; outputStallMs: number;
    playoutWaiters: number; oldestCodecOutputMs: number; codecOutputSpanMs: number;
  } {
    return {
      decoderQueue: this.decoder?.decodeQueueSize || 0,
      pendingInputs: this.pendingFrames,
      scheduledSources: this.scheduledSources.size,
      targetBufferMs: this.playbackDelay.value,
      scheduledLeadMs: this.context ? Math.max(0, Math.round((this.nextPlaybackTime - this.context.currentTime) * 1000)) : 0,
      clockValid: this.getPlaybackClock() !== null,
      decoded: this.decodedBlocks,
      dropped: this.droppedBlocks,
      pendingCodecOutputs: this.pendingCodecOutputs,
      outputStallMs: this.pendingCodecOutputs ? Math.max(0, playbackNowMs() - this.pendingOutputSinceMs) : 0,
      playoutWaiters: this.playoutWaiters.size,
      oldestCodecOutputMs: this.pendingCodecOutputs ? Math.max(0, playbackNowMs() - this.pendingOutputSinceMs) : 0,
      codecOutputSpanMs: this.codecSubmissions.size > 1
        ? (Math.max(...this.codecSubmissions.keys()) - Math.min(...this.codecSubmissions.keys())) / 1000 : 0
    };
  }

  private dropBlock(reason: string): void {
    this.droppedBlocks += 1;
    this.diagnostics.onDroppedBlock(reason);
  }

  private armOutputWatchdog(decoder: AudioDecoderLike, generation: number): void {
    if (this.outputWatchdog !== null || !this.pendingCodecOutputs) return;
    // Queue size excludes codec-internal work; AAC/Opus may prime before producing output.
    this.outputWatchdog = window.setTimeout(() => {
      if (generation !== this.generation || this.decoder !== decoder) return;
      this.outputWatchdog = null;
      if (!this.pendingCodecOutputs) return;
      this.releaseDecoder();
      this.dropBlock('webcodecs-audio-output-stalled');
    }, Math.max(0, 500 - (playbackNowMs() - this.pendingOutputSinceMs)));
  }

  private refreshPendingOutputs(): void {
    this.pendingCodecOutputs = this.codecSubmissions.size;
    this.pendingOutputSinceMs = this.pendingCodecOutputs
      ? Math.min(...[...this.codecSubmissions.values()].map((submission) => submission.submittedAtMs)) : 0;
  }

  private waitForPlayoutCapacity(ptsUs: number, codec: string, decoder: AudioDecoderLike, generation: number): Promise<boolean> {
    const context = this.ensureContext(this.sampleRate);
    const isCurrent = () => generation === this.generation && this.decoder === decoder && this.context === context;
    if (context.state !== 'running') return Promise.resolve(isCurrent());
    const startedAt = playbackNowMs();
    const duration = this.lastBlockDurationSeconds || (codec === 'mp4a.40.2' ? 1024 / this.sampleRate : 0.02);
    const timeoutMs = Math.max(160, Math.ceil(duration * 1000) + 40);
    return new Promise((resolve) => {
      let timer: number | null = null;
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        this.playoutWaiters.delete(finish);
        resolve(ready && isCurrent());
      };
      const check = () => {
        timer = null;
        if (!isCurrent()) { finish(false); return; }
        if (context.state !== 'running') { finish(true); return; }
        const targetDelay = this.playbackDelay.value;
        this.submissionAnchor ??= { ptsUs, contextTime: context.currentTime + (this.delayMs + targetDelay) / 1000, bufferMs: targetDelay };
        const anchor = this.timelineAnchor || this.submissionAnchor;
        const bufferMs = this.timelineAnchor ? this.appliedBufferDelayMs : this.submissionAnchor.bufferMs;
        const expectedEnd = anchor.contextTime + (ptsUs - anchor.ptsUs) / 1000000 + duration + (targetDelay - bufferMs) / 1000;
        const capacityEnd = context.currentTime + (this.delayMs + targetDelay) / 1000 + Math.max(0.12, duration);
        const waitMs = (expectedEnd - capacityEnd) * 1000;
        if (waitMs <= 0.001) { finish(true); return; }
        if (playbackNowMs() - startedAt >= timeoutMs) {
          finish(false);
          if (isCurrent()) {
            this.releaseDecoder();
            this.dropBlock('webcodecs-audio-playout-backlog');
          }
          return;
        }
        timer = window.setTimeout(check, Math.max(1, Math.min(20, Math.ceil(waitMs), timeoutMs - (playbackNowMs() - startedAt))));
      };
      this.playoutWaiters.add(finish);
      check();
    });
  }

  private waitForDecoderCapacity(decoder: AudioDecoderLike, generation: number): Promise<boolean> {
    const isCurrent = () => generation === this.generation && this.decoder === decoder && decoder.state === 'configured';
    if (!isCurrent()) return Promise.resolve(false);
    if ((decoder.decodeQueueSize || 0) < 8) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter: DecoderWaiter = {
        decoder, generation, timeoutId: null,
        resolve: (ready) => {
          if (waiter.timeoutId !== null) window.clearTimeout(waiter.timeoutId);
          waiter.timeoutId = null;
          this.decoderWaiters.delete(waiter);
          resolve(ready);
        }
      };
      this.decoderWaiters.add(waiter);
      waiter.timeoutId = window.setTimeout(() => {
        if (generation === this.generation && this.decoder === decoder) {
          this.releaseDecoder();
          this.dropBlock('webcodecs-audio-decode-backlog');
        } else {
          waiter.resolve(false);
        }
      }, 160);
      if (!isCurrent() || (decoder.decodeQueueSize || 0) <= 4) {
        waiter.resolve(isCurrent());
      }
    });
  }

  private resetScheduling(resetDelay = true): void {
    for (const finish of [...this.playoutWaiters]) finish(false);
    this.playoutWaiters.clear();
    for (const source of this.scheduledSources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended or never started. */ }
      try { source.disconnect(); } catch { /* Disconnected sources need no further cleanup. */ }
    }
    this.scheduledSources.clear();
    this.clockAnchors = [];
    this.timelineAnchor = null;
    this.submissionAnchor = null;
    this.nextPlaybackTime = 0;
    this.lastEndPtsUs = 0;
    this.lastBlockDurationSeconds = 0;
    if (resetDelay) {
      this.playbackDelay.reset();
      this.lastOutputArrivalMs = null;
    }
    this.appliedBufferDelayMs = this.playbackDelay.value;
  }

  private async configure(codec: string, description: Uint8Array | undefined, generation: number): Promise<boolean> {
    this.releaseDecoder();

    const config: AudioDecoderConfig = {
      codec,
      sampleRate: this.sampleRate,
      numberOfChannels: this.numberOfChannels
    };
    if (description && description.byteLength > 0) {
      config.description = description;
    }
    if (window.AudioDecoder?.isConfigSupported) {
      const support = await window.AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (!support.supported || generation !== this.generation) {
        return false;
      }
    }
    if (generation !== this.generation) {
      return false;
    }

    const decoder = new window.AudioDecoder!({
      output: (data) => {
        if (generation === this.generation && this.decoder === decoder) {
          const key = this.matchCodecOutput(data, codec);
          const submission = key === undefined ? undefined : this.codecSubmissions.get(key);
          if (!submission || key === undefined) {
            data.close();
            this.dropBlock('webcodecs-audio-unmatched-output');
            return;
          }
          this.codecSubmissions.delete(key);
          this.refreshPendingOutputs();
          if (this.outputWatchdog !== null) window.clearTimeout(this.outputWatchdog);
          this.outputWatchdog = null;
          this.armOutputWatchdog(decoder, generation);
          this.playAudioData(data, submission.submittedAtMs, key);
        } else {
          data.close();
        }
      },
      error: (error) => {
        if (generation === this.generation && this.decoder === decoder) {
          this.releaseDecoder();
          this.dropBlock(error.message || 'webcodecs-audio-decoder-error');
        }
      }
    });
    this.decoder = decoder;
    decoder.ondequeue = () => {
      if (generation !== this.generation || this.decoder !== decoder || (decoder.decodeQueueSize || 0) > 4) return;
      for (const waiter of this.decoderWaiters) {
        if (waiter.decoder === decoder && waiter.generation === generation) {
          this.decoderWaiters.delete(waiter);
          waiter.resolve(decoder.state === 'configured');
        }
      }
    };
    try {
      decoder.configure(config);
    } catch {
      this.releaseDecoder();
      return false;
    }
    this.configuredCodec = codec;
    this.configuredDescriptionKey = description ? bytesToHex(description) : '';
    this.diagnostics.onState(`webcodecs-audio-configured-${codec}`);
    return true;
  }

  private matchCodecOutput(data: AudioData, codec: string): number | undefined {
    const ptsUs = data.timestamp;
    if (codec !== 'mp4a.40.2') {
      return this.codecSubmissions.has(ptsUs) ? ptsUs
        : [...this.codecSubmissions.keys()].find((timestamp) => Math.abs(timestamp - ptsUs) <= 2);
    }
    const key = this.codecSubmissions.keys().next().value as number | undefined;
    const durationUs = data.numberOfFrames / data.sampleRate * 1000000;
    if (key === undefined || !Number.isFinite(ptsUs) || !Number.isFinite(durationUs) || durationUs <= 0) return undefined;
    const anchor = this.aacOutputAnchor;
    if (anchor && ptsUs <= anchor.lastPtsUs) return undefined;
    // AAC decoders may continue their sample clock across a missing encoded AU.
    // Pair ordered outputs with source submissions, while validating the codec clock.
    const followsSamples = anchor !== null && Math.abs(ptsUs - (anchor.ptsUs + anchor.elapsedUs)) <= 2;
    const followsSource = Math.abs(ptsUs - key) <= 2;
    if (!followsSamples && !followsSource) return undefined;
    if (!anchor || !followsSamples) this.aacOutputAnchor = { ptsUs, elapsedUs: 0, lastPtsUs: ptsUs };
    this.aacOutputAnchor!.elapsedUs += durationUs;
    this.aacOutputAnchor!.lastPtsUs = ptsUs;
    return key;
  }

  private playAudioData(data: AudioData, submittedAtMs?: number, sourcePtsUs?: number): void {
    try {
      const context = this.ensureContext(data.sampleRate);
      const duration = data.numberOfFrames / data.sampleRate;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('webcodecs-audio-output-invalid');
      if (context.state !== 'running') {
        // Browser policy or a device interruption cannot play these samples.
        // Release earlier reservations and resume from fresh media after a
        // gesture, without copying PCM or asking a blocked source to start.
        this.resetScheduling(false);
        this.dropBlock('web-audio-output-awaiting-gesture');
        return;
      }
      this.lastBlockDurationSeconds = duration;
      const ptsUs = sourcePtsUs ?? (Number.isFinite(data.timestamp) ? Math.max(0, data.timestamp) : this.lastEndPtsUs);
      const nowMs = playbackNowMs();
      const newBurst = this.lastOutputArrivalMs === null || nowMs - this.lastOutputArrivalMs > Math.max(4, duration * 500);
      this.lastOutputArrivalMs = nowMs;
      // During established playback, old codec work must not be replayed after a stall.
      if (this.timelineAnchor && submittedAtMs !== undefined && nowMs - submittedAtMs > 120) {
        this.dropBlock('webcodecs-audio-output-backlog');
        return;
      }
      const targetDelay = this.playbackDelay.value;
      const minimumStartTime = context.currentTime + (this.delayMs + targetDelay) / 1000;
      if (this.timelineAnchor) {
        this.timelineAnchor.contextTime += (targetDelay - this.appliedBufferDelayMs) / 1000;
      } else {
        this.timelineAnchor = { ptsUs, contextTime: minimumStartTime };
      }
      this.appliedBufferDelayMs = targetDelay;
      let expectedStart = this.timelineAnchor.contextTime + (ptsUs - this.timelineAnchor.ptsUs) / 1000000;
      // A burst or a suspended AudioContext must not accumulate seconds of old sound.
      // One complete access unit may exceed the latency target at low sample rates.
      if (expectedStart + duration > minimumStartTime + Math.max(0.12, duration) + 0.000001 || this.scheduledSources.size >= 64) {
        if (context.state === 'running' && this.nextPlaybackTime > context.currentTime + 0.002) {
          // Preserve fresh reservations at the front of an oversized mux burst.
          this.dropBlock('webcodecs-audio-playback-backlog-full');
          return;
        }
        this.resetScheduling(false);
        this.timelineAnchor = { ptsUs, contextTime: minimumStartTime };
        expectedStart = minimumStartTime;
        this.dropBlock('webcodecs-audio-playback-backlog-reset');
      }
      if (expectedStart + duration <= context.currentTime + 0.002) {
        // Re-anchor the first fresh packetization burst after an underrun. Dropping
        // its first two AAC blocks made a normal 100 ms mux batch lose sound.
        if (!newBurst) {
          this.dropBlock('webcodecs-audio-output-late');
          return;
        }
        this.resetScheduling(false);
        this.timelineAnchor = { ptsUs, contextTime: minimumStartTime };
        expectedStart = minimumStartTime;
      }
      const startAt = Math.max(expectedStart, context.currentTime + 0.002, this.nextPlaybackTime);
      const offset = Math.max(0, startAt - expectedStart);
      if (offset >= duration) {
        this.dropBlock('webcodecs-audio-output-overlap');
        return;
      }
      const channelCount = Math.max(1, Math.min(data.numberOfChannels || 2, 2));
      const audioBuffer = context.createBuffer(channelCount, data.numberOfFrames, data.sampleRate);
      for (let channel = 0; channel < channelCount; channel += 1) {
        const target = audioBuffer.getChannelData(channel);
        data.copyTo(target, { planeIndex: channel, format: 'f32-planar' as AudioSampleFormat });
      }
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ensureGainNode(context));
      const endContextTime = startAt + duration - offset;
      this.scheduledSources.add(source);
      source.onended = () => {
        if (this.scheduledSources.delete(source)) {
          source.onended = null;
          try { source.disconnect(); } catch { /* The context may already be closed. */ }
        }
      };
      try {
        source.start(startAt, offset);
      } catch (error) {
        this.scheduledSources.delete(source);
        source.onended = null;
        try { source.disconnect(); } catch { /* Preserve the scheduling error. */ }
        throw error;
      }
      this.clockAnchors.push({ ptsUs: ptsUs + offset * 1000000, contextTime: startAt, endContextTime });
      if (this.clockAnchors.length > 64) this.clockAnchors.splice(0, this.clockAnchors.length - 64);
      this.nextPlaybackTime = endContextTime;
      this.lastEndPtsUs = ptsUs + duration * 1000000;
      this.decodedBlocks += 1;
      this.diagnostics.onDecodedBlock();
    } catch (error) {
      this.dropBlock(error instanceof Error ? error.message : 'webcodecs-audio-output-failed');
    } finally {
      data.close();
    }
  }

  private ensureContext(sampleRate: number): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) {
        throw new Error('web-audio-context-unavailable');
      }
      this.context = new AudioContextCtor({ sampleRate });
      this.gainNode = null;
      const context = this.context;
      context.onstatechange = () => {
        if (this.context === context) this.diagnostics.onOutputState?.(context.state);
      };
      this.diagnostics.onOutputState?.(context.state);
    }
    return this.context;
  }

  private ensureGainNode(context: AudioContext): GainNode {
    if (!this.gainNode) {
      this.gainNode = context.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(context.destination);
    }
    return this.gainNode;
  }
}

function getAudioContextCtor(): AudioContextConstructor | null {
  return window.AudioContext || window.webkitAudioContext || null;
}

function normalizeAudioCodec(codec: string): string {
  const normalized = String(codec || '').toLowerCase().trim();
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (normalized === 'opus') {
    return 'opus';
  }
  if (normalized === 'aac' || compact === 'mp4a402') {
    return 'mp4a.40.2';
  }
  return '';
}

function buildAacAudioSpecificConfig(payload: ArrayBuffer): Uint8Array | undefined {
  const bytes = new Uint8Array(payload);
  if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1] & 0xf0) !== 0xf0) {
    return undefined;
  }
  const profileMinusOne = (bytes[2] >> 6) & 0x03;
  const audioObjectType = profileMinusOne + 1;
  const samplingFrequencyIndex = (bytes[2] >> 2) & 0x0f;
  const channelConfig = ((bytes[2] & 0x01) << 2) | ((bytes[3] >> 6) & 0x03);
  if (audioObjectType <= 0 || audioObjectType > 31 || samplingFrequencyIndex === 0x0f || channelConfig < 0 || channelConfig > 7) {
    return undefined;
  }
  return new Uint8Array([
    (audioObjectType << 3) | (samplingFrequencyIndex >> 1),
    ((samplingFrequencyIndex & 0x01) << 7) | (channelConfig << 3)
  ]);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function stripAacAdtsHeader(payload: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(payload);
  if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1] & 0xf0) !== 0xf0) {
    return payload;
  }
  const protectionAbsent = bytes[1] & 0x01;
  const headerLength = protectionAbsent ? 7 : 9;
  if (bytes.length <= headerLength) {
    return payload;
  }
  return bytes.slice(headerLength).buffer;
}
