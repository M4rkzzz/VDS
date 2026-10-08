import type { EncodedFrameHeader } from './datachannel-protocol';
import { AdaptivePlaybackDelay, playbackNowMs, type MediaPlaybackClock } from './playback-policy';

type PlayerDiagnostics = {
  onState: (state: string) => void;
  onDecodedFrame: () => void;
  onDroppedFrame: (reason: string) => void;
  onPayloadFormat: (format: string) => void;
  onVideoFrameInfo?: (info: VideoFrameDiagnostics) => void;
  onKeyframeNeeded?: () => void;
};

type VideoFrameDiagnostics = {
  codec: string;
  configuredCodec: string;
  canvasWidth: number;
  canvasHeight: number;
  displayWidth: number;
  displayHeight: number;
  codedWidth: number;
  codedHeight: number;
  visibleX: number;
  visibleY: number;
  visibleWidth: number;
  visibleHeight: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
};

type VideoDecoderLike = {
  state: 'unconfigured' | 'configured' | 'closed';
  configure: (config: Record<string, unknown>) => void;
  decode: (chunk: EncodedVideoChunk) => void;
  close: () => void;
  readonly decodeQueueSize?: number;
  ondequeue?: (() => void) | null;
};

type WebCodecsPayloadFormat = 'annexb' | 'avcc';

declare global {
  interface Window {
    VideoDecoder?: {
      new(init: {
        output: (frame: VideoFrame) => void;
        error: (error: Error) => void;
      }): VideoDecoderLike;
      isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported: boolean; config?: unknown }>;
    };
    EncodedVideoChunk?: {
      new(init: {
        type: 'key' | 'delta';
        timestamp: number;
        duration?: number;
        data: BufferSource;
      }): EncodedVideoChunk;
    };
  }
}

export class WebCodecsVideoPlayer {
  private decoder: VideoDecoderLike | null = null;
  private configuredCodec = '';
  private configuredVideoCodec: 'h264' | 'h265' | '' = '';
  private configuredPayloadFormat: WebCodecsPayloadFormat = 'annexb';
  private waitingForKeyframe = true;
  private expectedDisplayWidth = 0;
  private expectedDisplayHeight = 0;
  private expectedFrameRate = 0;
  private renderedFrameCount = 0;
  private generation = 0;
  private frameQueue: Promise<void> = Promise.resolve();
  private pendingFrames = 0;
  private capacityWaiters = new Set<(ready: boolean) => void>();
  private presentationWaiters = new Set<(ready: boolean) => void>();
  private outputFrames: Array<{ frame: VideoFrame; ptsUs: number; bytes: number }> = [];
  private outputBytes = 0;
  private animationFrame: number | null = null;
  private clock: (() => MediaPlaybackClock | null) | null = null;
  private presentationAnchor: MediaPlaybackClock | null = null;
  private readonly bufferDelay = new AdaptivePlaybackDelay();
  private configurationPrefix: ArrayBuffer | null = null;
  private configurationUnits = new Map<number, Uint8Array>();
  private configurationCodec: 'h264' | 'h265' | '' = '';
  private lastSubmittedPtsUs = 0;
  private latestSourcePtsUs: number | null = null;
  private decodedTotal = 0;
  private presentedTotal = 0;
  private presentationDrops = 0;
  private presentationOverflowDrops = 0;
  private presentationLateDrops = 0;
  private backwardsOutputCount = 0;
  private lastOutputAtMs = 0;
  private lastPresentationPtsUs = 0;
  private pendingCodecOutputs = 0;
  private pendingCodecWork: Array<{ ptsUs: number; submittedAtMs: number; watchedAtMs: number }> = [];
  private outputWatchdog: number | null = null;
  private reorderWaitStartedAtMs: number | null = null;
  private pendingOutputSinceMs = 0;
  private presentationCapacity = 2;
  private decoderReordersPts = false;
  private decoderHasOutput = false;
  private reorderDistanceUs = 0;
  private lastOutputBytes = 0;
  private lastOutputPtsUs: number | null = null;
  private framePeriodMs = 1000 / 60;
  private latePresentations = 0;
  private fallbackReanchors = 0;
  private schedulerLateness: number[] = [];

  setPlaybackClock(clock: () => MediaPlaybackClock | null): void { this.clock = clock; }

  getMetrics() {
    const clock = this.clock?.();
    const lateness = [...this.schedulerLateness].sort((a, b) => a - b);
    return { decoderQueue: this.decoder?.decodeQueueSize || 0, pendingInputs: this.pendingFrames,
      presentationQueue: this.outputFrames.length, presentationBytes: this.outputBytes,
      inputQueueCapacity: this.inputQueueCapacity(),
      sourceClockLeadMs: this.sourceClockLeadMs(),
      presentationCapacity: this.presentationCapacity,
      decoderReordersPts: this.decoderReordersPts,
      codecReorderAllowance: this.codecReorderAllowance(),
      pendingCodecOutputs: this.pendingCodecOutputs,
      decoded: this.decodedTotal, presented: this.presentedTotal, presentationDrops: this.presentationDrops,
      presentationOverflowDrops: this.presentationOverflowDrops, presentationLateDrops: this.presentationLateDrops,
      backwardsOutputCount: this.backwardsOutputCount,
      lastSubmittedPtsUs: this.lastSubmittedPtsUs, lastDecodedPtsUs: this.lastOutputPtsUs,
      presentationHeadPtsUs: this.outputFrames[0]?.ptsUs ?? null,
      presentationTailPtsUs: this.outputFrames.at(-1)?.ptsUs ?? null, audioClockPtsUs: clock?.ptsUs ?? null,
      targetBufferMs: this.bufferDelay.value, audioClockValid: Boolean(clock),
      effectiveBufferMs: clock ? null : this.bufferDelay.value, fallbackReanchors: this.fallbackReanchors,
      schedulerLatenessP95Ms: lateness.length ? lateness[Math.ceil(lateness.length * 0.95) - 1] : 0,
      maxSchedulerLatenessMs: lateness.at(-1) ?? 0,
      codecPresentationWait: this.reorderWaitStartedAtMs !== null,
      oldestCodecOutputMs: this.pendingCodecOutputs ? Math.max(0, playbackNowMs() - this.pendingOutputSinceMs) : 0,
      outputStallMs: this.pendingCodecWork.length ? Math.max(0, playbackNowMs() - this.pendingCodecWork[0].watchedAtMs -
        (this.reorderWaitStartedAtMs === null ? 0 : playbackNowMs() - this.reorderWaitStartedAtMs)) : 0,
      syncEstimateMs: clock && this.presentedTotal ? (this.lastPresentationPtsUs - clock.ptsUs) / 1000 : null };
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly diagnostics: PlayerDiagnostics
  ) {}

