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
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10000;

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

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${protocol}//${location.host}`);
    } catch (error) {
      return Promise.reject(error);
    }
    this.ws = ws;

    const pending = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = null;
        if (this.ws === ws) {
          this.connectPromise = null;
          this.rejectConnect = null;
        }
        if (error) reject(error);
        else resolve();
      };
      const fail = (error: Error, emitError: boolean) => {
        if (this.ws !== ws) return;
        // Closing a CONNECTING socket need not produce another event. Invalidate
        // it first so a late open/close cannot complete or clear its replacement.
        this.ws = null;
        this.connectPromise = null;
        this.rejectConnect = null;
        settle(error);
        try { ws.close(); } catch { /* The failed handshake is already detached. */ }
        if (emitError) this.emitStatus('error');
        if (this.ws === null) this.emitStatus('closed');
      };
      this.rejectConnect = (error) => settle(error);
      timeoutId = setTimeout(() => fail(new Error('WebSocket connection timeout'), true),
        WEBSOCKET_HANDSHAKE_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        if (this.ws !== ws) {
          return;
        }
        settle();
        this.emitStatus('open');
      }, { once: true });
      ws.addEventListener('error', () => {
        fail(new Error('WebSocket connection failed'), true);
      }, { once: true });
      ws.addEventListener('close', () => {
        fail(new Error('WebSocket closed before connection completed'), false);
      });
      ws.addEventListener('message', (event) => {
        if (this.ws === ws) {
          this.handleMessage(event.data);
        }
      });
    });
    this.connectPromise = pending;
    this.emitStatus('connecting');
    return pending;
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
    try { ws?.close(); } catch { /* Cancelling is complete even if close throws. */ }
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
