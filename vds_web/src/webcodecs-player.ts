import type { EncodedFrameHeader } from './datachannel-protocol';

type PlayerDiagnostics = {
  onState: (state: string) => void;
  onDecodedFrame: () => void;
  onDroppedFrame: (reason: string) => void;
  onPayloadFormat: (format: string) => void;
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
  private waitingForKeyframe = true;

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

    const codec = normalizedCodec === 'h265'
      ? (buildHevcCodecString(annexB) || this.configuredCodec || 'hev1.1.6.L93.B0')
      : (buildAvcCodecString(annexB) || this.configuredCodec || 'avc1.42E01F');
    if (!this.decoder || this.configuredCodec !== codec) {
      if (!header.keyframe && this.waitingForKeyframe) {
        this.diagnostics.onDroppedFrame('webcodecs-waiting-for-keyframe');
        return;
      }
      const configured = await this.configure(codec, normalizedCodec);
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
    this.waitingForKeyframe = true;
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

    const config: Record<string, unknown> = {
      codec,
      optimizeForLatency: true
    };
    if (videoCodec === 'h264') {
      config.avc = { format: 'annexb' };
    } else {
      config.hevc = { format: 'annexb' };
    }
    if (window.VideoDecoder?.isConfigSupported) {
      const support = await window.VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (!support.supported) {
        return false;
      }
    }

    this.decoder.configure(config);
    this.configuredCodec = codec;
    this.diagnostics.onState(`webcodecs-configured-${codec}`);
    return true;
  }

  private renderFrame(frame: VideoFrame): void {
    try {
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = Math.max(1, frame.displayWidth);
        this.canvas.height = Math.max(1, frame.displayHeight);
      }
      const context = this.canvas.getContext('2d');
      if (context) {
        context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      }
      this.diagnostics.onDecodedFrame();
    } finally {
      frame.close();
    }
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

function buildHevcCodecString(payload: ArrayBuffer): string | null {
  for (const unit of splitAnnexBNalUnits(payload)) {
    const nalType = (unit[0] >> 1) & 0x3f;
    if (nalType === 33 && unit.length >= 7) {
      const level = Math.max(30, unit[6]);
      return `hev1.1.6.L${level}.B0`;
    }
  }
  return null;
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