  pushFrame(header: EncodedFrameHeader, payload: ArrayBuffer): Promise<void> {
    if (header.streamType !== 'video') {
      return Promise.resolve();
    }
    // Decoder bursts are not network jitter samples.
    this.bufferDelay.observe(playbackNowMs(), header.timestampUs);
    this.latestSourcePtsUs = Math.max(this.latestSourcePtsUs ?? header.timestampUs, header.timestampUs);
    if (this.pendingFrames >= this.inputQueueCapacity()) {
      // Cancel the queued reference chain and recover at the next keyframe.
      this.close();
      this.diagnostics.onDroppedFrame('webcodecs-video-queue-full');
      this.diagnostics.onKeyframeNeeded?.();
      if (!header.keyframe) {
        return Promise.resolve();
      }
      this.latestSourcePtsUs = header.timestampUs;
    }
    const generation = this.generation;
    this.pendingFrames += 1;
    const next = this.frameQueue.then(async () => {
      if (generation !== this.generation) {
        return;
      }
      try {
        await this.processFrame(header, payload, generation);
      } catch (error) {
        if (generation === this.generation) {
          this.waitingForKeyframe = true;
          this.diagnostics.onDroppedFrame(error instanceof Error ? error.message : 'webcodecs-decode-failed');
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

  private async processFrame(header: EncodedFrameHeader, payload: ArrayBuffer, generation: number): Promise<void> {
    if (header.streamType !== 'video') {
      return;
    }
    const normalizedCodec = normalizeVideoCodec(header.codec);
    if (normalizedCodec !== 'h264' && normalizedCodec !== 'h265') {
      this.diagnostics.onDroppedFrame('webcodecs-video-codec-unsupported');
      return;
    }
    if (!window.VideoDecoder || !window.EncodedVideoChunk) {
      this.diagnostics.onDroppedFrame('webcodecs-video-decoder-unavailable');
      return;
    }

    let annexB = header.payloadFormat === 'annexb' || looksLikeAnnexB(payload)
      ? payload
      : convertAvccToAnnexB(payload);
    if (!annexB) {
      this.diagnostics.onDroppedFrame(`webcodecs-${normalizedCodec}-payload-format-unsupported`);
      return;
    }
    let units = splitAnnexBNalUnits(annexB);
    if (this.configurationCodec !== normalizedCodec) {
      if (this.configurationCodec) this.releaseDecoder();
      this.configurationUnits.clear(); this.configurationPrefix = null;
      this.configurationCodec = normalizedCodec;
    }
    const configuration = units.filter((unit) => normalizedCodec === 'h264'
      ? [7, 8].includes(unit[0] & 0x1f) : [32, 33, 34].includes((unit[0] >> 1) & 0x3f));
    if (configuration.length) {
      const nextConfiguration = new Map(this.configurationUnits);
      for (const unit of configuration) nextConfiguration.set(normalizedCodec === 'h264' ? unit[0] & 0x1f : (unit[0] >> 1) & 0x3f, unit);
      const prefixBytes = [...nextConfiguration.values()].reduce((sum, unit) => sum + 4 + unit.byteLength, 0);
      if (prefixBytes <= 64 * 1024) {
        // NAL views borrow the current frame. Persist only these small copies,
        // so cached SPS/PPS/VPS neither retain nor alias an entire encoded AU.
        for (const unit of configuration) nextConfiguration.set(normalizedCodec === 'h264' ? unit[0] & 0x1f : (unit[0] >> 1) & 0x3f, unit.slice());
        this.configurationUnits = nextConfiguration;
        this.configurationPrefix = packAnnexBUnits([...nextConfiguration.values()]);
      } else { this.configurationUnits.clear(); this.configurationPrefix = null; }
    }
    const hasVcl = units.some((unit) => normalizedCodec === 'h264'
      ? (unit[0] & 0x1f) >= 1 && (unit[0] & 0x1f) <= 5 : ((unit[0] >> 1) & 0x3f) <= 31);
    if (!hasVcl) return; // A configuration message still consumed its transport sequence.
    const presentConfigurationTypes = new Set(configuration.map((unit) => normalizedCodec === 'h264' ? unit[0] & 0x1f : (unit[0] >> 1) & 0x3f));
    if (header.keyframe && this.configurationPrefix && presentConfigurationTypes.size < this.configurationUnits.size) {
      const missingUnits = [...this.configurationUnits].filter(([type]) => !presentConfigurationTypes.has(type)).map(([, unit]) => unit);
      const missingPrefix = packAnnexBUnits(missingUnits);
      const prefixed = new Uint8Array(missingPrefix.byteLength + annexB.byteLength);
      prefixed.set(new Uint8Array(missingPrefix));
      prefixed.set(new Uint8Array(annexB), missingPrefix.byteLength);
      annexB = prefixed.buffer;
      units = [...missingUnits, ...units];
    }

    const hevcMinLevel = normalizedCodec === 'h265' ? this.getMinimumHevcLevel() : 0;
    const hevcCandidates = normalizedCodec === 'h265' ? buildHevcCodecCandidates(units, hevcMinLevel) : [];
    const codec = normalizedCodec === 'h265'
      ? (selectPreferredCodec(hevcCandidates, this.configuredCodec, 'hev1.1.6.L120.B0'))
      : (buildAvcCodecString(units) || this.configuredCodec || 'avc1.42E01F');
    if (!this.decoder || this.decoder.state !== 'configured' || this.configuredCodec !== codec) {
      if (!header.keyframe && this.waitingForKeyframe) {
        this.diagnostics.onDroppedFrame('webcodecs-waiting-for-keyframe');
        return;
      }
      // Length-prefixed availability depends only on the parsed NAL list.
      // Allocate that representation only if the selected decoder needs it.
      const configuredFormat = normalizedCodec === 'h265'
        ? await this.configureAny(hevcCandidates, codec, normalizedCodec, units.length > 0, generation)
        : await this.configure(codec, normalizedCodec, units.length > 0, generation);
      if (generation !== this.generation) {
        return;
      }
      if (!configuredFormat) {
        this.diagnostics.onDroppedFrame(`webcodecs-${normalizedCodec}-config-unsupported`);
        return;
      }
    }

    if (this.waitingForKeyframe && !header.keyframe) {
      this.diagnostics.onDroppedFrame('webcodecs-waiting-for-keyframe');
      return;
    }

    if (!header.keyframe && header.timestampUs < this.lastSubmittedPtsUs) {
      this.decoderReordersPts = true;
      this.reorderDistanceUs = Math.max(this.reorderDistanceUs, this.lastSubmittedPtsUs - header.timestampUs);
      this.updatePresentationCapacity(this.lastOutputBytes);
    }

    const decoder = this.decoder;
    if (!decoder || !await this.waitForDecoderCapacity(generation)) return;
    if (generation !== this.generation || this.decoder !== decoder || decoder.state !== 'configured' ||
      !await this.waitForPresentationCapacity(generation, header.keyframe && this.decoderHasOutput && this.decoderReordersPts)) return;
    if (generation !== this.generation || this.decoder !== decoder || decoder.state !== 'configured') return;
    // Empty ready queues must permit B-frame priming, but a codec that returns only
    // a fraction of its work cannot accumulate an unbounded internal reference chain.
    if (this.pendingCodecWork.length >= Math.max(16, this.presentationCapacity + this.codecReorderAllowance())) {
      this.close(); this.diagnostics.onDroppedFrame('webcodecs-video-output-backlog');
      this.diagnostics.onKeyframeNeeded?.(); return;
    }
    try {
      const decodePayload = this.configuredPayloadFormat === 'avcc' ? convertAnnexBToLengthPrefixed(units) : annexB;
      if (!decodePayload) {
        this.diagnostics.onDroppedFrame(`webcodecs-${normalizedCodec}-${this.configuredPayloadFormat}-payload-unavailable`);
        return;
      }
      this.diagnostics.onPayloadFormat(`${header.payloadFormat || 'annexb'}:${this.configuredPayloadFormat}`);
      this.lastSubmittedPtsUs = Math.max(0, Math.trunc(header.timestampUs || 0));
      const submittedAtMs = playbackNowMs();
      this.pendingCodecWork.push({ ptsUs: this.lastSubmittedPtsUs, submittedAtMs, watchedAtMs: submittedAtMs });
      this.pendingCodecOutputs = this.pendingCodecWork.length;
      this.pendingOutputSinceMs = this.pendingCodecWork[0].submittedAtMs;
      this.armOutputWatchdog();
      decoder.decode(new window.EncodedVideoChunk({
        type: header.keyframe ? 'key' : 'delta',
        timestamp: Math.max(0, Math.trunc(header.timestampUs || 0)),
        data: decodePayload
      }));
      this.waitingForKeyframe = false;
    } catch (error) {
      this.releaseDecoder();
      this.diagnostics.onDroppedFrame(error instanceof Error ? error.message : 'webcodecs-decode-failed');
      this.diagnostics.onKeyframeNeeded?.();
    }
  }

  close(): void {
    this.generation += 1;
    this.frameQueue = Promise.resolve();
    this.pendingFrames = 0;
    for (const finish of [...this.presentationWaiters]) finish(false);
    this.presentationWaiters.clear();
    for (const finish of this.capacityWaiters) finish(false);
    this.capacityWaiters.clear();
    if (this.animationFrame !== null) window.cancelAnimationFrame?.(this.animationFrame);
    this.animationFrame = null;
    for (const output of this.outputFrames) output.frame.close();
    this.outputFrames = []; this.outputBytes = 0;
    this.presentationCapacity = 2; this.decoderReordersPts = false; this.lastOutputBytes = 0;
    this.latestSourcePtsUs = null;
    this.reorderDistanceUs = 0;
    this.lastOutputPtsUs = null; this.framePeriodMs = 1000 / (this.expectedFrameRate || 60);
    this.latePresentations = 0; this.fallbackReanchors = 0; this.schedulerLateness = [];
    this.presentationAnchor = null; this.configurationPrefix = null; this.configurationUnits.clear(); this.configurationCodec = ''; this.bufferDelay.reset();
    this.releaseDecoder();
    this.renderedFrameCount = 0;
  }

  private releaseDecoder(): void {
    for (const finish of [...this.presentationWaiters]) finish(false);
    this.presentationWaiters.clear();
    for (const finish of [...this.capacityWaiters]) finish(false);
    this.capacityWaiters.clear();
    if (this.outputWatchdog !== null) window.clearTimeout(this.outputWatchdog);
    this.outputWatchdog = null; this.pendingCodecOutputs = 0; this.pendingCodecWork = [];
    this.decoderHasOutput = false;
    this.reorderWaitStartedAtMs = null;
    const decoder = this.decoder;
    this.decoder = null;
    this.configuredCodec = '';
    this.configuredVideoCodec = '';
    this.configuredPayloadFormat = 'annexb';
    this.waitingForKeyframe = true;
    if (decoder && decoder.state !== 'closed') {
      decoder.ondequeue = null;
      decoder.close();
    }
  }

  setExpectedDisplaySize(width: number, height: number, frameRate = 0): void {
    this.expectedDisplayWidth = normalizeOptionalDimension(width);
    this.expectedDisplayHeight = normalizeOptionalDimension(height);
    this.expectedFrameRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 0;
    if (this.expectedFrameRate) this.framePeriodMs = 1000 / this.expectedFrameRate;
  }

  private async configure(codec: string, videoCodec: 'h264' | 'h265', hasAvccPayload: boolean, generation: number): Promise<WebCodecsPayloadFormat | null> {
    this.releaseDecoder();
    const configs = this.buildDecoderConfigs(codec, videoCodec, hasAvccPayload);
    let selectedConfig: Record<string, unknown> | null = null;
    let selectedPayloadFormat: WebCodecsPayloadFormat | null = null;
    for (const config of configs) {
      const candidateConfig = { ...config };
      const candidatePayloadFormat = candidateConfig.__vdsPayloadFormat as WebCodecsPayloadFormat;
      delete candidateConfig.__vdsPayloadFormat;
      if (!window.VideoDecoder?.isConfigSupported) {
        selectedConfig = candidateConfig;
        selectedPayloadFormat = candidatePayloadFormat;
        break;
      }
      const support = await window.VideoDecoder.isConfigSupported(candidateConfig).catch(() => ({ supported: false }));
      if (generation !== this.generation) {
        return null;
      }
      if (support.supported) {
        selectedConfig = candidateConfig;
        selectedPayloadFormat = candidatePayloadFormat;
        break;
      }
    }
    if (!selectedConfig || !selectedPayloadFormat || generation !== this.generation) {
      return null;
    }

    const decoder = new window.VideoDecoder!({
      output: (frame) => {
        if (generation === this.generation && this.decoder === decoder) {
          this.queueOutput(frame);
        } else {
          frame.close();
        }
      },
      error: (error) => {
        if (generation === this.generation && this.decoder === decoder) {
          this.releaseDecoder();
          this.diagnostics.onDroppedFrame(error.message || 'webcodecs-decoder-error');
          this.diagnostics.onKeyframeNeeded?.();
        }
      }
    });
    this.decoder = decoder;
    decoder.ondequeue = () => {
      if (generation !== this.generation || this.decoder !== decoder) return;
      if ((decoder.decodeQueueSize || 0) <= 2) for (const finish of [...this.capacityWaiters]) finish(true);
    };
    try {
      decoder.configure(selectedConfig);
    } catch {
      this.releaseDecoder();
      return null;
    }
    this.configuredCodec = codec;
    this.configuredVideoCodec = videoCodec;
    this.configuredPayloadFormat = selectedPayloadFormat;
    this.diagnostics.onState(`webcodecs-configured-${codec}-${selectedPayloadFormat}`);
    return selectedPayloadFormat;
  }

  private async configureAny(
    candidates: string[],
    preferredCodec: string,
    videoCodec: 'h264' | 'h265',
    hasAvccPayload: boolean,
    generation: number
  ): Promise<WebCodecsPayloadFormat | null> {
    const ordered = uniqueStrings([preferredCodec, ...candidates, 'hev1.1.6.L93.B0', 'hvc1.1.6.L93.B0']);
    for (const codec of ordered) {
      if (generation !== this.generation) {
        return null;
      }
      const configured = await this.configure(codec, videoCodec, hasAvccPayload, generation);
      if (configured) {
        return configured;
      }
    }
    return null;
  }

  private renderFrame(frame: VideoFrame): void {
    try {
      const frameLike = frame as VideoFrame & {
        codedWidth?: number;
        codedHeight?: number;
        visibleRect?: { x?: number; y?: number; width?: number; height?: number };
      };
      const frameSizing = getVideoFrameSizing(frameLike, this.expectedDisplayWidth, this.expectedDisplayHeight);
      const targetWidth = frameSizing.targetWidth;
      const targetHeight = frameSizing.targetHeight;
      if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
        this.canvas.width = targetWidth;
        this.canvas.height = targetHeight;
      }
      const context = this.canvas.getContext('2d');
      if (context) {
        const source = getVideoFrameSourceRect(
          frameLike,
          targetWidth,
          targetHeight,
          frameSizing.hasExpectedDisplaySize
        );
        this.maybeReportFrameInfo(frameLike, source);
        context.drawImage(
          frame,
          source.x,
          source.y,
          source.width,
          source.height,
          0,
          0,
          this.canvas.width,
          this.canvas.height
        );
      }
      this.presentedTotal += 1;
      this.lastPresentationPtsUs = Number.isFinite(frame.timestamp) ? frame.timestamp : this.lastSubmittedPtsUs;
      this.diagnostics.onDecodedFrame();
    } catch {
      this.presentationDrops += 1;
      this.diagnostics.onDroppedFrame('web-video-presentation-failed');
    } finally {
      frame.close();
    }
  }

  private waitForDecoderCapacity(generation: number): Promise<boolean> {
    if ((this.decoder?.decodeQueueSize || 0) < 4) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true; window.clearTimeout(timer); this.capacityWaiters.delete(finish);
        resolve(ready && generation === this.generation);
      };
      const timer = window.setTimeout(() => {
        finish(false);
        if (generation === this.generation) {
          this.close(); this.diagnostics.onDroppedFrame('webcodecs-video-decode-backlog');
          this.diagnostics.onKeyframeNeeded?.();
        }
      }, 160);
      this.capacityWaiters.add(finish);
    });
  }

  private queueOutput(frame: VideoFrame): void {
    const now = playbackNowMs();
    const ptsUs = Number.isFinite(frame.timestamp) ? frame.timestamp : this.lastSubmittedPtsUs;
    this.decodedTotal += 1; this.lastOutputAtMs = now;
    this.decoderHasOutput = true;
    const workIndex = this.pendingCodecWork.findIndex((work) => work.ptsUs === ptsUs);
    // B pictures are emitted in presentation order, unlike their submissions.
    // A codec without a matching output timestamp still consumes its oldest work.
    if (this.pendingCodecWork.length) this.pendingCodecWork.splice(Math.max(0, workIndex), 1);
    this.pendingCodecOutputs = this.pendingCodecWork.length;
    this.pendingOutputSinceMs = this.pendingCodecWork[0]?.submittedAtMs ?? now;
    if (this.outputWatchdog !== null) window.clearTimeout(this.outputWatchdog);
    this.outputWatchdog = null;
    this.armOutputWatchdog();
    if (this.lastOutputPtsUs !== null) {
      const interval = (ptsUs - this.lastOutputPtsUs) / 1000;
      if (interval < 0) this.backwardsOutputCount += 1;
      if (!this.expectedFrameRate && interval >= 1 && interval <= 200) this.framePeriodMs = this.framePeriodMs * 0.8 + interval * 0.2;
    }
    this.lastOutputPtsUs = ptsUs;
    if (typeof window.requestAnimationFrame !== 'function') { this.renderFrame(frame); return; }
    const bytes = Math.max(1, frame.codedWidth || frame.displayWidth) * Math.max(1, frame.codedHeight || frame.displayHeight) * 4;
    this.lastOutputBytes = bytes; this.updatePresentationCapacity(bytes);
    // The estimate limits queue depth; a decoder-supported resolution can always own one frame.
    const byteBudget = Math.max(32 * 1024 * 1024, bytes);
    while (this.outputFrames.length >= this.presentationCapacity || this.outputBytes + bytes > byteBudget) {
      if (this.outputFrames.length === 1) {
        frame.close(); this.presentationDrops += 1; this.presentationOverflowDrops += 1;
        this.diagnostics.onDroppedFrame('web-video-presentation-superseded'); return;
      }
      // Codec-internal bursts can outrun input backpressure: keep the next deadline and newest output.
      this.discardOutput(this.outputFrames.length - 1, 'overflow');
    }
    this.outputFrames.push({ frame, ptsUs, bytes }); this.outputBytes += bytes;
    this.presentationAnchor ??= { ptsUs, performanceMs: now };
    this.schedulePresentation();
    this.presentationFreed();
  }

  private armOutputWatchdog(): void {
    const now = playbackNowMs();
    if (this.isRetainedReorderWaiting()) {
      // These pictures require another reference AU; we deliberately stop
      // submitting it while ready pictures wait for their audio deadline.
      this.reorderWaitStartedAtMs ??= now;
      if (this.outputWatchdog !== null) window.clearTimeout(this.outputWatchdog);
      this.outputWatchdog = null;
      return;
    }
    if (this.reorderWaitStartedAtMs !== null) {
      const waitMs = now - this.reorderWaitStartedAtMs;
      for (const work of this.pendingCodecWork) work.watchedAtMs += waitMs;
      this.reorderWaitStartedAtMs = null;
    }
    if (this.outputWatchdog !== null || !this.pendingCodecOutputs) return;
    const generation = this.generation;
    const decoder = this.decoder;
    // Queue size excludes codec-internal work; allow B-frame priming before declaring a stall.
    this.outputWatchdog = window.setTimeout(() => {
      this.outputWatchdog = null;
      if (generation !== this.generation || decoder !== this.decoder || !this.pendingCodecOutputs) return;
      if (this.isRetainedReorderWaiting()) { this.armOutputWatchdog(); return; }
      this.close(); this.diagnostics.onDroppedFrame('webcodecs-video-output-stalled');
      this.diagnostics.onKeyframeNeeded?.();
    }, Math.max(0, 500 - (now - this.pendingCodecWork[0].watchedAtMs)));
  }

  private isRetainedReorderWaiting(): boolean {
    return this.decoderReordersPts && this.decoderHasOutput && this.pendingCodecOutputs > 0 &&
      this.pendingCodecOutputs <= this.codecReorderAllowance() && (this.decoder?.decodeQueueSize || 0) === 0 &&
      this.outputFrames.length > 0 && this.presentationWaiters.size > 0;
  }

  private discardOutput(index = 0, reason: 'overflow' | 'late' = 'late'): void {
    const [output] = this.outputFrames.splice(index, 1);
    if (!output) return;
    this.outputBytes -= output.bytes; output.frame.close(); this.presentationDrops += 1;
    if (reason === 'overflow') this.presentationOverflowDrops += 1;
    else this.presentationLateDrops += 1;
    this.diagnostics.onDroppedFrame('web-video-presentation-superseded');
  }

  private dueAt(ptsUs: number, now: number): number {
    const clock = this.clock?.();
    if (clock && Math.abs(ptsUs - clock.ptsUs) < 1000000) return clock.performanceMs + (ptsUs - clock.ptsUs) / 1000;
    const anchor = this.presentationAnchor!;
    let due = anchor.performanceMs + (ptsUs - anchor.ptsUs) / 1000 + this.bufferDelay.value;
    if (due > now + 1000 || due < now - 1000) {
      this.presentationAnchor = { ptsUs, performanceMs: now }; due = now + this.bufferDelay.value;
    }
    return due;
  }

  private async waitForPresentationCapacity(generation: number, flushReorder = false): Promise<boolean> {
    // An IDR releases old reorder pictures. Its reservation must include those
    // pictures, while ordinary input still leaves room to prime the codec.
    while (!this.hasPresentationCapacity(flushReorder)) {
      const ready = await new Promise<boolean>((resolve) => {
        const finish = (ready: boolean) => {
          this.presentationWaiters.delete(finish);
          resolve(ready && generation === this.generation);
        };
        this.presentationWaiters.add(finish);
        this.armOutputWatchdog();
      });
      if (!ready) return false;
    }
    return generation === this.generation;
  }

  private presentationFreed(): void {
    if (this.hasPresentationCapacity()) for (const finish of [...this.presentationWaiters]) finish(true);
    this.armOutputWatchdog();
  }

  private updatePresentationCapacity(bytes: number): void {
    const limit = this.decoderReordersPts ? 3 : 2;
    this.presentationCapacity = bytes > 0 ? Math.min(limit, Math.max(1, Math.floor((32 * 1024 * 1024) / bytes))) : limit;
  }

  private hasPresentationCapacity(flushReorder = false): boolean {
    // An IDR releases the codec's retained reorder pictures. A single large-frame
    // slot cannot reserve all of them, so drain ready pictures before allowing
    // that flush instead of waiting for pictures only the IDR can release.
    if (flushReorder && this.outputFrames.length === 0 && this.pendingCodecOutputs <= this.codecReorderAllowance()) return true;
    // Reserve future ready pictures while retaining the codec's reorder work.
    // Counting all pending pictures blocks B-frame priming; ignoring them lets an
    // asynchronous mux batch overflow the ready queue before its next RAF.
    return this.outputFrames.length + Math.max(0, this.pendingCodecOutputs - (flushReorder ? 0 : this.codecReorderAllowance())) < this.presentationCapacity;
  }

  private codecReorderAllowance(): number {
    if (!this.decoderReordersPts) return this.decoderHasOutput ? 0 : 2;
    return Math.max(1, Math.min(16, Math.round(this.reorderDistanceUs / (this.framePeriodMs * 1000))));
  }

  private inputQueueCapacity(): number {
    // A normal MPEG-TS PES can deliver about 235 ms together while a previous
    // batch waits for the actual audio device. Reserve encoded work for both;
    // the decoded picture budget stays unchanged.
    const frameRate = this.expectedFrameRate || 1000 / this.framePeriodMs;
    return Math.max(12, Math.ceil(frameRate * (250 + this.sourceClockLeadMs()) / 1000) + 2);
  }

  private sourceClockLeadMs(): number {
    const clock = this.clock?.();
    if (!clock || this.latestSourcePtsUs === null || !Number.isFinite(clock.ptsUs) || !Number.isFinite(clock.performanceMs)) return 0;
    const leadMs = (this.latestSourcePtsUs - clock.ptsUs) / 1000 - (playbackNowMs() - clock.performanceMs);
    // Use the same clock domain as dueAt; discontinuities already fall back to
    // the monotonic presentation anchor instead of reserving against old audio.
    return leadMs > 0 && leadMs < 1000 ? leadMs : 0;
  }

  private schedulePresentation(): void {
    if (this.animationFrame !== null || !this.outputFrames.length) return;
    const generation = this.generation;
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = null;
      if (generation !== this.generation || !this.outputFrames.length) return;
      const now = playbackNowMs();
      while (this.outputFrames.length > 1 && this.dueAt(this.outputFrames[1].ptsUs, now) <= now) this.discardOutput();
      let deadline = this.dueAt(this.outputFrames[0].ptsUs, now);
      if (!this.clock?.() && now - deadline > Math.max(80, this.framePeriodMs * 3)) {
        if (++this.latePresentations >= 4) {
          this.presentationAnchor = { ptsUs: this.outputFrames[0].ptsUs, performanceMs: now };
          this.latePresentations = 0; this.fallbackReanchors += 1;
          deadline = this.dueAt(this.outputFrames[0].ptsUs, now);
        }
      } else this.latePresentations = 0;
      if (deadline <= now + 2) {
        const output = this.outputFrames.shift()!; this.outputBytes -= output.bytes;
        this.schedulerLateness.push(Math.max(0, now - deadline));
        if (this.schedulerLateness.length > 128) this.schedulerLateness.shift();
        this.renderFrame(output.frame);
      }
      this.presentationFreed();
      this.schedulePresentation();
    });
  }

  private maybeReportFrameInfo(
    frame: VideoFrame & {
      codedWidth?: number;
      codedHeight?: number;
      visibleRect?: { x?: number; y?: number; width?: number; height?: number };
    },
    source: { x: number; y: number; width: number; height: number }
  ): void {
    this.renderedFrameCount += 1;
    if (this.renderedFrameCount !== 1 && this.renderedFrameCount % 60 !== 0) {
      return;
    }
    const codedWidth = normalizePositiveDimension(Number(frame.codedWidth || frame.displayWidth));
    const codedHeight = normalizePositiveDimension(Number(frame.codedHeight || frame.displayHeight));
    const visible = frame.visibleRect;
    this.diagnostics.onVideoFrameInfo?.({
      codec: this.configuredVideoCodec,
      configuredCodec: this.configuredCodec,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      displayWidth: normalizePositiveDimension(Number(frame.displayWidth)),
      displayHeight: normalizePositiveDimension(Number(frame.displayHeight)),
      codedWidth,
      codedHeight,
      visibleX: Math.max(0, Math.round(Number(visible?.x || 0))),
      visibleY: Math.max(0, Math.round(Number(visible?.y || 0))),
      visibleWidth: normalizePositiveDimension(Number(visible?.width || frame.displayWidth)),
      visibleHeight: normalizePositiveDimension(Number(visible?.height || frame.displayHeight)),
      sourceX: source.x,
      sourceY: source.y,
      sourceWidth: source.width,
      sourceHeight: source.height
    });
  }

  private getMinimumHevcLevel(): number {
    const width = this.expectedDisplayWidth;
    const height = this.expectedDisplayHeight;
    if (width >= 3840 || height >= 2160) {
      return 153;
    }
    if (width >= 2560 || height >= 1440) {
      return 150;
    }
    if (width >= 1920 || height >= 1080) {
      return 123;
    }
    if (width >= 1280 || height >= 720) {
      return 120;
    }
    return 93;
  }

  private buildDecoderConfigs(codec: string, videoCodec: 'h264' | 'h265', hasAvccPayload: boolean): Record<string, unknown>[] {
    const formats: WebCodecsPayloadFormat[] = hasAvccPayload ? ['annexb', 'avcc'] : ['annexb'];
    const bases = formats.map((format) => {
      const base: Record<string, unknown> = {
        codec,
        optimizeForLatency: true,
        __vdsPayloadFormat: format
      };
      if (videoCodec === 'h264') {
        base.avc = { format: format === 'avcc' ? 'avc' : 'annexb' };
      } else {
        base.hevc = { format: format === 'avcc' ? 'hevc' : 'annexb' };
      }
      return base;
    });

    const width = this.expectedDisplayWidth;
    const height = this.expectedDisplayHeight;
    if (width <= 0 || height <= 0) {
      return bases;
    }

    return bases.flatMap((base) => [
      {
        ...base,
        codedWidth: getExpectedCodedDimension(videoCodec, width),
        codedHeight: getExpectedCodedDimension(videoCodec, height),
        displayAspectWidth: width,
        displayAspectHeight: height
      },
      base
    ]);
  }
}


