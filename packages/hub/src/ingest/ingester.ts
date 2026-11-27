import {
  ActivitySpoolEventSchema, SpoolEventSchema, TailLineSchema, isActivityEventName, isSelfHost,
  type ActivitySpoolEvent, type HostId, type SpoolEvent,
} from '@luady/shared';
import type { Clock, Db, EventBus, Fleet, Logger } from '../core/contracts.js';
import { sessionIdForEvent } from '../sessions/naming.js';
import { createOffsetsRepo, positionToFrom, type OffsetsRepo, type TailPosition } from './offsets.js';

/** Receives the six kit-2 activity kinds; they never reach the `events` table, the bus or the session reducer. */
export interface ActivitySink {
  accept(host: HostId, event: ActivitySpoolEvent, replay: boolean): void;
}

export interface IngesterDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  fleet: Fleet;
  log: Logger;
  /**
   * The hosts to tail: a function of the fleet, read at the start and again whenever the rooms,
   * the hosts or the manager's status change, so a host added or a manager switched on at run time is tailed at
   * once and one gone is let go.
   */
  hosts: () => readonly HostId[];
  activity?: ActivitySink;
}

/** The events after which the host list is read again. */
export const HOST_LIST_EVENTS = ['rooms.changed', 'hosts.changed', 'manager.status'] as const;

export const OFFSET_FLUSH_MS = 1_000;
export const REPLAY_AGE_MS = 10 * 60_000;
export const TAIL_RESTART_INITIAL_MS = 1_000;
export const TAIL_RESTART_MAX_MS = 30_000;

type TailHandle = ReturnType<Fleet['tailEvents']>;

/**
 * Where a host's stream starts when no offset is stored. A server's spool may hold a long history from before the hub
 * knew it: it is followed from its end. The manager's own spool starts with it, and its first session start is written
 * while its stream is still coming up (the manager is switched on, set up and launched within a second, its stream
 * restarts a moment later): it is read from the start, so the manager is seen running at once.
 */
function firstFrom(host: HostId, stored: TailPosition | undefined): string {
  return stored === undefined && isSelfHost(host) ? 'start' : positionToFrom(stored);
}

export type TailRecord =
  | { kind: 'heartbeat' }
  | { kind: 'event'; position: TailPosition; event: unknown }
  | { kind: 'invalid'; reason: string };

export function parseTailLine(line: string): TailRecord {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  const parsed = TailLineSchema.safeParse(json);
  if (!parsed.success) return { kind: 'invalid', reason: 'not a tail-events line' };
  if ('heartbeat' in parsed.data) return { kind: 'heartbeat' };
  return { kind: 'event', position: { file: parsed.data.file, offset: parsed.data.offset }, event: parsed.data.event };
}

/** The copy kept in `events.payload_json`: a permission preview lives only in its question row (deleted on close). */
export function forStorage(event: SpoolEvent): SpoolEvent {
  if (event.event !== 'permission' || event.data.preview === undefined) return event;
  const { preview: _preview, ...data } = event.data;
  return { ...event, data };
}

/** A `permission` record without its `data.preview`, or null for anything else. */
function withoutPreview(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || eventName(raw) !== 'permission' || !('data' in raw)) return null;
  const data = raw.data;
  if (typeof data !== 'object' || data === null || !('preview' in data)) return null;
  const { preview: _preview, ...rest } = data;
  return { ...raw, data: rest };
}

function eventName(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null && 'event' in raw ? raw.event : undefined;
}

/** An event older than REPLAY_AGE_MS arrived late (an outage, a restart): it must not look live. */
function isReplay(clock: Clock, ts: string): boolean {
  return clock.now().getTime() - Date.parse(ts) > REPLAY_AGE_MS;
}

/** 1 s after a stream that delivered lines; doubling per empty restart, capped at 30 s. */
export function restartDelay(failures: number): number {
  return Math.min(TAIL_RESTART_MAX_MS, TAIL_RESTART_INITIAL_MS * 2 ** Math.min(failures, 10));
}

interface EventSink {
  /** Parses one line; stores and emits a new event; returns the position the line reached, if any. */
  accept(host: HostId, line: string): TailPosition | null;
  flush(): void;
}

