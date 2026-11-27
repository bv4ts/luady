import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import {
  ADDON_CLOSE, ADDON_PROTOCOL, AddonToHubSchema, HubToAddonSchema, isAddonId, managerName,
  type AddonToHub, type Capabilities, type ChannelInfoDTO, type ChannelState, type HubToAddon, type PanelBlock, type PanelSpec,
} from '@luady/shared';
import type { Clock, EventBus, Logger } from '../core/contracts.js';
import type { AddonDecl, AddonRegistry } from './addons-file.js';

/** The add-on route on the internal socket. Its own token guards it, never the hub token. */
export const ADDON_PATH_PREFIX = '/internal/addon/';
/** An add-on that says nothing for this long after connecting is closed (4001). */
export const HELLO_TIMEOUT_MS = 10_000;
/** The biggest frame an add-on may send (20 tools of 16 KB fit; files go by path, never inline). */
export const FRAME_MAX_BYTES = 1024 * 1024;
/** Per connection: a burst of 200 frames, then 50 a second; an add-on that keeps flooding past 2000 drops is closed. */
export const FRAME_RATE = { burst: 200, perSecond: 50, closeAfterDrops: 2000 } as const;
/** Invalid frames (bad JSON or schema, too big, not allowed for the kind) a connection may send before it is closed. */
export const INVALID_FRAMES_MAX = 20;
const POLICY_CLOSE = 1008;
const GOING_AWAY = 1001;
const WS_OPEN = 1;

export type HelloFrame = Extract<AddonToHub, { t: 'hello' }>;
export type IncomingFrame = Extract<AddonToHub, { t: 'incoming' }>;
export type SentFrame = Extract<AddonToHub, { t: 'sent' }>;
export type ToolResultFrame = Extract<AddonToHub, { t: 'tool.result' }>;
export type DeliverFrame = Extract<AddonToHub, { t: 'deliver' }>;

/** What a frame may be, by the add-on's declared kind: a `tools` add-on never speaks for the owner. */
const ALLOWED: Readonly<Record<AddonDecl['kind'], ReadonlySet<AddonToHub['t']>>> = {
  channel: new Set(['status', 'incoming', 'sent', 'tool.result', 'deliver']),
  tools: new Set(['tool.result', 'deliver']),
};

/** The socket the add-on route hands over (ws). */
export interface AddonSocket {
  readonly readyState: number;
  send(data: string, callback?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** One live add-on connection, as the rest of the hub sees it. */
export interface AddonLink {
  readonly decl: AddonDecl;
  /** Said hello, and its socket is open. */
  ready(): boolean;
  state(): ChannelState | 'absent';
  capabilities(): Capabilities | null;
  hello(): HelloFrame | null;
  /** Sends one frame (checked with the shared schema); false when the link is not ready. */
  send(frame: HubToAddon): boolean;
}

/** What the rest of the hub hears; every callback is called for one add-on id at a time and never sees another's frames. */
export interface HostListener {
  hello?(id: string, hello: HelloFrame): void;
  status?(id: string, state: ChannelState): void;
  /** The add-on's state became `up` (from anything else). */
  up?(id: string): void;
  /** Its connection closed (a replacement is not a close). */
  gone?(id: string): void;
  /** An owner message that passed the owner gate. */
  incoming?(id: string, frame: IncomingFrame): void | Promise<void>;
  sent?(id: string, frame: SentFrame): void;
  toolResult?(id: string, frame: ToolResultFrame): void;
  deliver?(id: string, frame: DeliverFrame): void | Promise<void>;
}

export interface ChannelHost {
  /** The internal-server plugin: `GET /internal/addon/:id` as a WebSocket, behind the add-on's own token. */
  route(): FastifyPluginAsync;
  /** Takes an authenticated socket for a declared add-on; a newer one replaces the older (4000). */
  attach(id: string, socket: AddonSocket): void;
  link(id: string): AddonLink | null;
  /** One entry per declared add-on: data only, never a token. */
  list(): ChannelInfoDTO[];
  info(id: string): ChannelInfoDTO | null;
  /** The panel block (input or button) that carries `action`, or null when the add-on's panel has none. */
  panelBlock(id: string, action: string): Extract<PanelBlock, { type: 'input' | 'button' }> | null;
  subscribe(listener: HostListener): () => void;
  /** Closes every connection (1001). */
  stop(): void;
}

export interface ChannelHostDeps {
  addons: AddonRegistry;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** The time base of the frame rate limit; real time when absent. */
  now?: () => number;
}

interface Conn {
  readonly id: string;
  readonly socket: AddonSocket;
  hello: HelloFrame | null;
  state: ChannelState;
  detail: string | null;
  panelBlocks: readonly PanelBlock[] | null;
  since: string;
  tokens: number;
  refilledAt: number;
  dropped: number;
  strangers: number;
  /** Invalid frames since hello; the first one is logged, the rest only counted. */
  invalid: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

let hubVersion: string | null = null;
/** The hub's package version, for `welcome` (read once). */
function versionOfHub(): string {
  if (hubVersion !== null) return hubVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    hubVersion = typeof pkg.version === 'string' ? pkg.version.slice(0, 64) : 'unknown';
  } catch {
    hubVersion = 'unknown';
  }
  return hubVersion;
}

function rawText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

function parse(text: string): { ok: true; frame: AddonToHub } | { ok: false; issues: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: 1 };
  }
  const parsed = AddonToHubSchema.safeParse(raw);
  return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, issues: parsed.error.issues.length };
}