function packAnnexBUnits(units: Uint8Array[]): ArrayBuffer {
  const bytes = new Uint8Array(units.reduce((sum, unit) => sum + 4 + unit.byteLength, 0));
  let offset = 0;
  for (const unit of units) {
    bytes.set([0, 0, 0, 1], offset); offset += 4;
    bytes.set(unit, offset); offset += unit.byteLength;
  }
  return bytes.buffer;
}

function looksLikeAnnexB(payload: ArrayBuffer): boolean {
  const bytes = new Uint8Array(payload);
  return bytes.length >= 4 && (
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1)
  );
}

function convertAvccToAnnexB(payload: ArrayBuffer): ArrayBuffer | null {
  const bytes = new Uint8Array(payload);
  const units: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const size =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];
    offset += 4;
    if (size <= 0 || offset + size > bytes.length) {
      return null;
    }
    units.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== bytes.length || units.length === 0) {
    return null;
  }

  const startCode = new Uint8Array([0, 0, 0, 1]);
  const output = new Uint8Array(units.reduce((sum, unit) => sum + startCode.length + unit.length, 0));
  let writeOffset = 0;
  for (const unit of units) {
    output.set(startCode, writeOffset);
    writeOffset += startCode.length;
    output.set(unit, writeOffset);
    writeOffset += unit.length;
  }
  return output.buffer;
}

