import { createContext, useContext, useEffect, useRef } from 'react';
import { WsServerMessageSchema, type WsClientMessage, type WsServerMessage } from '@luady/shared';
import { readPageKey } from '../auth/page-key.js';
import { PresenceSignals, SubscriptionCounts, ackFrames } from './ws-signals.js';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface WsHandlers {
  onMessage(message: WsServerMessage): void;
  onStatus?(status: WsStatus, info: { epoch: number; attempt: number }): void;
  onWarning?(message: string): void;
  /** Close code 4401: the app session expired. The client stops instead of reconnecting. */
  onAuthExpired?(): void;
}

export interface WsClientOptions extends WsHandlers {
  url: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Epoch ms, for the presence.active throttle. */
  now?: () => number;
  /** The page key the socket sends first; the stored one by default. */
  pageKey?: () => string | null;
}

/** One server message type, with its payload. */
export type WsMessageOf<T extends WsServerMessage['type']> = Extract<WsServerMessage, { type: T }>;

export interface WsClient {
  start(): void;
  stop(): void;
  reconnectNow(): void;
  subscribeTranscript(sessionId: string): () => void;
  /** Reference-counted like subscribeTranscript; sent again after every reconnect. */
  subscribeSteps(sessionId: string): () => void;
  /** Remembers the tab's visibility; sends presence.hello now and again first after every reconnect. */
  setVisible(visible: boolean): void;
  /** The owner touched a visible page: presence.active, at most one a minute. */
  touch(): void;
  /** notice.ack in chunks of at most LIMITS.noticeAckMax; dropped while the socket is closed. */
  ackNotices(ids: readonly string[]): void;
  /** A host job's log lines (host.log); reference-counted like the others and sent again after every reconnect. */
  subscribeHost(id: string): () => void;
  /** Releases one subscribeHost of that host. */
  unsubscribeHost(id: string): void;
  /** Every message of one type, after the store saw it; returns the release function. */
  on<T extends WsServerMessage['type']>(type: T, handler: (message: WsMessageOf<T>) => void): () => void;
  status(): WsStatus;
  epoch(): number;
}

interface ResolvedOptions extends WsHandlers {
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  readonly random: () => number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly now: () => number;
  readonly pageKey: () => string | null;
}

const OPEN = 1;
const AUTH_EXPIRED = 4401;

export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(Math.min(maxMs, exponential * (0.8 + random() * 0.4)));
}

