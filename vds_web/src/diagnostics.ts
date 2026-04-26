import type { CapabilityReport } from './capabilities';

export type IceCounters = {
  local: number;
  remote: number;
};

export type DiagnosticsSnapshot = {
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
  capability: CapabilityReport;
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
      capability
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(partial: Partial<DiagnosticsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
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
    this.snapshot = {
      ...this.snapshot,
      [name]: this.snapshot[name] + amount
    };
    this.emit();
  }

  getSnapshot(): DiagnosticsSnapshot {
    return { ...this.snapshot };
  }

  format(): string {
    const redactedToken = this.snapshot.sessionToken ? `${this.snapshot.sessionToken.slice(0, 6)}...` : undefined;
    return JSON.stringify({
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