function convertAnnexBToLengthPrefixed(units: Uint8Array[]): ArrayBuffer | null {
  if (units.length === 0) {
    return null;
  }
  const output = new Uint8Array(units.reduce((sum, unit) => sum + 4 + unit.length, 0));
  let offset = 0;
  for (const unit of units) {
    const size = unit.length;
    output[offset] = (size >>> 24) & 0xff;
    output[offset + 1] = (size >>> 16) & 0xff;
    output[offset + 2] = (size >>> 8) & 0xff;
    output[offset + 3] = size & 0xff;
    offset += 4;
    output.set(unit, offset);
    offset += unit.length;
  }
  return output.buffer;
}

function buildAvcCodecString(units: Uint8Array[]): string | null {
  for (const unit of units) {
    if ((unit[0] & 0x1f) !== 7 || unit.length < 4) {
      continue;
    }
    return `avc1.${hex(unit[1])}${hex(unit[2])}${hex(unit[3])}`;
  }
  return null;
}

function buildHevcCodecCandidates(units: Uint8Array[], minLevel = 93): string[] {
  for (const unit of units) {
    const nalType = (unit[0] >> 1) & 0x3f;
    if (nalType === 33 && unit.length >= 7) {
      const level = Math.max(clampHevcLevel(unit[6]), minLevel);
      return [
        `hev1.1.6.L${level}.B0`,
        `hvc1.1.6.L${level}.B0`,
        `hev1.1.6.L${minLevel}.B0`,
        `hvc1.1.6.L${minLevel}.B0`,
        'hev1.1.6.L123.B0',
        'hvc1.1.6.L123.B0',
        'hev1.1.6.L120.B0',
        'hvc1.1.6.L120.B0',
        'hev1.1.6.L93.B0',
        'hvc1.1.6.L93.B0'
      ];
    }
  }
  return [
    `hev1.1.6.L${minLevel}.B0`,
    `hvc1.1.6.L${minLevel}.B0`,
    'hev1.1.6.L123.B0',
    'hvc1.1.6.L123.B0',
    'hev1.1.6.L120.B0',
    'hvc1.1.6.L120.B0',
    'hev1.1.6.L93.B0',
    'hvc1.1.6.L93.B0'
  ];
}