export function wsUrl(path: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${path}`;
}

function detach(socket: SocketLike): void {
  socket.onopen = null;
  socket.onclose = null;
  socket.onmessage = null;
  socket.onerror = null;
}

class ReconnectingSocket implements WsClient {
  private readonly subs = new SubscriptionCounts(
    (sessionId) => this.send({ type: 'subscribe.transcript', sessionId }),
    (sessionId) => this.send({ type: 'unsubscribe.transcript', sessionId }),
  );
  private readonly stepSubs = new SubscriptionCounts(
    (sessionId) => this.send({ type: 'subscribe.steps', sessionId }),
    (sessionId) => this.send({ type: 'unsubscribe.steps', sessionId }),
  );
  private readonly hostSubs = new SubscriptionCounts(
    (host) => this.send({ type: 'subscribe.host', host }),
    (host) => this.send({ type: 'unsubscribe.host', host }),
  );
  private readonly hostReleases = new Map<string, Array<() => void>>();
  private listeners: ReadonlyArray<{ readonly type: string; readonly handler: (message: WsServerMessage) => void }> = [];
  private readonly presence: PresenceSignals;
  private socket: SocketLike | null = null;
  private current: WsStatus = 'idle';
  private attempt = 0;
  private connections = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: ResolvedOptions;

  constructor(options: ResolvedOptions) {
    this.options = options;
    this.presence = new PresenceSignals((message) => this.send(message), options.now);
  }

  readonly status = (): WsStatus => this.current;
  readonly epoch = (): number => this.connections;

  readonly start = (): void => {
    if (this.current !== 'idle' && this.current !== 'stopped') return;
    this.current = 'idle';
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  };

  readonly stop = (): void => {
    this.setStatus('stopped');
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.clearRetry();
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      socket.close(1000, 'client stopped');
    }
  };

  readonly reconnectNow = (): void => {
    if (this.current === 'stopped' || this.current === 'idle' || this.socket !== null) return;
    this.clearRetry();
    this.connect();
  };

  readonly subscribeTranscript = (sessionId: string): (() => void) => this.subs.add(sessionId);

  readonly subscribeSteps = (sessionId: string): (() => void) => this.stepSubs.add(sessionId);

  readonly setVisible = (visible: boolean): void => this.presence.setVisible(visible);

  readonly touch = (): void => this.presence.touch();

  readonly ackNotices = (ids: readonly string[]): void => {
    for (const frame of ackFrames(ids)) this.send(frame);
  };

  readonly subscribeHost = (id: string): (() => void) => {
    const release = this.hostSubs.add(id);
    this.hostReleases.set(id, [...(this.hostReleases.get(id) ?? []), release]);
    return () => {
      this.hostReleases.set(id, (this.hostReleases.get(id) ?? []).filter((one) => one !== release));
      release();
    };
  };

  readonly unsubscribeHost = (id: string): void => {
    const [release, ...rest] = this.hostReleases.get(id) ?? [];
    this.hostReleases.set(id, rest);
    release?.();
  };

  readonly on = <T extends WsServerMessage['type']>(type: T, handler: (message: WsMessageOf<T>) => void): (() => void) => {
    const entry = { type, handler: handler as (message: WsServerMessage) => void };
    this.listeners = [...this.listeners, entry];
    return () => {
      this.listeners = this.listeners.filter((one) => one !== entry);
    };
  };

  private readonly onOnline = (): void => {
    if (this.current === 'reconnecting') this.reconnectNow();
  };

  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible' && this.current === 'reconnecting') this.reconnectNow();
  };

  private setStatus(next: WsStatus): void {
    if (next === this.current) return;
    this.current = next;
    this.options.onStatus?.(next, { epoch: this.connections, attempt: this.attempt });
  }

  private send(message: WsClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    if (this.current === 'stopped') return;
    if (this.current === 'idle') this.setStatus('connecting');
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch (err) {
      this.options.onWarning?.(`Could not open the live connection: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleData(event.data);
    socket.onclose = (event) => this.handleClosed(socket, event.code);
    socket.onerror = () => this.options.onWarning?.('Live connection error; waiting for it to close');
  }

  /** The page key goes first, then the presence hello; then every subscription is sent again. */
  private handleOpen(socket: SocketLike): void {
    const key = this.options.pageKey();
    if (key !== null) this.send({ type: 'auth', key });
    this.presence.opened();
    for (const sessionId of this.subs.ids()) this.send({ type: 'subscribe.transcript', sessionId });
    for (const sessionId of this.stepSubs.ids()) this.send({ type: 'subscribe.steps', sessionId });
    for (const host of this.hostSubs.ids()) this.send({ type: 'subscribe.host', host });
    this.startHeartbeat(socket);
  }

  private handleData(data: unknown): void {
    this.clearPong();
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      this.options.onWarning?.('Ignored a live message that is not JSON');
      return;
    }
    const parsed = WsServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.onWarning?.(`Ignored an invalid live message: ${parsed.error.issues[0]?.message ?? 'unknown shape'}`);
      return;
    }
    if (parsed.data.type === 'hello' && this.current !== 'open') {
      this.attempt = 0;
      this.connections += 1;
      this.setStatus('open');
    }
    this.options.onMessage(parsed.data);
    for (const listener of this.listeners) {
      if (listener.type === parsed.data.type) listener.handler(parsed.data);
    }
  }

  private handleClosed(socket: SocketLike, code?: number): void {
    if (this.socket !== socket) return;
    detach(socket);
    this.socket = null;
    this.clearHeartbeat();
    if (code === AUTH_EXPIRED) {
      this.stop();
      this.options.onAuthExpired?.();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.current === 'stopped') return;
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.clearRetry();
    const delay = backoffDelay(this.attempt, this.options.baseDelayMs, this.options.maxDelayMs, this.options.random);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(socket: SocketLike): void {
    this.clearHeartbeat();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
      if (this.pongTimer === null) {
        this.pongTimer = setTimeout(() => this.handlePongTimeout(socket), this.options.pongTimeoutMs);
      }
    }, this.options.pingIntervalMs);
  }

  private handlePongTimeout(socket: SocketLike): void {
    this.options.onWarning?.('No reply to ping; reconnecting');
    this.handleClosed(socket);
    socket.close(4000, 'ping timeout');
  }

  private clearPong(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPong();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export function createWsClient(options: WsClientOptions): WsClient {
  return new ReconnectingSocket({
    ...options,
    createSocket: options.createSocket ?? ((url: string) => new WebSocket(url)),
    random: options.random ?? Math.random,
    baseDelayMs: options.baseDelayMs ?? 1_000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
    pingIntervalMs: options.pingIntervalMs ?? 25_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
    now: options.now ?? Date.now,
    pageKey: options.pageKey ?? readPageKey,
  });
}

/** The page's live socket, for the hooks below (the store provides it). */
export const WsClientContext = createContext<WsClient | null>(null);

/**
 * Calls handler with every live message of one type while the component is mounted (rooms, hosts, host jobs and
 * logs, channels, setup). The latest handler is used; there is no re-subscription per render.
 */
export function useWsMessage<T extends WsServerMessage['type']>(type: T, handler: (message: WsMessageOf<T>) => void): void {
  const ws = useContext(WsClientContext);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (ws === null) return undefined;
    return ws.on(type, (message) => latest.current(message));
  }, [ws, type]);
}

/** Follows one host's job log while mounted (subscribe.host); pair it with useWsMessage('host.log', ...). */
export function useHostLog(host: string | null): void {
  const ws = useContext(WsClientContext);
  useEffect(() => (ws === null || host === null ? undefined : ws.subscribeHost(host)), [ws, host]);
}
