import WebSocket, { type RawData } from 'ws';
import {
  ADDON_CLOSE, ADDON_PROTOCOL, AddonToHubSchema, HubToAddonSchema, type AddonToHub, type ChannelState, type HubToAddon, type PanelState,
} from '@luady/shared';
import { BACKOFF, backoffDelay } from './backoff.js';

/** What the add-on says about itself in `hello`; the client adds `t` and `protocol`. */
export type Hello = Omit<Extract<AddonToHub, { t: 'hello' }>, 't' | 'protocol'>;
export type Incoming = Omit<Extract<AddonToHub, { t: 'incoming' }>, 't'>;
export type Deliver = Omit<Extract<AddonToHub, { t: 'deliver' }>, 't'>;
export type Welcome = Extract<HubToAddon, { t: 'welcome' }>;
export type HubFrame<T extends HubToAddon['t']> = Extract<HubToAddon, { t: T }>;

/** The answer of a tool call: `ok: false` carries the reason in `text`. */
export interface ToolAnswer { readonly ok: boolean; readonly text: string }

/**
 * One handler per message the hub can send. Every one is optional: an add-on handles what its kind and capabilities
 * allow. A handler may be async; frames are handled one at a time, in order.
 */
export interface AddonHandlers {
  onWelcome?(welcome: Welcome): void;
  onSend?(frame: HubFrame<'send'>): void | Promise<void>;
  onSendFile?(frame: HubFrame<'send_file'>): void | Promise<void>;
  onTyping?(frame: HubFrame<'typing'>): void | Promise<void>;
  onEdit?(frame: HubFrame<'edit'>): void | Promise<void>;
  onPin?(frame: HubFrame<'pin'>): void | Promise<void>;
  onRevoke?(frame: HubFrame<'revoke'>): void | Promise<void>;
  onPlayed?(frame: HubFrame<'played'>): void | Promise<void>;
  onProfile?(frame: HubFrame<'profile'>): void | Promise<void>;
  onUnlink?(frame: HubFrame<'unlink'>): void | Promise<void>;
  onUiAction?(frame: HubFrame<'ui.action'>): void | Promise<void>;
  /** The answer is sent back as `tool.result`; a throw answers `ok: false` with its message. */
  onToolCall?(frame: HubFrame<'tool.call'>): ToolAnswer | Promise<ToolAnswer>;
  onDelivered?(frame: HubFrame<'delivered'>): void | Promise<void>;
  /** After `hello`, the buffer flush and the status, on every (re)connect. */
  onConnected?(): void;
  /** The hub closed the link for good: 4001 (protocol mismatch) or 4000 (a newer copy of this add-on connected). */
  onStopped?(code: number): void;
}

export interface AddonLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
  error(data: object, message: string): void;
}

export interface AddonClientOptions {
  /** The add-on's id, as declared in the hub's config.json `addons[]`. */
  readonly id: string;
  /** The add-on's own token: the content of `<dataDir>/addons/<id>.token`. Never logged. */
  readonly token: string;
  /** The hub's Unix socket, `<runDir>/hub.sock`. */
  readonly socketPath?: string;
  /** Instead of the socket: a `ws://host:port` stand-in (tests). */
  readonly url?: string;
  readonly hello: Hello;
  readonly handlers: AddonHandlers;
  readonly log?: AddonLogger;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly bufferMax?: number;
}

export interface AddonClient {
  start(): void;
  stop(): Promise<void>;
  isConnected(): boolean;
  /** Frames waiting for the next connection. */
  buffered(): number;
  /** The hub's last welcome (the owner, the manager's name), or null before the first one. */
  welcome(): Welcome | null;
  /** Remembers the state and sends it now when connected; it is sent again after every reconnect, never buffered. */
  status(state: ChannelState, detail: string | null, panel?: PanelState): boolean;
  incoming(message: Incoming): boolean;
  /** The answer to a hub `send`, `send_file` or `edit`: the chat's message id, or the error. */
  sent(ref: string, msgId: string | null, error: string | null): boolean;
  deliver(message: Deliver): boolean;
  /** Any add-on frame, checked with the shared schema first. False when it was refused. */
  send(frame: AddonToHub): boolean;
}

