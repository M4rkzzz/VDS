export const ENCODED_MEDIA_PROTOCOL = 'vds-media-encoded-v1';
export const ENCODED_MEDIA_CHANNEL_LABEL = 'vds-media-encoded-v1';
export const ENCODED_MEDIA_PROTOCOL_VERSION = 1;
export const DATA_CHANNEL_OPEN_TIMEOUT_MS = 3000;
export const DATA_CHANNEL_HELLO_ACK_TIMEOUT_MS = 3000;
export const MAX_ENCODED_FRAME_BYTES = 2 * 1024 * 1024;
export const DATA_CHANNEL_CHUNK_PAYLOAD_BYTES = 12 * 1024;
const MAX_PENDING_CHUNKED_FRAMES = 64;

const MAGIC = 'VDS1';
const HEADER_LIMIT_BYTES = 16 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type EncodedMediaCapabilities = {
  protocol: typeof ENCODED_MEDIA_PROTOCOL;
  protocolVersion: number;
  supportedVideoCodecs: string[];
  supportedAudioCodecs: string[];
  supportedVideoPayloadFormats: string[];
  supportedAudioPayloadFormats: string[];
  maxFrameBytes: number;
  bootstrapRequired: boolean;
};

type EncodedMediaControlMessage = {
  protocol: typeof ENCODED_MEDIA_PROTOCOL;
  type: 'hello' | 'hello-ack' | 'keyframe-request' | 'bootstrap' | 'stats' | 'error' | 'close';
  protocolVersion: number;
  role?: 'sender' | 'receiver' | 'relay';
  supportedVideoCodecs?: string[];
  supportedAudioCodecs?: string[];
  supportedVideoPayloadFormats?: string[];
  supportedAudioPayloadFormats?: string[];
  maxFrameBytes?: number;
  bootstrapRequired?: boolean;
  mediaSessionId?: string;
  manifestVersion?: number;
  reason?: string;
  message?: string;
};

export type EncodedFrameHeader = {
  protocol: typeof ENCODED_MEDIA_PROTOCOL;
  type: 'frame' | 'chunk';
  streamType: 'video' | 'audio';
  codec: string;
  payloadFormat?: 'annexb' | 'avcc' | 'raw' | 'opus-raw' | 'aac-adts' | 'unknown';
  timestampUs: number;
  sequence: number;
  keyframe: boolean;
  config: boolean;
  frameId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  framePayloadBytes?: number;
};

export function webEncodedMediaCapabilities(options: {
  supportedVideoCodecs?: string[];
  supportedAudioCodecs?: string[];
} = {}): EncodedMediaCapabilities {
  const supportedVideoCodecs = sanitizeCodecList(options.supportedVideoCodecs);
  const supportedAudioCodecs = sanitizeCodecList(options.supportedAudioCodecs);
  return {
    protocol: ENCODED_MEDIA_PROTOCOL,
    protocolVersion: ENCODED_MEDIA_PROTOCOL_VERSION,
    supportedVideoCodecs,
    supportedAudioCodecs,
    supportedVideoPayloadFormats: supportedVideoCodecs.length > 0 ? ['annexb', 'avcc'] : [],
    supportedAudioPayloadFormats: getSupportedAudioPayloadFormats(supportedAudioCodecs),
    maxFrameBytes: MAX_ENCODED_FRAME_BYTES,
    bootstrapRequired: true
  };
}

export function helloMessage(
  role: 'sender' | 'receiver' | 'relay',
  manifest?: { mediaSessionId?: unknown; manifestVersion?: unknown },
  options: { supportedVideoCodecs?: string[]; supportedAudioCodecs?: string[] } = {}
): EncodedMediaControlMessage {
  const capabilities = webEncodedMediaCapabilities(options);
  return {
    protocol: ENCODED_MEDIA_PROTOCOL,
    type: 'hello',
    role,
    protocolVersion: capabilities.protocolVersion,
    supportedVideoCodecs: capabilities.supportedVideoCodecs,
    supportedAudioCodecs: capabilities.supportedAudioCodecs,
    supportedVideoPayloadFormats: capabilities.supportedVideoPayloadFormats,
    supportedAudioPayloadFormats: capabilities.supportedAudioPayloadFormats,
    maxFrameBytes: capabilities.maxFrameBytes,
    bootstrapRequired: capabilities.bootstrapRequired,
    mediaSessionId: typeof manifest?.mediaSessionId === 'string' ? manifest.mediaSessionId : undefined,
    manifestVersion: typeof manifest?.manifestVersion === 'number' ? manifest.manifestVersion : undefined
  };
}