function splitAnnexBNalUnits(payload: ArrayBuffer): Uint8Array[] {
  const bytes = new Uint8Array(payload);
  const starts: number[] = [];
  for (let index = 0; index < bytes.length - 3; index += 1) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      starts.push(index + 3);
      index += 2;
    } else if (
      index < bytes.length - 4 &&
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 &&
      bytes[index + 3] === 1
    ) {
      starts.push(index + 4);
      index += 3;
    }
  }

  return starts.map((start, index) => {
    const nextStart = starts[index + 1] || bytes.length;
    // Exclude the next start code; trimming also removes a four-byte prefix's extra zero.
    let end = index + 1 < starts.length ? nextStart - 3 : nextStart;
    while (end > start && bytes[end - 1] === 0) {
      end -= 1;
    }
    return bytes.subarray(start, end);
  }).filter((unit) => unit.length > 0);
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function normalizeVideoCodec(codec: string): 'h264' | 'h265' | string {
  const raw = String(codec || '').toLowerCase().trim();
  const normalized = raw.replace(/[^a-z0-9]/g, '');
  if (raw.startsWith('avc1') || raw.startsWith('avc3') || normalized.startsWith('avc1') || normalized.startsWith('avc3')) {
    return 'h264';
  }
  if (raw.startsWith('hvc1') || raw.startsWith('hev1') || normalized.startsWith('hvc1') || normalized.startsWith('hev1') || normalized === 'hevc') {
    return 'h265';
  }
  return normalized;
}

