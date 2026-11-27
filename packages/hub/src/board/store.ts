import {
  BOARD_EVENT_KINDS, BOARD_SOURCES, BOARD_STATES, LIMITS, isHostId,
  type BoardEventDTO, type BoardEventKind, type BoardItemDTO, type BoardSource, type BoardState,
} from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';
import type { CardColumns, LogLine } from './machine.js';
import { clipUnits } from './text.js';

/** One row of `todos` after migration 012 (the to-do list's columns plus the card columns). */
export interface CardRow {
  id: number;
  text: string;
  today: number;
  done: number;
  created_at: string;
  done_at: string | null;
  details: string;
  project: string | null;
  server: string | null;
  source: string;
  source_ref: string | null;
  state: BoardState;
  priority: number;
  auto: number;
  run_id: string | null;
  session_id: string | null;
  result: string | null;
  updated_at: string | null;
  due_at: string | null;
  snooze_until: string | null;
}

export interface NewCard {
  text: string;
  details: string;
  project: string | null;
  server: string | null;
  source: BoardSource;
  sourceRef: string | null;
  today: boolean;
  priority: 0 | 1;
  auto: boolean;
  state: BoardState;
  sessionId: string | null;
  createdAt: string;
}

interface EventRow { id: number; todo_id: number; at: string; kind: string; text: string }

const WRITABLE: ReadonlySet<string> = new Set([
  'text', 'details', 'project', 'server', 'today', 'priority', 'state', 'done', 'done_at', 'result', 'session_id', 'run_id', 'auto',
  'due_at', 'snooze_until', 'updated_at',
]);
const SOURCES: ReadonlySet<string> = new Set(BOARD_SOURCES);
const STATES: ReadonlySet<string> = new Set(BOARD_STATES);
const KINDS: ReadonlySet<string> = new Set(BOARD_EVENT_KINDS);

/** A rolled-back release ticks a to-do with `done = 1` only; that row is done whatever `state` still says. */
export function effectiveState(row: Pick<CardRow, 'state' | 'done'>): BoardState {
  if (row.done === 1) return 'done';
  return STATES.has(row.state) ? row.state : 'open';
}

/**
 * The card's host, or null; a value that is no host id is shown as no host and logged with its table and key, never
 * silently. The wins wall uses the same rule.
 */
export function cardHost(table: string, id: number, server: string | null, log?: Pick<Logger, 'warn'>): string | null {
  if (server === null || isHostId(server)) return server;
  log?.warn({ table, id, server }, 'a card names a host that is not a host id: it is shown without one');
  return null;
}

export function toCardDto(row: CardRow, log?: Pick<Logger, 'warn'>): BoardItemDTO {
  const state = effectiveState(row);
  return {
    id: row.id,
    title: clipUnits(row.text.trim() === '' ? `Card #${row.id}` : row.text, LIMITS.boardTitleMax),
    details: clipUnits(row.details, LIMITS.boardDetailsMax),
    project: row.project,
    server: cardHost('todos', row.id, row.server, log),
    source: SOURCES.has(row.source) ? (row.source as BoardSource) : 'manager',
    sourceRef: row.source_ref,
    state,
    today: row.today === 1,
    priority: row.priority === 1 ? 1 : 0,
    auto: row.auto === 1,
    runId: row.run_id,
    sessionId: row.session_id,
    result: row.result === null ? null : clipUnits(row.result, LIMITS.boardResultMax),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.done_at ?? row.created_at,
    doneAt: state === 'done' ? row.done_at ?? row.updated_at ?? row.created_at : null,
    dueAt: row.due_at,
    snoozeUntil: row.snooze_until,
  };
}

function toEventDto(row: EventRow): BoardEventDTO {
  return {
    id: row.id, itemId: row.todo_id, at: row.at, kind: KINDS.has(row.kind) ? (row.kind as BoardEventKind) : 'note',
    text: clipUnits(row.text, LIMITS.boardEventTextMax),
  };
}

export interface CardStore {
  get(id: number): CardRow | undefined;
  insert(card: NewCard): number;
  write(id: number, columns: CardColumns): void;
  log(id: number, lines: readonly LogLine[], at: string): void;
  events(id: number): BoardEventDTO[];
  remove(id: number): void;
  /** Not done, plus done since `doneSince`. */
  board(doneSince: string): CardRow[];
  inState(states: readonly BoardState[]): CardRow[];
  doneSince(since: string): CardRow[];
  /** Cards a session works on now (queued or running, or review when `withReview`). */
  ofSession(sessionId: string, states: readonly BoardState[]): CardRow[];
  /** True when a card linked to the session changed at or after `since` (any state, done included). */
  touchedSince(sessionId: string, since: string): boolean;
  /** The newest card not done that came from this source and reference (a ticket or a note sent twice). */
  bySource(source: BoardSource, sourceRef: string): CardRow | undefined;
  /** Queued cards no session has taken, with the time they were queued. */
  waiting(): Array<CardRow & { queued_at: string | null }>;
  /** Rows a rolled-back release changed: `done = 1` with another state, or no `updated_at`. */
  reconcile(): number;
}

