import type { CapabilityReport } from './capabilities';

const DIAGNOSTICS_SCHEMA_VERSION = 2;

type IceCounters = {
  local: number;
  remote: number;
};

type DiagnosticsSnapshot = {
  status: string;
  roomId?: string;
  clientId: string;
  sessionToken?: string;
  hostId?: string;
  upstreamPeerId?: string;
  downstreamPeerId?: string;
  chainPosition?: number;
  iceState: Record<string, string>;
  candidateCounts: Record<string, IceCounters>;
  encodedFramesReceived: number;
  encodedKeyframesReceived: number;
  encodedFramesForwarded: number;
  encodedAudioFramesForwarded: number;
  dataChannelFramesReceived: number;
  dataChannelFramesForwarded: number;
  dataChannelChunksReceived: number;
  dataChannelFramesDropped: number;
  dataChannelBootstrapFramesSent: number;
  webDecodedVideoFrames: number;
  webDroppedVideoFrames: number;
  webDecodedAudioBlocks: number;
  webDroppedAudioBlocks: number;
  relayProtocol: string;
  relayProtocolState: string;
  h264PayloadFormat: string;
  reencodePathUsed: boolean;
  relayFailureReason?: string;
  lastError?: string;
  mediaManifest?: unknown;
  observedMediaManifests: ObservedMediaManifest[];
  serverMediaCapabilities?: unknown;
  capability: CapabilityReport;
};

type ObservedMediaManifest = {
  protocol: string;
  videoCodec: string;
  videoPayloadFormat: string;
  audioCodec: string;
  audioPayloadFormat: string;
  count: number;
  decodedVideoFrames: number;
  decodedAudioBlocks: number;
  forwardedVideoFrames: number;
  forwardedAudioFrames: number;
};

export class DiagnosticsStore {
  private snapshot: DiagnosticsSnapshot;
  private listeners = new Set<() => void>();