export function helloAckMessage(manifest?: { mediaSessionId?: unknown; manifestVersion?: unknown }): EncodedMediaControlMessage {
  return {
    protocol: ENCODED_MEDIA_PROTOCOL,
    type: 'hello-ack',
    protocolVersion: ENCODED_MEDIA_PROTOCOL_VERSION,
    mediaSessionId: typeof manifest?.mediaSessionId === 'string' ? manifest.mediaSessionId : undefined,
    manifestVersion: typeof manifest?.manifestVersion === 'number' ? manifest.manifestVersion : undefined
  };
}

export function encodeFrameMessage(header: EncodedFrameHeader, payload: ArrayBuffer): ArrayBuffer {
  if (payload.byteLength > MAX_ENCODED_FRAME_BYTES) {
    throw new Error('datachannel-frame-too-large');
  }

  const headerBytes = textEncoder.encode(JSON.stringify(header));
  if (headerBytes.byteLength > HEADER_LIMIT_BYTES) {
    throw new Error('datachannel-frame-header-too-large');
  }

  const output = new ArrayBuffer(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(output);
  for (let index = 0; index < MAGIC.length; index += 1) {
    view.setUint8(index, MAGIC.charCodeAt(index));
  }
  view.setUint32(4, headerBytes.byteLength, false);
  new Uint8Array(output, 8, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(output, 8 + headerBytes.byteLength).set(new Uint8Array(payload));
  return output;
}

export function encodeFrameMessages(header: EncodedFrameHeader, payload: ArrayBuffer): ArrayBuffer[] {
  if (payload.byteLength <= DATA_CHANNEL_CHUNK_PAYLOAD_BYTES) {
    return [encodeFrameMessage({ ...header, type: 'frame' }, payload)];
  }
  if (payload.byteLength > MAX_ENCODED_FRAME_BYTES) {
    throw new Error('datachannel-frame-too-large');
  }

  const frameId = `${header.streamType}:${header.timestampUs}:${header.sequence}:${payload.byteLength}`;
  const chunks: ArrayBuffer[] = [];
  const bytes = new Uint8Array(payload);
  const chunkCount = Math.ceil(bytes.byteLength / DATA_CHANNEL_CHUNK_PAYLOAD_BYTES);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * DATA_CHANNEL_CHUNK_PAYLOAD_BYTES;
    const end = Math.min(bytes.byteLength, start + DATA_CHANNEL_CHUNK_PAYLOAD_BYTES);
    chunks.push(encodeFrameMessage({
      ...header,
      type: 'chunk',
      frameId,
      chunkIndex,
      chunkCount,
      framePayloadBytes: payload.byteLength
    }, bytes.slice(start, end).buffer));
  }
  return chunks;
}

export function decodeFrameMessage(buffer: ArrayBuffer): { header: EncodedFrameHeader; payload: ArrayBuffer } {
  if (buffer.byteLength < 8) {
    throw new Error('datachannel-frame-invalid');
  }

  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) {
    throw new Error('datachannel-frame-invalid-magic');
  }

  const headerLength = view.getUint32(4, false);
  if (headerLength <= 0 || headerLength > HEADER_LIMIT_BYTES || 8 + headerLength > buffer.byteLength) {
    throw new Error('datachannel-frame-invalid-header');
  }

  const header = JSON.parse(textDecoder.decode(new Uint8Array(buffer, 8, headerLength))) as EncodedFrameHeader;
  if (!isFrameHeader(header)) {
    throw new Error('datachannel-frame-invalid-header');
  }

  return {
    header,
    payload: buffer.slice(8 + headerLength)
  };
}

export class EncodedFrameReassembler {
  private readonly pending = new Map<string, {
    header: EncodedFrameHeader;
    chunks: Array<ArrayBuffer | undefined>;
    received: number;
    payloadBytes: number;
    createdAt: number;
  }>();

  clear(): void {
    this.pending.clear();
  }

