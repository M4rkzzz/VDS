import type { EncodedFrameHeader } from './datachannel-protocol';

type PlayerDiagnostics = {
  onState: (state: string) => void;
  onDecodedFrame: () => void;
  onDroppedFrame: (reason: string) => void;
  onPayloadFormat: (format: string) => void;
  onVideoFrameInfo?: (info: VideoFrameDiagnostics) => void;
};

export type VideoFrameDiagnostics = {
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
};

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
  private waitingForKeyframe = true;
  private expectedDisplayWidth = 0;
  private expectedDisplayHeight = 0;
  private renderedFrameCount = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly diagnostics: PlayerDiagnostics
  ) {}

  async pushFrame(header: EncodedFrameHeader, payload: ArrayBuffer): Promise<void> {
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

    const annexB = header.payloadFormat === 'annexb' || looksLikeAnnexB(payload)
      ? payload
      : convertAvccToAnnexB(payload);
    if (!annexB) {
      this.diagnostics.onDroppedFrame(`webcodecs-${normalizedCodec}-payload-format-unsupported`);
      return;
    }
    this.diagnostics.onPayloadFormat(header.payloadFormat || 'annexb');

    const hevcMinLevel = normalizedCodec === 'h265' ? this.getMinimumHevcLevel() : 0;
    const codec = normalizedCodec === 'h265'
      ? (selectPreferredCodec(buildHevcCodecCandidates(annexB, hevcMinLevel), this.configuredCodec, 'hev1.1.6.L120.B0'))
      : (buildAvcCodecString(annexB) || this.configuredCodec || 'avc1.42E01F');
    if (!this.decoder || this.configuredCodec !== codec) {
      if (!header.keyframe && this.waitingForKeyframe) {
        this.diagnostics.onDroppedFrame('webcodecs-waiting-for-keyframe');
        return;
      }
      const configured = normalizedCodec === 'h265'
        ? await this.configureAny(buildHevcCodecCandidates(annexB, hevcMinLevel), codec, normalizedCodec)
        : await this.configure(codec, normalizedCodec);
      if (!configured) {
        this.diagnostics.onDroppedFrame(`webcodecs-${normalizedCodec}-config-unsupported`);
        return;
      }
    }

    if (this.waitingForKeyframe && !header.keyframe) {
      this.diagnostics.onDroppedFrame('webcodecs-waiting-for-keyframe');
      return;
    }

    try {
      this.decoder?.decode(new window.EncodedVideoChunk({
        type: header.keyframe ? 'key' : 'delta',
        timestamp: Math.max(0, Math.trunc(header.timestampUs || 0)),
        data: annexB
      }));
      this.waitingForKeyframe = false;
    } catch (error) {
      this.waitingForKeyframe = true;
      this.diagnostics.onDroppedFrame(error instanceof Error ? error.message : 'webcodecs-decode-failed');
    }
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
    this.configuredCodec = '';
    this.configuredVideoCodec = '';
    this.waitingForKeyframe = true;
    this.renderedFrameCount = 0;
  }

  setExpectedDisplaySize(width: number, height: number): void {
    this.expectedDisplayWidth = normalizeOptionalDimension(width);
    this.expectedDisplayHeight = normalizeOptionalDimension(height);
  }

  private async configure(codec: string, videoCodec: 'h264' | 'h265'): Promise<boolean> {
    this.decoder?.close();
    this.decoder = new window.VideoDecoder!({
      output: (frame) => this.renderFrame(frame),
      error: (error) => {
        this.waitingForKeyframe = true;
        this.diagnostics.onDroppedFrame(error.message || 'webcodecs-decoder-error');
      }
    });

    const configs = this.buildDecoderConfigs(codec, videoCodec);
    let selectedConfig: Record<string, unknown> | null = null;
    for (const config of configs) {
      if (!window.VideoDecoder?.isConfigSupported) {
        selectedConfig = config;
        break;
      }
      const support = await window.VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (support.supported) {
        selectedConfig = config;
        break;
      }
    }
    if (!selectedConfig) {
      return false;
    }

    this.decoder.configure(selectedConfig);
    this.configuredCodec = codec;
    this.configuredVideoCodec = videoCodec;
    this.diagnostics.onState(`webcodecs-configured-${codec}`);
    return true;
  }

  private async configureAny(
    candidates: string[],
    preferredCodec: string,
    videoCodec: 'h264' | 'h265'
  ): Promise<boolean> {
    const ordered = uniqueStrings([preferredCodec, ...candidates, 'hev1.1.6.L93.B0', 'hvc1.1.6.L93.B0']);
    for (const codec of ordered) {
      const configured = await this.configure(codec, videoCodec);
      if (configured) {
        return true;
      }
    }
    return false;
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
      this.diagnostics.onDecodedFrame();
    } finally {
      frame.close();
    }
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

  private buildDecoderConfigs(codec: string, videoCodec: 'h264' | 'h265'): Record<string, unknown>[] {
    const base: Record<string, unknown> = {
      codec,
      optimizeForLatency: true
    };
    if (videoCodec === 'h264') {
      base.avc = { format: 'annexb' };
    } else {
      base.hevc = { format: 'annexb' };
    }

    const width = this.expectedDisplayWidth;
    const height = this.expectedDisplayHeight;
    if (width <= 0 || height <= 0) {
      return [base];
    }

    return [
      {
        ...base,
        codedWidth: getExpectedCodedDimension(videoCodec, width),
        codedHeight: getExpectedCodedDimension(videoCodec, height),
        displayAspectWidth: width,
        displayAspectHeight: height
      },
      base
    ];
  }
}

export const WebCodecsH264Player = WebCodecsVideoPlayer;

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
    units.push(bytes.slice(offset, offset + size));
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

function buildAvcCodecString(payload: ArrayBuffer): string | null {
  for (const unit of splitAnnexBNalUnits(payload)) {
    if ((unit[0] & 0x1f) !== 7 || unit.length < 4) {
      continue;
    }
    return `avc1.${hex(unit[1])}${hex(unit[2])}${hex(unit[3])}`;
  }
  return null;
}

function buildHevcCodecCandidates(payload: ArrayBuffer, minLevel = 93): string[] {
  for (const unit of splitAnnexBNalUnits(payload)) {
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
    let end = nextStart;
    while (end > start && bytes[end - 1] === 0) {
      end -= 1;
    }
    return bytes.slice(start, end);
  }).filter((unit) => unit.length > 0);
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function normalizeVideoCodec(codec: string): 'h264' | 'h265' | string {
  const normalized = String(codec || '').toLowerCase().replace(/\./g, '');
  if (normalized === 'hevc') {
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
