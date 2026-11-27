import { LIMITS, type PresenceDTO } from '@luady/shared';
import type { Clock, EventBus, SettingsService } from '../core/contracts.js';
import { sha256Hex } from '../core/ids.js';
import type { NoticeState } from './state.js';

/** How often presence re-checks itself: a tab going stale or silent, a forced hour running out. */
export const PRESENCE_TICK_MS = 15_000;
/**
 * A client that sent no frame for this long no longer counts. The website pings every 25 seconds, but browsers slow
 * the timers of a hidden tab to about once a minute, so the cutoff leaves room for that.
 */
export const PRESENCE_PING_MS = 180_000;

/** Fresh = the owner touched the page (presence.active) less than LIMITS.presenceStaleMs ago; visible or not. */
export function isFresh(client: { readonly touchedAt: number | null }, nowMs: number): boolean {
  return client.touchedAt !== null && nowMs - client.touchedAt < LIMITS.presenceStaleMs;
}

export interface PresenceService {
  /** A new socket of a signed-in session; it does not count for `online` until its first hello. */
  connect(clientId: string, sid: string): void;
  /** Visibility only: a hello (or a reconnect) is not a touch. */
  hello(clientId: string, visible: boolean): void;
  /** True once any client has ever said hello (persisted; the old website never does). */
  capable(): boolean;
  /** A socket of this signed-in session has said hello since the hub started (it runs the new website). */
  sessionSaidHello(sid: string): boolean;
  /** The owner touched the page: the only thing that keeps a session present. */
  active(clientId: string): void;
  /** Any frame from the client (ping): without one for PRESENCE_PING_MS the client is dropped. */
  seen(clientId: string): void;
  /** Acknowledgements count only from a client whose last hello said visible. */
  canAck(clientId: string): boolean;
  disconnect(clientId: string): void;
  /** true: the chat for LIMITS.presenceForceMs from now (persisted); false: clears it. */
  force(chat: boolean): PresenceDTO;
  /** "Updates: chat" in force, or the owner's /away. */
  forced(): boolean;
  state(): PresenceDTO;
  start(): void;
  stop(): void;
}

export interface PresenceDeps {
  bus: EventBus;
  clock: Clock;
  state: Pick<NoticeState, 'websiteFirst' | 'enableWebsiteFirst' | 'forcedUntil' | 'setForcedUntil'>;
  settings: Pick<SettingsService, 'get'>;
}

interface Tracked { readonly said: boolean; readonly visible: boolean; readonly session: string; readonly seenAt: number }
type Signature = Pick<PresenceDTO, 'mode' | 'online' | 'forcedUntil'>;

const sameSignature = (a: Signature, b: Signature): boolean =>
  a.mode === b.mode && a.online === b.online && a.forcedUntil === b.forcedUntil;

export function createPresenceService(deps: PresenceDeps): PresenceService {
  let clients: ReadonlyMap<string, Tracked> = new Map();
  let helloSessions: ReadonlySet<string> = new Set();
  /** Last presence.active per signed-in session: a reconnecting tab keeps its time and does not renew it. */
  let touched: ReadonlyMap<string, number> = new Map();
  let timer: ReturnType<typeof setInterval> | null = null;
  let offSettings: (() => void) | null = null;
  const nowMs = (): number => deps.clock.now().getTime();

  const forcedUntilMs = (): number | null => {
    const iso = deps.state.forcedUntil();
    return iso === null ? null : Date.parse(iso);
  };
  const isForcedHour = (now: number): boolean => (forcedUntilMs() ?? 0) > now;

  function state(): PresenceDTO {
    const now = nowMs();
    const live = [...clients.values()].filter((t) => t.said && now - t.seenAt < PRESENCE_PING_MS);
    const online = live.some((t) => isFresh({ touchedAt: touched.get(t.session) ?? null }, now));
    const forcedUntil = isForcedHour(now) ? new Date(forcedUntilMs() ?? now).toISOString() : null;
    const forced = forcedUntil !== null || deps.settings.get().away;
    return { mode: forced || !online ? 'chat' : 'here', online, clients: live.length, forcedUntil };
  }

  let last: Signature = state();

  function publish(): PresenceDTO {
    const next = state();
    if (!sameSignature(last, next)) {
      last = next;
      deps.bus.emit('presence.updated', next);
    }
    return next;
  }

  function update(clientId: string, change: (tracked: Tracked) => Tracked): void {
    const tracked = clients.get(clientId);
    if (tracked === undefined) return;
    clients = new Map([...clients, [clientId, change(tracked)]]);
    publish();
  }

  return {
    connect(clientId, sid) {
      if (!clients.has(clientId)) {
        clients = new Map([...clients, [clientId, { said: false, visible: false, session: sha256Hex(sid), seenAt: nowMs() }]]);
      }
      publish();
    },
    hello(clientId, visible) {
      const tracked = clients.get(clientId);
      if (tracked === undefined) return;
      deps.state.enableWebsiteFirst();
      helloSessions = new Set([...helloSessions, tracked.session]);
      update(clientId, (t) => ({ ...t, said: true, visible, seenAt: nowMs() }));
    },
    capable: () => deps.state.websiteFirst(),
    sessionSaidHello: (sid) => helloSessions.has(sha256Hex(sid)),
    active(clientId) {
      const tracked = clients.get(clientId);
      if (tracked === undefined) return;
      touched = new Map([...touched, [tracked.session, nowMs()]]);
      update(clientId, (t) => ({ ...t, seenAt: nowMs() }));
    },
    seen(clientId) {
      update(clientId, (t) => ({ ...t, seenAt: nowMs() }));
    },
    canAck(clientId) {
      const tracked = clients.get(clientId);
      return tracked !== undefined && tracked.said && tracked.visible && nowMs() - tracked.seenAt < PRESENCE_PING_MS;
    },
    disconnect(clientId) {
      clients = new Map([...clients].filter(([id]) => id !== clientId));
      publish();
    },
    force(chat) {
      deps.state.setForcedUntil(chat ? new Date(nowMs() + LIMITS.presenceForceMs).toISOString() : null);
      return publish();
    },
    forced: () => isForcedHour(nowMs()) || deps.settings.get().away,
    state,
    start() {
      if (timer === null) timer = setInterval(publish, PRESENCE_TICK_MS);
      offSettings ??= deps.bus.on('settings.updated', () => publish());
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      offSettings?.();
      offSettings = null;
    },
  };
}