  constructor(capability: CapabilityReport, clientId: string) {
    this.snapshot = {
      status: '能力检测中',
      clientId,
      iceState: {},
      candidateCounts: {},
      encodedFramesReceived: 0,
      encodedKeyframesReceived: 0,
      encodedFramesForwarded: 0,
      encodedAudioFramesForwarded: 0,
      dataChannelFramesReceived: 0,
      dataChannelFramesForwarded: 0,
      dataChannelChunksReceived: 0,
      dataChannelFramesDropped: 0,
      dataChannelBootstrapFramesSent: 0,
      webDecodedVideoFrames: 0,
      webDroppedVideoFrames: 0,
      webDecodedAudioBlocks: 0,
      webDroppedAudioBlocks: 0,
      relayProtocol: 'vds-media-encoded-v1',
      relayProtocolState: 'idle',
      h264PayloadFormat: 'unknown',
      reencodePathUsed: false,
      observedMediaManifests: [],
      capability
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(partial: Partial<DiagnosticsSnapshot>): void {
    const observedMediaManifests = partial.mediaManifest
      ? recordObservedMediaManifest(this.snapshot.observedMediaManifests, partial.mediaManifest)
      : this.snapshot.observedMediaManifests;
    this.snapshot = { ...this.snapshot, ...partial, observedMediaManifests };
    this.emit();
  }

  updateIce(peerId: string, state: string): void {
    this.snapshot.iceState = { ...this.snapshot.iceState, [peerId]: state };
    this.emit();
  }

  incrementCandidate(peerId: string, direction: keyof IceCounters): void {
    const current = this.snapshot.candidateCounts[peerId] || { local: 0, remote: 0 };
    this.snapshot.candidateCounts = {
      ...this.snapshot.candidateCounts,
      [peerId]: { ...current, [direction]: current[direction] + 1 }
    };
    this.emit();
  }

  incrementCounter(
    name:
      | 'encodedFramesReceived'
      | 'encodedKeyframesReceived'
      | 'encodedFramesForwarded'
      | 'encodedAudioFramesForwarded'
      | 'dataChannelFramesReceived'
      | 'dataChannelFramesForwarded'
      | 'dataChannelChunksReceived'
      | 'dataChannelFramesDropped'
      | 'dataChannelBootstrapFramesSent'
      | 'webDecodedVideoFrames'
      | 'webDroppedVideoFrames'
      | 'webDecodedAudioBlocks'
      | 'webDroppedAudioBlocks',
    amount = 1
  ): void {
    const observedMediaManifests = incrementObservedMediaCounter(
      this.snapshot.observedMediaManifests,
      this.snapshot.mediaManifest,
      name,
      amount
    );
    this.snapshot = {
      ...this.snapshot,
      [name]: this.snapshot[name] + amount,
      observedMediaManifests
    };
    this.emit();
  }

  getSnapshot(): DiagnosticsSnapshot {
    return { ...this.snapshot };
  }

  format(): string {
    const redactedToken = this.snapshot.sessionToken ? `${this.snapshot.sessionToken.slice(0, 6)}...` : undefined;
    const capability = this.snapshot.capability;
    return JSON.stringify({
      diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      diagnosticsGeneratedAt: new Date().toISOString(),
      recommendedFixtureFilename: recommendedFixtureFilename(capability),
      environment: {
        browser: capability.browser,
        browserFamily: capability.browserFamily,
        platform: capability.platform,
        mobile: capability.mobile,
        secureContext: capability.secureContext,
        lanHttpAllowed: capability.lanHttpAllowed,
        webRtc: capability.webRtc,
        webCodecsVideoDecoder: capability.webCodecsVideoDecoder,
        webCodecsAudioDecoder: capability.webCodecsAudioDecoder,
        ok: capability.ok,
        reasons: capability.reasons,
        iosSafari: capability.iosSafari,
        iosWebKit: capability.iosWebKit,
        androidChromium: capability.androidChromium,
        androidChrome: capability.androidChrome,
        audioOutput: capability.audioOutput,
        relayCapable: capability.relayCapable,
        maxDirectDownstreams: capability.maxDirectDownstreams,
        relayEligibilityReason: capability.relayEligibilityReason,
        supportedVideoCodecs: capability.supportedVideoCodecs,
        supportedAudioCodecs: capability.supportedAudioCodecs,
        videoCodecProbeResults: capability.videoCodecProbeResults,
        audioCodecProbeResults: capability.audioCodecProbeResults,
        supportedVideoPayloadFormats: getSupportedVideoPayloadFormats(capability),
        supportedAudioPayloadFormats: getSupportedAudioPayloadFormats(capability)
      },
      serverMediaCapabilities: this.snapshot.serverMediaCapabilities,
      observedMediaSummary: formatObservedMediaSummary(this.snapshot.observedMediaManifests),
      ...this.snapshot,
      sessionToken: redactedToken
    }, null, 2);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function recommendedFixtureFilename(capability: CapabilityReport): string {
  if (capability.iosSafari) {
    return 'ios-safari-leaf.json';
  }
  if (capability.platform === 'android' && capability.androidChrome) {
    return 'android-chrome-relay.json';
  }
  if (capability.platform === 'android') {
    return 'android-non-chrome-leaf.json';
  }
  return 'vds-web-diagnostics.json';
}

function recordObservedMediaManifest(current: ObservedMediaManifest[], mediaManifest: unknown): ObservedMediaManifest[] {
  const observed = summarizeMediaManifest(mediaManifest);
  if (!observed) {
    return current;
  }
  const key = observedMediaManifestKey(observed);
  let matched = false;
  const next = current.map((item) => {
    if (observedMediaManifestKey(item) !== key) {
      return item;
    }
    matched = true;
    return { ...item, count: item.count + 1 };
  });
  return matched ? next : [...next, observed];
}

function incrementObservedMediaCounter(
  current: ObservedMediaManifest[],
  mediaManifest: unknown,
  counterName: string,
  amount: number
): ObservedMediaManifest[] {
  const field = observedCounterField(counterName);
  const observed = summarizeMediaManifest(mediaManifest);
  if (!field || !observed) {
    return current;
  }
  const key = observedMediaManifestKey(observed);
  let matched = false;
  const next = current.map((item) => {
    if (observedMediaManifestKey(item) !== key) {
      return item;
    }
    matched = true;
    return { ...item, [field]: item[field] + amount };
  });
  return matched ? next : [...next, { ...observed, [field]: amount }];
}

function observedCounterField(counterName: string): 'decodedVideoFrames' | 'decodedAudioBlocks' | 'forwardedVideoFrames' | 'forwardedAudioFrames' | null {
  if (counterName === 'webDecodedVideoFrames') {
    return 'decodedVideoFrames';
  }
  if (counterName === 'webDecodedAudioBlocks') {
    return 'decodedAudioBlocks';
  }
  if (counterName === 'encodedFramesForwarded') {
    return 'forwardedVideoFrames';
  }
  if (counterName === 'encodedAudioFramesForwarded') {
    return 'forwardedAudioFrames';
  }
  return null;
}

function summarizeMediaManifest(mediaManifest: unknown): ObservedMediaManifest | null {
  if (!mediaManifest || typeof mediaManifest !== 'object') {
    return null;
  }
  const manifest = mediaManifest as {
    protocol?: unknown;
    video?: { codec?: unknown; payloadFormat?: unknown };
    audio?: { codec?: unknown; payloadFormat?: unknown };
  };
  const videoCodec = String(manifest.video?.codec || '').trim().toLowerCase();
  const audioCodec = String(manifest.audio?.codec || '').trim().toLowerCase();
  if (!videoCodec || !audioCodec) {
    return null;
  }
  return {
    protocol: String(manifest.protocol || '').trim().toLowerCase(),
    videoCodec,
    videoPayloadFormat: String(manifest.video?.payloadFormat || 'annexb').trim().toLowerCase(),
    audioCodec,
    audioPayloadFormat: String(manifest.audio?.payloadFormat || (audioCodec === 'aac' ? 'aac-adts' : 'opus-raw')).trim().toLowerCase(),
    count: 1,
    decodedVideoFrames: 0,
    decodedAudioBlocks: 0,
    forwardedVideoFrames: 0,
    forwardedAudioFrames: 0
  };
}

function observedMediaManifestKey(item: ObservedMediaManifest): string {
  return [item.protocol, item.videoCodec, item.videoPayloadFormat, item.audioCodec, item.audioPayloadFormat].join('|');
}

function formatObservedMediaSummary(items: ObservedMediaManifest[]): string[] {
  return items.map((item) => {
    const video = `${item.videoCodec}/${item.videoPayloadFormat}`;
    const audio = `${item.audioCodec}/${item.audioPayloadFormat}`;
    return `${video}+${audio} seen=${item.count} decoded=v${item.decodedVideoFrames}/a${item.decodedAudioBlocks} forwarded=v${item.forwardedVideoFrames}/a${item.forwardedAudioFrames}`;
  });
}

function getSupportedVideoPayloadFormats(capability: CapabilityReport): string[] {
  return capability.supportedVideoCodecs.length > 0 ? ['annexb', 'avcc'] : [];
}

function getSupportedAudioPayloadFormats(capability: CapabilityReport): string[] {
  const formats: string[] = [];
  if (capability.supportedAudioCodecs.includes('opus')) {
    formats.push('opus-raw', 'raw');
  }
  if (capability.supportedAudioCodecs.includes('aac')) {
    formats.push('aac-adts', 'raw');
  }
  return Array.from(new Set(formats));
}