function createEventSink(deps: IngesterDeps, offsets: OffsetsRepo): EventSink {
  const insert = deps.db.prepare(
    'INSERT OR IGNORE INTO events (id, host, session_id, type, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const dirty = new Map<HostId, TailPosition>();

  function store(host: HostId, event: SpoolEvent): void {
    const ts = new Date(event.ts).toISOString();
    const result = insert.run(event.id, host, sessionIdForEvent(host, event), event.event, ts, JSON.stringify(forStorage(event)));
    if (result.changes !== 1) return;
    deps.bus.emit('spool.event', { host, event, replay: isReplay(deps.clock, ts) });
  }

  /** Fast path: parse and hand over; no SQL, no bus. Without a sink the line is skipped silently. */
  function forward(host: HostId, raw: unknown, position: TailPosition): void {
    if (deps.activity === undefined) return;
    const event = ActivitySpoolEventSchema.safeParse(raw);
    if (!event.success) {
      deps.log.warn({ host, at: positionToFrom(position), issue: event.error.issues[0]?.message, kind: 'activity' }, 'skipping invalid spool event');
      return;
    }
    try {
      deps.activity.accept(host, event.data, isReplay(deps.clock, event.data.ts));
    } catch (err) {
      deps.log.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'activity event not applied');
    }
  }

  function ingest(host: HostId, raw: unknown, position: TailPosition): void {
    const event = SpoolEventSchema.safeParse(raw);
    if (event.success) {
      store(host, event.data);
      return;
    }
    const issue = event.error.issues[0]?.message;
    // A malformed preview must never cost the owner the question: keep the request without it.
    const rescued = SpoolEventSchema.safeParse(withoutPreview(raw));
    if (rescued.success) {
      deps.log.warn({ host, at: positionToFrom(position), issue }, 'dropping an invalid permission preview; the request is kept');
      store(host, rescued.data);
      return;
    }
    deps.log.warn({ host, at: positionToFrom(position), issue }, 'skipping invalid spool event');
  }

  return {
    accept(host, line) {
      const record = parseTailLine(line);
      if (record.kind === 'heartbeat') return null;
      if (record.kind === 'invalid') {
        deps.log.warn({ host, reason: record.reason }, 'skipping invalid tail-events line');
        return null;
      }
      dirty.set(host, record.position);
      if (isActivityEventName(eventName(record.event))) forward(host, record.event, record.position);
      else ingest(host, record.event, record.position);
      return record.position;
    },
    flush() {
      if (dirty.size === 0) return;
      offsets.saveAll([...dirty.entries()]);
      dirty.clear();
    },
  };
}

/**
 * One `tail-events` stream per host: dedupe by events.id, offsets flushed every second, restart on end. `refresh()`
 * reads the host list again: new hosts are tailed, hosts no longer listed are stopped and not restarted.
 */
export function createIngester(deps: IngesterDeps): { start(): void; stop(): Promise<void>; refresh(): void } {
  const offsets = createOffsetsRepo(deps.db);
  const sink = createEventSink(deps, offsets);
  const positions = new Map<HostId, string>();
  const failures = new Map<HostId, number>();
  const handles = new Map<HostId, TailHandle>();
  const timers = new Map<HostId, ReturnType<typeof setTimeout>>();
  /** The hosts being tailed now (streaming, or waiting to restart). */
  let active: ReadonlySet<HostId> = new Set();
  let offs: ReadonlyArray<() => void> = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function finished(host: HostId, handle: TailHandle | null, delivered: boolean): void {
    if (handles.get(host) === handle) handles.delete(host);
    if (!running || !active.has(host)) return;
    const count = delivered ? 0 : (failures.get(host) ?? 0) + 1;
    failures.set(host, count);
    const delay = restartDelay(count);
    deps.log.info({ host, delay }, 'tail-events ended; restarting');
    timers.set(host, setTimeout(() => {
      timers.delete(host);
      launch(host);
    }, delay));
  }

  function launch(host: HostId): void {
    if (!running || !active.has(host)) return;
    let delivered = false;
    const onLine = (line: string): void => {
      delivered = true;
      const position = sink.accept(host, line);
      if (position !== null) positions.set(host, positionToFrom(position));
    };
    try {
      const handle = deps.fleet.tailEvents(host, positions.get(host) ?? firstFrom(host, undefined), onLine);
      handles.set(host, handle);
      void handle.done.then(
        () => finished(host, handle, delivered),
        (err: unknown) => {
          deps.log.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'tail-events stream failed');
          finished(host, handle, delivered);
        },
      );
    } catch (err) {
      deps.log.error({ host, err: err instanceof Error ? err.message : String(err) }, 'cannot start tail-events');
      finished(host, null, false);
    }
  }

  async function stopStreams(): Promise<void> {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const open = [...handles.values()];
    handles.clear();
    for (const handle of open) handle.stop();
    await Promise.all(open.map((handle) => handle.done.catch((err: unknown) => deps.log.debug({ err: String(err) }, 'tail stop error'))));
  }

  /** Stops one host's stream (and its pending restart); it is not restarted while it stays off the list. */
  function release(host: HostId): void {
    const timer = timers.get(host);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(host);
    const handle = handles.get(host);
    handles.delete(host);
    if (handle !== undefined) {
      handle.stop();
      void handle.done.catch((err: unknown) => deps.log.debug({ host, err: String(err) }, 'tail stop error'));
    }
    deps.log.info({ host }, 'tail-events: host no longer listed; stopped');
  }

  /** Reads the host list again: tails the hosts that joined, lets go of the hosts that left. */
  function refresh(): void {
    if (!running) return;
    const wanted = new Set(deps.hosts());
    const joined = [...wanted].filter((host) => !active.has(host));
    const left = [...active].filter((host) => !wanted.has(host));
    active = wanted;
    for (const host of left) release(host);
    for (const host of joined) {
      positions.set(host, positions.get(host) ?? firstFrom(host, offsets.get(host)));
      failures.set(host, 0);
      launch(host);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      refresh();
      offs = HOST_LIST_EVENTS.map((name) => deps.bus.on(name, () => refresh()));
      flushTimer = setInterval(() => sink.flush(), OFFSET_FLUSH_MS);
    },
    refresh,
    async stop() {
      if (!running) return;
      running = false;
      for (const off of offs) off();
      offs = [];
      active = new Set();
      if (flushTimer !== null) clearInterval(flushTimer);
      flushTimer = null;
      await stopStreams();
      sink.flush();
    },
  };
}