  push(buffer: ArrayBuffer): { header: EncodedFrameHeader; payload: ArrayBuffer } | null {
    const decoded = decodeFrameMessage(buffer);
    if (decoded.header.type === 'frame') {
      return decoded;
    }

    const frameId = decoded.header.frameId;
    const chunkIndex = decoded.header.chunkIndex;
    const chunkCount = decoded.header.chunkCount;
    const payloadBytes = decoded.header.framePayloadBytes;
    if (
      !frameId ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(chunkCount) ||
      !Number.isInteger(payloadBytes) ||
      typeof chunkIndex !== 'number' ||
      typeof chunkCount !== 'number' ||
      typeof payloadBytes !== 'number' ||
      chunkIndex < 0 ||
      chunkCount <= 0 ||
      chunkIndex >= chunkCount ||
      payloadBytes <= 0 ||
      payloadBytes > MAX_ENCODED_FRAME_BYTES ||
      chunkCount > Math.ceil(MAX_ENCODED_FRAME_BYTES / DATA_CHANNEL_CHUNK_PAYLOAD_BYTES) ||
      decoded.payload.byteLength > DATA_CHANNEL_CHUNK_PAYLOAD_BYTES ||
      (chunkIndex < chunkCount - 1 && decoded.payload.byteLength !== DATA_CHANNEL_CHUNK_PAYLOAD_BYTES)
    ) {
      throw new Error('datachannel-chunk-invalid-header');
    }

    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > 10000) {
        this.pending.delete(id);
      }
    }

    let entry = this.pending.get(frameId);
    if (!entry) {
      entry = {
        header: { ...decoded.header, type: 'frame' },
        chunks: new Array(chunkCount),
        received: 0,
        payloadBytes,
        createdAt: now
      };
      delete entry.header.frameId;
      delete entry.header.chunkIndex;
      delete entry.header.chunkCount;
      delete entry.header.framePayloadBytes;
      this.pending.set(frameId, entry);
      if (this.pending.size > MAX_PENDING_CHUNKED_FRAMES) {
        const oldest = this.pending.keys().next().value;
        if (oldest) {
          this.pending.delete(oldest);
        }
      }
    }

    if (!entry.chunks[chunkIndex]) {
      entry.chunks[chunkIndex] = decoded.payload;
      entry.received += 1;
    }
    if (entry.received !== entry.chunks.length) {
      return null;
    }

    const output = new Uint8Array(entry.payloadBytes);
    let offset = 0;
    for (const chunk of entry.chunks) {
      if (!chunk) {
        return null;
      }
      const chunkBytes = new Uint8Array(chunk);
      if (offset + chunkBytes.byteLength > output.byteLength) {
        this.pending.delete(frameId);
        throw new Error('datachannel-chunk-payload-overflow');
      }
      output.set(chunkBytes, offset);
      offset += chunkBytes.byteLength;
    }
    this.pending.delete(frameId);
    return {
      header: entry.header,
      payload: output.buffer
    };
  }
}

function sanitizeCodecList(value: string[] | undefined): string[] {
  const list = Array.isArray(value)
    ? value.map(normalizeCapabilityCodecName).filter(Boolean)
    : [];
  return Array.from(new Set(list));
}

function normalizeCapabilityCodecName(value: string): string {
  const raw = String(value || '').toLowerCase().trim();
  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (raw.startsWith('avc1') || raw.startsWith('avc3') || compact.startsWith('avc1') || compact.startsWith('avc3')) {
    return 'h264';
  }
  if (raw.startsWith('hvc1') || raw.startsWith('hev1') || compact.startsWith('hvc1') || compact.startsWith('hev1') || compact === 'hevc') {
    return 'h265';
  }
  if (compact === 'mp4a402') {
    return 'aac';
  }
  return raw;
}

function getSupportedAudioPayloadFormats(supportedAudioCodecs: string[]): string[] {
  const formats: string[] = [];
  if (supportedAudioCodecs.includes('opus')) {
    formats.push('opus-raw', 'raw');
  }
  if (supportedAudioCodecs.includes('aac')) {
    formats.push('aac-adts', 'raw');
  }
  return Array.from(new Set(formats));
}

export function parseControlMessage(raw: string): EncodedMediaControlMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.protocol !== ENCODED_MEDIA_PROTOCOL || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as EncodedMediaControlMessage;
  } catch {
    return null;
  }
}

function isFrameHeader(value: EncodedFrameHeader): boolean {
  return Boolean(
    value &&
    value.protocol === ENCODED_MEDIA_PROTOCOL &&
    (value.type === 'frame' || value.type === 'chunk') &&
    (value.streamType === 'video' || value.streamType === 'audio') &&
    typeof value.codec === 'string' &&
    typeof value.timestampUs === 'number' &&
    typeof value.sequence === 'number' &&
    typeof value.keyframe === 'boolean' &&
    typeof value.config === 'boolean' &&
    (
      value.type === 'frame' ||
      (
        typeof value.frameId === 'string' &&
        typeof value.chunkIndex === 'number' &&
        typeof value.chunkCount === 'number' &&
        typeof value.framePayloadBytes === 'number'
      )
    )
  );
}
