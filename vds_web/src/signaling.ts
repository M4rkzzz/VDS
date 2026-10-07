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
  private connectPromise: Promise<void> | null = null;
  private rejectConnect: ((reason: Error) => void) | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.emitStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    this.ws = ws;

    this.connectPromise = new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      ws.addEventListener('open', () => {
        if (this.ws !== ws) {
          return;
        }
        this.connectPromise = null;
        this.rejectConnect = null;
        this.emitStatus('open');
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        if (this.ws !== ws) {
          return;
        }
        this.ws = null;
        this.connectPromise = null;
        this.rejectConnect = null;
        ws.close();
        this.emitStatus('error');
        reject(new Error('WebSocket connection failed'));
        this.emitStatus('closed');
      }, { once: true });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) {
          return;
        }
        this.ws = null;
        this.connectPromise = null;
        this.rejectConnect = null;
        reject(new Error('WebSocket closed before connection completed'));
        this.emitStatus('closed');
      });
      ws.addEventListener('message', (event) => {
        if (this.ws === ws) {
          this.handleMessage(event.data);
        }
      });
    });
    return this.connectPromise;
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
    const ws = this.ws;
    this.ws = null;
    const rejectConnect = this.rejectConnect;
    this.connectPromise = null;
    this.rejectConnect = null;
    rejectConnect?.(new Error('WebSocket connection cancelled'));
    ws?.close();
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