function selectPreferredCodec(candidates: string[], configuredCodec: string, fallback: string): string {
  return candidates[0] || configuredCodec || fallback;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function clampHevcLevel(value: number): number {
  const level = Number.isFinite(value) ? Math.round(value) : 93;
  if (level < 30 || level > 186) {
    return 93;
  }
  return level;
}

function normalizePositiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : 1;
}

function normalizeOptionalDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : 0;
}

function getExpectedCodedDimension(videoCodec: 'h264' | 'h265', displayDimension: number): number {
  const dimension = normalizePositiveDimension(displayDimension);
  const alignment = videoCodec === 'h265' ? 16 : 2;
  return Math.ceil(dimension / alignment) * alignment;
}

function getVideoFrameSizing(
  frame: VideoFrame & {
    codedWidth?: number;
    codedHeight?: number;
  },
  expectedDisplayWidth: number,
  expectedDisplayHeight: number
): { targetWidth: number; targetHeight: number; hasExpectedDisplaySize: boolean } {
  const frameDisplayWidth = normalizePositiveDimension(Number(frame.displayWidth));
  const frameDisplayHeight = normalizePositiveDimension(Number(frame.displayHeight));
  const codedWidth = normalizePositiveDimension(Number(frame.codedWidth || frame.displayWidth));
  const codedHeight = normalizePositiveDimension(Number(frame.codedHeight || frame.displayHeight));
  if (expectedDisplayWidth <= 0 || expectedDisplayHeight <= 0) {
    return {
      targetWidth: frameDisplayWidth,
      targetHeight: frameDisplayHeight,
      hasExpectedDisplaySize: false
    };
  }

  if (codedWidth < expectedDisplayWidth * 0.9 || codedHeight < expectedDisplayHeight * 0.9) {
    return {
      targetWidth: frameDisplayWidth,
      targetHeight: frameDisplayHeight,
      hasExpectedDisplaySize: false
    };
  }

  return {
    targetWidth: expectedDisplayWidth,
    targetHeight: expectedDisplayHeight,
    hasExpectedDisplaySize: true
  };
}

