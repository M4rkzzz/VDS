import type { EncodedFrameHeader } from './datachannel-protocol';

type AudioDiagnostics = {
  onState: (state: string) => void;
  onDecodedBlock: () => void;
  onDroppedBlock: (reason: string) => void;
};

type AudioDecoderLike = {
  state: 'unconfigured' | 'configured' | 'closed';
  configure: (config: AudioDecoderConfig) => void;
  decode: (chunk: EncodedAudioChunk) => void;
  close: () => void;
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

  constructor(private readonly diagnostics: AudioDiagnostics) {}

  async pushFrame(header: EncodedFrameHeader, payload: ArrayBuffer): Promise<void> {
    if (header.streamType !== 'audio') {
      return;
    }
    if (!window.AudioDecoder || !window.EncodedAudioChunk) {
      this.diagnostics.onDroppedBlock('webcodecs-audio-decoder-unavailable');
      return;
    }

    const codec = normalizeAudioCodec(header.codec);
    if (!codec) {
      this.diagnostics.onDroppedBlock('webcodecs-audio-codec-unsupported');
      return;
    }
    if (!this.decoder || this.configuredCodec !== codec) {
      const configured = await this.configure(codec);
      if (!configured) {
        this.diagnostics.onDroppedBlock(`webcodecs-${codec}-config-unsupported`);
        return;
      }
    }

    const decodePayload = codec === 'mp4a.40.2' ? stripAacAdtsHeader(payload) : payload;
    try {
      this.decoder?.decode(new window.EncodedAudioChunk({
        type: 'key',
        timestamp: Math.max(0, Math.trunc(header.timestampUs || 0)),
        data: decodePayload
      }));
    } catch (error) {
      this.diagnostics.onDroppedBlock(error instanceof Error ? error.message : 'webcodecs-audio-decode-failed');
    }
  }

  async resume(): Promise<void> {
    if (this.context && this.context.state === 'suspended') {
      await this.context.resume().catch(() => {});
    }
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
    this.configuredCodec = '';
    this.nextPlaybackTime = 0;
  }

  setDelayMs(value: number): void {
    const normalized = Number.isFinite(value) ? value : 0;
    this.delayMs = Math.max(0, Math.min(300, Math.trunc(normalized)));
    this.nextPlaybackTime = 0;
  }

  setVolume(value: number): void {
    const normalized = Number.isFinite(value) ? value : 1;
    this.volume = Math.max(0, Math.min(1, normalized));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  private async configure(codec: string): Promise<boolean> {
    this.decoder?.close();
    this.nextPlaybackTime = 0;
    this.decoder = new window.AudioDecoder!({
      output: (data) => this.playAudioData(data),
      error: (error) => this.diagnostics.onDroppedBlock(error.message || 'webcodecs-audio-decoder-error')
    });

    const config: AudioDecoderConfig = {
      codec,
      sampleRate: 48000,
      numberOfChannels: 2
    };
    if (window.AudioDecoder?.isConfigSupported) {
      const support = await window.AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (!support.supported) {
        return false;
      }
    }

    const decoder = this.decoder;
    if (!decoder) {
      return false;
    }
    decoder.configure(config);
    this.configuredCodec = codec;
    this.diagnostics.onState(`webcodecs-audio-configured-${codec}`);
    return true;
  }

  private playAudioData(data: AudioData): void {
    try {
      const context = this.ensureContext(data.sampleRate);
      const channelCount = Math.max(1, Math.min(data.numberOfChannels || 2, 2));
      const audioBuffer = context.createBuffer(channelCount, data.numberOfFrames, data.sampleRate);
      for (let channel = 0; channel < channelCount; channel += 1) {
        const target = audioBuffer.getChannelData(channel);
        data.copyTo(target, { planeIndex: channel, format: 'f32-planar' as AudioSampleFormat });
      }
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ensureGainNode(context));
      const delaySeconds = this.delayMs / 1000;
      const minimumStartTime = context.currentTime + delaySeconds;
      if (this.nextPlaybackTime < minimumStartTime - 0.08 || this.nextPlaybackTime > minimumStartTime + 0.5) {
        this.nextPlaybackTime = minimumStartTime;
      } else {
        this.nextPlaybackTime = Math.max(this.nextPlaybackTime, minimumStartTime);
      }
      const startAt = this.nextPlaybackTime;
      source.start(startAt);
      this.nextPlaybackTime = startAt + audioBuffer.duration;
      this.diagnostics.onDecodedBlock();
    } catch (error) {
      this.diagnostics.onDroppedBlock(error instanceof Error ? error.message : 'webcodecs-audio-output-failed');
    } finally {
      data.close();
    }
  }

  private ensureContext(sampleRate: number): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate });
      this.gainNode = null;
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

function normalizeAudioCodec(codec: string): string {
  const normalized = String(codec || '').toLowerCase();
  if (normalized === 'opus') {
    return 'opus';
  }
  if (normalized === 'aac' || normalized === 'mp4a.40.2') {
    return 'mp4a.40.2';
  }
  return '';
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