export function createCardStore(db: Db): CardStore {
  const byId = db.prepare<[number], CardRow>('SELECT * FROM todos WHERE id = ?');
  const insertRow = db.prepare(
    `INSERT INTO todos (text, today, done, created_at, done_at, details, project, server, source, source_ref, state, priority, auto,
       session_id, updated_at)
     VALUES (@text, @today, 0, @createdAt, NULL, @details, @project, @server, @source, @sourceRef, @state, @priority, @auto, @sessionId,
       @createdAt)`,
  );
  const insertEvent = db.prepare<[number, string, string, string]>('INSERT INTO todo_events (todo_id, at, kind, text) VALUES (?, ?, ?, ?)');
  const eventsOf = db.prepare<[number], EventRow>('SELECT * FROM todo_events WHERE todo_id = ? ORDER BY id');
  const deleteRow = db.prepare<[number]>('DELETE FROM todos WHERE id = ?');
  const deleteEvents = db.prepare<[number]>('DELETE FROM todo_events WHERE todo_id = ?');
  const boardRows = db.prepare<[string], CardRow>(
    "SELECT * FROM todos WHERE done = 0 OR done_at >= ? ORDER BY CASE WHEN done = 1 THEN 1 ELSE 0 END, today DESC, priority DESC, id DESC",
  );
  const doneRows = db.prepare<[string], CardRow>('SELECT * FROM todos WHERE done = 1 AND done_at >= ? ORDER BY done_at DESC, id DESC');
  const touchedRow = db.prepare<[string, string], { one: number }>('SELECT 1 AS one FROM todos WHERE session_id = ? AND updated_at >= ? LIMIT 1');
  const sourceRow = db.prepare<[string, string], CardRow>(
    'SELECT * FROM todos WHERE source = ? AND source_ref = ? AND done = 0 ORDER BY id DESC LIMIT 1',
  );
  const waitingRows = db.prepare<[], CardRow & { queued_at: string | null }>(
    `SELECT t.*, (SELECT MAX(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.kind = 'queued') AS queued_at
     FROM todos t WHERE t.state = 'queued' AND t.done = 0 AND t.session_id IS NULL ORDER BY t.id`,
  );
  const fixDone = db.prepare("UPDATE todos SET state = 'done' WHERE done = 1 AND state != 'done'");
  const fixUpdated = db.prepare('UPDATE todos SET updated_at = COALESCE(done_at, created_at) WHERE updated_at IS NULL');
  const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

  return {
    get: (id) => byId.get(id),
    insert(card) {
      const result = insertRow.run({
        ...card, today: card.today ? 1 : 0, auto: card.auto ? 1 : 0,
      });
      return Number(result.lastInsertRowid);
    },
    write(id, columns) {
      const keys = Object.keys(columns).filter((key) => WRITABLE.has(key));
      if (keys.length === 0) return;
      const sets = keys.map((key) => `${key} = @${key}`).join(', ');
      db.prepare(`UPDATE todos SET ${sets} WHERE id = @id`).run({ ...columns, id });
    },
    log(id, lines, at) {
      for (const line of lines) insertEvent.run(id, at, line.kind, line.text);
    },
    events: (id) => eventsOf.all(id).map(toEventDto),
    remove(id) {
      db.transaction(() => {
        deleteEvents.run(id);
        deleteRow.run(id);
      })();
    },
    board: (doneSince) => boardRows.all(doneSince),
    inState(states) {
      if (states.length === 0) return [];
      return db.prepare<string[], CardRow>(
        `SELECT * FROM todos WHERE done = 0 AND state IN (${placeholders(states.length)}) ORDER BY today DESC, priority DESC, id DESC`,
      ).all(...states);
    },
    doneSince: (since) => doneRows.all(since),
    ofSession(sessionId, states) {
      return db.prepare<string[], CardRow>(
        `SELECT * FROM todos WHERE session_id = ? AND done = 0 AND state IN (${placeholders(states.length)}) ORDER BY id`,
      ).all(sessionId, ...states);
    },
    touchedSince: (sessionId, since) => touchedRow.get(sessionId, since) !== undefined,
    bySource: (source, sourceRef) => sourceRow.get(source, sourceRef),
    waiting: () => waitingRows.all(),
    reconcile() {
      return db.transaction(() => fixDone.run().changes + fixUpdated.run().changes)();
    },
  };
}