function getVideoFrameSourceRect(
  frame: VideoFrame & {
    codedWidth?: number;
    codedHeight?: number;
    visibleRect?: { x?: number; y?: number; width?: number; height?: number };
  },
  targetWidth: number,
  targetHeight: number,
  hasExpectedDisplaySize: boolean
): { x: number; y: number; width: number; height: number } {
  const codedWidth = normalizePositiveDimension(Number(frame.codedWidth || frame.displayWidth));
  const codedHeight = normalizePositiveDimension(Number(frame.codedHeight || frame.displayHeight));
  const visible = frame.visibleRect;
  const visibleWidth = normalizePositiveDimension(Number(visible?.width || frame.displayWidth));
  const visibleHeight = normalizePositiveDimension(Number(visible?.height || frame.displayHeight));
  const targetAspect = targetWidth / Math.max(1, targetHeight);
  const visibleAspect = visibleWidth / Math.max(1, visibleHeight);
  const codedAspect = codedWidth / Math.max(1, codedHeight);

  if (
    hasExpectedDisplaySize &&
    codedWidth >= targetWidth * 0.95 &&
    codedHeight >= targetHeight * 0.95 &&
    (visibleWidth < codedWidth * 0.9 || visibleHeight < codedHeight * 0.9)
  ) {
    return { x: 0, y: 0, width: codedWidth, height: codedHeight };
  }

  if (Math.abs(codedAspect - targetAspect) < Math.abs(visibleAspect - targetAspect) - 0.02) {
    return { x: 0, y: 0, width: codedWidth, height: codedHeight };
  }

  return {
    x: Math.max(0, Math.round(Number(visible?.x || 0))),
    y: Math.max(0, Math.round(Number(visible?.y || 0))),
    width: visibleWidth,
    height: visibleHeight
  };
}