/**
 * The channel host: every add-on connection, checked the same way. A frame is one JSON object checked with the shared
 * schemas; the first one must be `hello` with protocol 1 and the declared kind; frames are size- and rate-limited; a
 * frame is accepted only when the add-on's kind allows it; an owner message passes only from the declared owner.
 * Nothing an add-on sends is ever logged with its content.
 */
export function createChannelHost(deps: ChannelHostDeps): ChannelHost {
  const now = deps.now ?? Date.now;
  let conns: ReadonlyMap<string, Conn> = new Map();
  let listeners: readonly HostListener[] = [];
  const log = deps.log;

  const isoNow = (): string => deps.clock.now().toISOString();

  function notify(run: (listener: HostListener) => unknown, what: string, id: string): void {
    for (const listener of listeners) {
      try {
        const result = run(listener);
        if (result instanceof Promise) result.catch((err: unknown) => log.error({ err, addon: id, what }, 'addons: a listener failed'));
      } catch (err) {
        log.error({ err, addon: id, what }, 'addons: a listener failed');
      }
    }
  }

  function current(id: string): Conn | null {
    return conns.get(id) ?? null;
  }

  function isOpen(conn: Conn): boolean {
    return conn.socket.readyState === WS_OPEN;
  }

  function panelOf(decl: AddonDecl, conn: Conn | null): PanelSpec | null {
    const spec = conn?.hello?.panel ?? null;
    const blocks = conn?.panelBlocks ?? null;
    if (spec === null && blocks === null) return null;
    return { title: spec?.title ?? decl.name.slice(0, 80), blocks: [...(blocks ?? spec?.blocks ?? [])] };
  }

  function infoOf(decl: AddonDecl): ChannelInfoDTO {
    const conn = current(decl.id);
    const live = conn !== null && conn.hello !== null;
    return {
      id: decl.id, kind: decl.kind, name: decl.name.slice(0, 80),
      state: live ? conn.state : 'absent', detail: live ? conn.detail : null, since: conn?.since ?? null,
      primary: deps.addons.primary()?.id === decl.id,
      capabilities: live ? conn.hello?.capabilities ?? null : null,
      panel: live ? panelOf(decl, conn) : null,
    };
  }

  function emit(id: string): void {
    const decl = deps.addons.get(id);
    if (decl !== undefined) deps.bus.emit('channel.status', { channel: infoOf(decl) });
  }

  function close(conn: Conn, code: number, reason: string): void {
    try {
      conn.socket.close(code, reason);
    } catch (err) {
      log.warn({ err, addon: conn.id }, 'addons: closing a socket failed');
    }
  }

  function transmit(conn: Conn, frame: HubToAddon): boolean {
    if (!isOpen(conn)) return false;
    const checked = HubToAddonSchema.safeParse(frame);
    if (!checked.success) {
      log.error({ addon: conn.id, t: frame.t, issues: checked.error.issues.length }, 'addons: refused to send an invalid frame');
      return false;
    }
    conn.socket.send(JSON.stringify(checked.data), (err?: Error) => {
      if (err) log.warn({ err: err.message, addon: conn.id, t: frame.t }, 'addons: a frame could not be sent');
    });
    return true;
  }

  /** A token bucket per connection; true when this frame may pass. */
  function admit(conn: Conn): boolean {
    const at = now();
    conn.tokens = Math.min(FRAME_RATE.burst, conn.tokens + ((at - conn.refilledAt) / 1000) * FRAME_RATE.perSecond);
    conn.refilledAt = at;
    if (conn.tokens >= 1) {
      conn.tokens -= 1;
      return true;
    }
    conn.dropped += 1;
    if (conn.dropped === 1 || conn.dropped % 500 === 0) log.warn({ addon: conn.id, dropped: conn.dropped }, 'addons: frames over the rate limit dropped');
    if (conn.dropped >= FRAME_RATE.closeAfterDrops) close(conn, POLICY_CLOSE, 'too many frames');
    return false;
  }

  function onHello(conn: Conn, decl: AddonDecl, hello: HelloFrame): void {
    if (hello.protocol !== ADDON_PROTOCOL) {
      log.warn({ addon: conn.id, protocol: hello.protocol }, 'addons: protocol mismatch');
      close(conn, ADDON_CLOSE.protocolMismatch, `this hub speaks protocol ${ADDON_PROTOCOL}`);
      return;
    }
    if (hello.kind !== decl.kind) {
      log.warn({ addon: conn.id, declared: decl.kind, said: hello.kind }, 'addons: hello kind differs from the config');
      close(conn, ADDON_CLOSE.protocolMismatch, `declared as a ${decl.kind} add-on`);
      return;
    }
    if (conn.helloTimer !== null) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conn.hello = hello;
    // A tools add-on has no link of its own to bring up: it is up once it said hello.
    conn.state = decl.kind === 'tools' ? 'up' : 'starting';
    conn.since = isoNow();
    transmit(conn, {
      t: 'welcome', protocol: ADDON_PROTOCOL, hub: versionOfHub(), manager: { name: managerName().slice(0, 40) },
      owner: decl.kind === 'channel' ? decl.owner : null,
    });
    log.info({ addon: conn.id, kind: hello.kind, version: hello.version, tools: hello.tools?.length ?? 0 }, 'addons: add-on said hello');
    notify((l) => l.hello?.(conn.id, hello), 'hello', conn.id);
    if (conn.state === 'up') notify((l) => l.up?.(conn.id), 'up', conn.id);
    emit(conn.id);
  }

  /** An invalid frame: logged once per connection with what was wrong (never the content), then counted; too many close it. */
  function invalidFrame(conn: Conn, what: string, data: object): void {
    conn.invalid += 1;
    if (conn.invalid === 1) log.warn({ addon: conn.id, what, ...data }, 'addons: an invalid frame was dropped (further ones are only counted)');
    if (conn.invalid >= INVALID_FRAMES_MAX) {
      log.warn({ addon: conn.id, invalid: conn.invalid }, 'addons: too many invalid frames; closing');
      close(conn, POLICY_CLOSE, 'too many invalid frames');
    }
  }

  function onStatus(conn: Conn, frame: Extract<AddonToHub, { t: 'status' }>): void {
    const before = conn.state;
    if (frame.state !== before) conn.since = isoNow();
    conn.state = frame.state;
    conn.detail = frame.detail;
    if (frame.panel !== undefined) conn.panelBlocks = frame.panel.blocks;
    notify((l) => l.status?.(conn.id, frame.state), 'status', conn.id);
    if (frame.state === 'up' && before !== 'up') notify((l) => l.up?.(conn.id), 'up', conn.id);
    emit(conn.id);
  }

  function onIncoming(conn: Conn, decl: AddonDecl, frame: IncomingFrame): void {
    // The owner gate, again in the hub: the add-on applies it too.
    if (decl.owner === null || frame.from !== decl.owner) {
      conn.strangers += 1;
      log.warn({ addon: conn.id, msgId: frame.msgId, dropped: conn.strangers }, 'addons: dropped a message that is not from the owner');
      return;
    }
    notify((l) => l.incoming?.(conn.id, frame), 'incoming', conn.id);
  }

  function dispatch(conn: Conn, decl: AddonDecl, frame: AddonToHub): void {
    if (frame.t === 'hello') {
      close(conn, ADDON_CLOSE.protocolMismatch, 'hello comes once per connection');
      return;
    }
    if (!ALLOWED[decl.kind].has(frame.t)) {
      invalidFrame(conn, 'not allowed for its kind', { t: frame.t, kind: decl.kind });
      return;
    }
    switch (frame.t) {
      case 'status':
        return onStatus(conn, frame);
      case 'incoming':
        return onIncoming(conn, decl, frame);
      case 'sent':
        return notify((l) => l.sent?.(conn.id, frame), 'sent', conn.id);
      case 'tool.result':
        return notify((l) => l.toolResult?.(conn.id, frame), 'tool.result', conn.id);
      case 'deliver':
        return notify((l) => l.deliver?.(conn.id, frame), 'deliver', conn.id);
    }
  }

  function onFrame(conn: Conn, data: unknown): void {
    if (current(conn.id) !== conn) return;
    const decl = deps.addons.get(conn.id);
    if (decl === undefined) return;
    const text = rawText(data);
    if (Buffer.byteLength(text, 'utf8') > FRAME_MAX_BYTES) {
      invalidFrame(conn, 'over 1 MB', { bytes: text.length });
      return;
    }
    if (!admit(conn)) return;
    const parsed = parse(text);
    if (!parsed.ok) {
      if (conn.hello === null) {
        log.warn({ addon: conn.id, bytes: text.length, issues: parsed.issues }, 'addons: the first frame failed validation');
        close(conn, ADDON_CLOSE.protocolMismatch, 'the first frame must be a valid hello');
        return;
      }
      invalidFrame(conn, 'failed validation', { bytes: text.length, issues: parsed.issues });
      return;
    }
    if (conn.hello === null) {
      if (parsed.frame.t !== 'hello') close(conn, ADDON_CLOSE.protocolMismatch, 'the first frame must be hello');
      else onHello(conn, decl, parsed.frame);
      return;
    }
    dispatch(conn, decl, parsed.frame);
  }

  function onClose(conn: Conn): void {
    if (conn.helloTimer !== null) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    if (current(conn.id) !== conn) return;
    conns = new Map([...conns].filter(([id]) => id !== conn.id));
    log.info({ addon: conn.id }, 'addons: add-on disconnected');
    notify((l) => l.gone?.(conn.id), 'gone', conn.id);
    emit(conn.id);
  }

  function attach(id: string, socket: AddonSocket): void {
    if (deps.addons.get(id) === undefined) {
      socket.close(POLICY_CLOSE, 'unknown add-on');
      return;
    }
    const previous = current(id);
    const conn: Conn = {
      id, socket, hello: null, state: 'starting', detail: null, panelBlocks: null, since: isoNow(),
      tokens: FRAME_RATE.burst, refilledAt: now(), dropped: 0, strangers: 0, invalid: 0, helloTimer: null,
    };
    conns = new Map([...conns, [id, conn]]);
    if (previous !== null) {
      if (previous.helloTimer !== null) clearTimeout(previous.helloTimer);
      close(previous, ADDON_CLOSE.replaced, 'replaced by a newer connection');
      log.info({ addon: id }, 'addons: a newer connection replaced the older one');
    }
    conn.helloTimer = setTimeout(() => {
      if (conn.hello === null) close(conn, ADDON_CLOSE.protocolMismatch, 'no hello');
    }, HELLO_TIMEOUT_MS);
    conn.helloTimer.unref?.();
    socket.on('message', ((data: unknown) => onFrame(conn, data)) as (...args: never[]) => void);
    socket.on('close', (() => onClose(conn)) as (...args: never[]) => void);
    socket.on('error', ((err: Error) => log.warn({ err: err.message, addon: id }, 'addons: socket error')) as (...args: never[]) => void);
    log.info({ addon: id }, 'addons: add-on connected');
    emit(id);
  }

  function linkOf(conn: Conn, decl: AddonDecl): AddonLink {
    return {
      decl,
      ready: () => current(decl.id) === conn && conn.hello !== null && isOpen(conn),
      state: () => (current(decl.id) === conn && conn.hello !== null ? conn.state : 'absent'),
      capabilities: () => conn.hello?.capabilities ?? null,
      hello: () => conn.hello,
      send: (frame) => current(decl.id) === conn && conn.hello !== null && transmit(conn, frame),
    };
  }

  const route = (): FastifyPluginAsync => async (app) => {
    app.get<{ Params: { id: string } }>(`${ADDON_PATH_PREFIX}:id`, {
      websocket: true,
      // Before the upgrade: an id that is not declared is 404, a wrong token 401; neither says more.
      preValidation: async (request, reply) => {
        const { id } = request.params;
        if (!isAddonId(id) || deps.addons.get(id) === undefined) return reply.code(404).send({ ok: false, error: 'not found' });
        if (!deps.addons.tokenMatches(id, request.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
      },
    }, (socket, request) => {
      attach(request.params.id, socket as unknown as AddonSocket);
    });
  };

  return {
    route,
    attach,
    link(id) {
      const conn = current(id);
      const decl = deps.addons.get(id);
      return conn === null || decl === undefined ? null : linkOf(conn, decl);
    },
    list: () => deps.addons.list().map(infoOf),
    info(id) {
      const decl = deps.addons.get(id);
      return decl === undefined ? null : infoOf(decl);
    },
    panelBlock(id, action) {
      const decl = deps.addons.get(id);
      const panel = decl === undefined ? null : panelOf(decl, current(id));
      const block = panel?.blocks.find((b) => (b.type === 'input' || b.type === 'button') && b.action === action);
      return block !== undefined && (block.type === 'input' || block.type === 'button') ? block : null;
    },
    subscribe(listener) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    stop() {
      for (const conn of conns.values()) {
        if (conn.helloTimer !== null) clearTimeout(conn.helloTimer);
        close(conn, GOING_AWAY, 'hub stopping');
      }
    },
  };
}