/** Frames kept while the hub is away (the oldest go first when full). `status` and `hello` are never kept. */
export const BUFFER_MAX = 500;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 2000;
const FATAL_CLOSES: ReadonlySet<number> = new Set([ADDON_CLOSE.protocolMismatch, ADDON_CLOSE.replaced]);

const consoleLog: AddonLogger = {
  info: (data, message) => console.log(message, data),
  warn: (data, message) => console.warn(message, data),
  error: (data, message) => console.error(message, data),
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The URL of the add-on route: over the Unix socket in production, or under a TCP stand-in. */
export function addonUrl(id: string, where: { socketPath?: string; url?: string }): string {
  const path = `/internal/addon/${encodeURIComponent(id)}`;
  if (where.url !== undefined) return `${where.url.replace(/\/$/, '')}${path}`;
  if (where.socketPath === undefined) throw new Error('addon-sdk: give socketPath (the hub socket) or url');
  return `ws+unix://${where.socketPath}:${path}`;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** One hub frame, checked with the shared schema; null for anything else. */
export function parseHubFrame(text: string): HubToAddon | null {
  try {
    const parsed = HubToAddonSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

class Connection implements AddonClient {
  readonly #opts: AddonClientOptions;
  readonly #log: AddonLogger;
  readonly #url: string;
  #ws: WebSocket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #attempt = 0;
  #stopped = true;
  #buffer: readonly AddonToHub[] = [];
  #status: Extract<AddonToHub, { t: 'status' }> | null = null;
  #welcome: Welcome | null = null;
  #work: Promise<void> = Promise.resolve();

  constructor(opts: AddonClientOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? consoleLog;
    this.#url = addonUrl(opts.id, opts);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const socket = this.#ws;
    this.#ws = null;
    if (socket !== null) await closeSocket(socket);
  }

  isConnected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  buffered(): number {
    return this.#buffer.length;
  }

  welcome(): Welcome | null {
    return this.#welcome;
  }

  status(state: ChannelState, detail: string | null, panel?: PanelState): boolean {
    const frame = { t: 'status' as const, state, detail, ...(panel === undefined ? {} : { panel }) };
    if (!this.#valid(frame)) return false;
    this.#status = frame;
    return this.#sendNow(frame);
  }

  incoming(message: Incoming): boolean {
    return this.send({ t: 'incoming', ...message });
  }

  sent(ref: string, msgId: string | null, error: string | null): boolean {
    return this.send({ t: 'sent', ref, msgId, error });
  }

  deliver(message: Deliver): boolean {
    return this.send({ t: 'deliver', ...message });
  }

  send(frame: AddonToHub): boolean {
    if (!this.#valid(frame)) return false;
    if (frame.t === 'status') return this.status(frame.state, frame.detail, frame.panel);
    if (frame.t === 'hello') return false;
    if (this.#sendNow(frame)) return true;
    this.#keep(frame, false);
    return true;
  }

  #valid(frame: AddonToHub): boolean {
    const parsed = AddonToHubSchema.safeParse(frame);
    if (parsed.success) return true;
    this.#log.error({ t: frame.t, issues: parsed.error.issues.map((issue) => issue.path.join('.')) }, 'addon-sdk: refused an invalid frame');
    return false;
  }

  #sendNow(frame: AddonToHub): boolean {
    const socket = this.#ws;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    this.#write(socket, frame);
    return true;
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.#url, { headers: { authorization: `Bearer ${this.#opts.token}` }, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    this.#ws = socket;
    socket.on('open', () => this.#onOpen(socket));
    socket.on('message', (data: RawData) => this.#onFrame(socket, data));
    socket.on('error', (err: Error) => this.#log.warn({ err: err.message }, 'addon-sdk: hub socket error'));
    socket.on('close', (code: number) => this.#onClose(socket, code));
  }

  #onOpen(socket: WebSocket): void {
    if (this.#ws !== socket) return;
    this.#attempt = 0;
    this.#write(socket, { t: 'hello', protocol: ADDON_PROTOCOL, ...this.#opts.hello });
    const pending = this.#buffer;
    this.#buffer = [];
    for (const frame of pending) this.#write(socket, frame);
    if (this.#status !== null) this.#write(socket, this.#status);
    this.#log.info({ flushed: pending.length }, 'addon-sdk: connected to the hub');
    try {
      this.#opts.handlers.onConnected?.();
    } catch (err) {
      this.#log.error({ err: errorText(err) }, 'addon-sdk: onConnected failed');
    }
  }

  #onClose(socket: WebSocket, code: number): void {
    if (this.#ws !== socket) return;
    this.#ws = null;
    if (FATAL_CLOSES.has(code)) {
      this.#stopped = true;
      this.#log.error({ code }, code === ADDON_CLOSE.replaced
        ? 'addon-sdk: a newer copy of this add-on connected; this one stops'
        : 'addon-sdk: the hub speaks another protocol version; this add-on stops');
      this.#opts.handlers.onStopped?.(code);
      return;
    }
    if (this.#stopped || this.#timer !== null) return;
    const delay = backoffDelay(this.#attempt, this.#opts.initialBackoffMs ?? BACKOFF.initialMs, this.#opts.maxBackoffMs ?? BACKOFF.maxMs);
    this.#attempt += 1;
    this.#log.info({ delayMs: delay }, 'addon-sdk: hub link down; reconnecting');
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, delay);
  }

  #onFrame(socket: WebSocket, data: RawData): void {
    if (this.#ws !== socket) return;
    const frame = parseHubFrame(rawText(data));
    if (frame === null) {
      this.#log.warn({ bytes: rawText(data).length }, 'addon-sdk: ignored an invalid frame from the hub');
      return;
    }
    this.#work = this.#work.then(() => this.#handle(frame));
  }

  async #handle(frame: HubToAddon): Promise<void> {
    const h = this.#opts.handlers;
    try {
      switch (frame.t) {
        case 'welcome':
          this.#welcome = frame;
          h.onWelcome?.(frame);
          return;
        case 'send': return await h.onSend?.(frame);
        case 'send_file': return await h.onSendFile?.(frame);
        case 'typing': return await h.onTyping?.(frame);
        case 'edit': return await h.onEdit?.(frame);
        case 'pin': return await h.onPin?.(frame);
        case 'revoke': return await h.onRevoke?.(frame);
        case 'played': return await h.onPlayed?.(frame);
        case 'profile': return await h.onProfile?.(frame);
        case 'unlink': return await h.onUnlink?.(frame);
        case 'ui.action': return await h.onUiAction?.(frame);
        case 'delivered': return await h.onDelivered?.(frame);
        case 'tool.call': return this.#answer(frame);
      }
    } catch (err) {
      this.#log.error({ err: errorText(err), t: frame.t }, 'addon-sdk: a handler failed');
    }
  }

  async #answer(call: HubFrame<'tool.call'>): Promise<void> {
    const handler = this.#opts.handlers.onToolCall;
    let answer: ToolAnswer;
    try {
      answer = handler === undefined ? { ok: false, text: `This add-on has no tool ${call.name}` } : await handler(call);
    } catch (err) {
      answer = { ok: false, text: errorText(err) };
    }
    this.send({ t: 'tool.result', callId: call.callId, ok: answer.ok, text: answer.text });
  }

  #write(socket: WebSocket, frame: AddonToHub): void {
    socket.send(JSON.stringify(frame), (err?: Error) => {
      if (err === undefined || err === null) return;
      this.#log.warn({ err: err.message, t: frame.t }, 'addon-sdk: hub write failed');
      if (frame.t !== 'status' && frame.t !== 'hello') this.#keep(frame, true);
    });
  }

  #keep(frame: AddonToHub, front: boolean): void {
    const next = front ? [frame, ...this.#buffer] : [...this.#buffer, frame];
    const max = this.#opts.bufferMax ?? BUFFER_MAX;
    const overflow = next.length - max;
    this.#buffer = overflow > 0 ? next.slice(overflow) : next;
    if (overflow > 0) this.#log.warn({ dropped: overflow }, 'addon-sdk: buffer full; dropped the oldest frames');
  }
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, CLOSE_WAIT_MS);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1000, 'add-on stopping');
  });
}

/** A client for Add-on Protocol v1: connects, says hello, keeps frames while the hub is away and reconnects by itself. */
export function createAddonClient(opts: AddonClientOptions): AddonClient {
  return new Connection(opts);
}
