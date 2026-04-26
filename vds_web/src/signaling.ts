export type SignalMessage = {
  type: string;
  roomId?: string;
  clientId?: string;
  targetId?: string;
  sourceId?: string;
  sessionToken?: string;
  hostId?: string;
  upstreamPeerId?: string;
  nextViewerId?: string;
  chainPosition?: number;
  isFirstViewer?: boolean;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
  sdp?: RTCSessionDescriptionInit;
  code?: string;
  message?: string;
  mediaManifest?: unknown;
  [key: string]: unknown;
};

type MessageHandler = (message: SignalMessage) => void;
type StatusHandler = (status: 'connecting' | 'open' | 'closed' | 'error') => void;

export class VdsWebSignaling {
  private ws: WebSocket | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    this.emitStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        this.emitStatus('open');
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        this.emitStatus('error');
        reject(new Error('WebSocket connection failed'));
      }, { once: true });
      ws.addEventListener('close', () => this.emitStatus('closed'));
      ws.addEventListener('message', (event) => this.handleMessage(event.data));
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  send(message: SignalMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(raw: unknown): void {
    try {
      const parsed = JSON.parse(String(raw));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        return;
      }
      for (const handler of this.messageHandlers) {
        handler(parsed as SignalMessage);
      }
    } catch {
      // Invalid signaling payloads are ignored by the web harness.
    }
  }

  private emitStatus(status: 'connecting' | 'open' | 'closed' | 'error'): void {
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}

export async function fetchPublicRooms(): Promise<Array<{ roomId: string; viewerCount: number; createdAt: number }>> {
  const response = await fetch('/api/public-rooms', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch public rooms: ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.rooms) ? payload.rooms : [];
}

export async function fetchServerConfig(): Promise<{ iceServers: RTCIceServer[]; version?: string }> {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch server config: ${response.status}`);
  }
  const payload = await response.json();
  return {
    iceServers: Array.isArray(payload.iceServers) ? payload.iceServers : [],
    version: typeof payload.version === 'string' ? payload.version : undefined
  };
}
