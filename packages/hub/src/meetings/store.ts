import type { Db } from '../core/contracts.js';
import { buildFtsQuery } from '../memory/fts-query.js';

export type MeetingState = 'live' | 'waiting' | 'announced' | 'skipped' | 'history';

export interface MeetingRow {
  id: string; title: string; title_key: string; started_at: string; ended_at: string | null; finalized: number; shared: number;
  people: string; state: MeetingState; summary: string; todos: string; gist: string; project: string; notes: string; link: string;
  updated_at: string;
  /** First time the owner opened it in Notes (migration 015); null = not yet. */
  opened_at?: string | null;
}

/** What a Wispr search result tells us about one meeting. */
export interface SeenMeeting {
  id: string; title: string; startedAt: string; endedAt: string | null; finalized: boolean; shared: boolean; people: string;
  excerpt: string; link: string;
}

export interface MeetingFilter { query: string; project?: string; since?: string; until?: string; limit: number }

export interface MeetingStore {
  get(id: string): MeetingRow | undefined;
  /** Inserts a meeting with `state`, or refreshes what Wispr may change (title, times, people, link) on a known one. */
  upsert(seen: SeenMeeting, state: MeetingState, nowIso: string): MeetingRow;
  setState(id: string, state: MeetingState, nowIso: string): void;
  setDetails(id: string, details: { summary: string; todos: string; people?: string }, nowIso: string): void;
  note(id: string, fields: { gist?: string; project?: string; note?: string }, nowIso: string): MeetingRow;
  /** Ended meetings not yet announced, skipped or filed as history. */
  open(): MeetingRow[];
  search(filter: MeetingFilter): MeetingRow[];
  /** The latest meeting with the same title before `beforeIso`, not older than `sinceIso`. */
  previous(titleKey: string, beforeIso: string, sinceIso: string): MeetingRow | undefined;
  count(): number;
}

/** "Orchard Stand Up", "orchard stand-up 11/10" → "orchard stand up": lowercase letters and spaces only. */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();
}

const SELECT = 'SELECT * FROM meetings';

export function createMeetingStore(db: Db): MeetingStore {
  const byId = db.prepare<[string], MeetingRow>(`${SELECT} WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO meetings (id, title, title_key, started_at, ended_at, finalized, shared, people, state, summary, link, updated_at)
     VALUES (@id, @title, @titleKey, @startedAt, @endedAt, @finalized, @shared, @people, @state, @excerpt, @link, @now)`,
  );
  const refresh = db.prepare(
    `UPDATE meetings SET title = @title, title_key = @titleKey, started_at = @startedAt, ended_at = @endedAt, finalized = @finalized,
       people = CASE WHEN @people = '' THEN people ELSE @people END, link = CASE WHEN @link = '' THEN link ELSE @link END,
       summary = CASE WHEN summary = '' THEN @excerpt ELSE summary END, updated_at = @now WHERE id = @id`,
  );
  const setStateStmt = db.prepare('UPDATE meetings SET state = ?, updated_at = ? WHERE id = ?');
  const setDetailsStmt = db.prepare(
    `UPDATE meetings SET summary = @summary, todos = @todos, people = CASE WHEN @people = '' THEN people ELSE @people END,
       updated_at = @now WHERE id = @id`,
  );
  const openStmt = db.prepare<[], MeetingRow>(`${SELECT} WHERE state IN ('live', 'waiting') AND ended_at IS NOT NULL ORDER BY ended_at`);
  const previousStmt = db.prepare<[string, string, string], MeetingRow>(
    `${SELECT} WHERE title_key = ? AND started_at < ? AND started_at >= ? AND state IN ('announced', 'history')
     ORDER BY started_at DESC LIMIT 1`,
  );
  const countStmt = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM meetings WHERE state IN ('announced', 'history')");

  function row(id: string): MeetingRow {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`meeting ${id} vanished`);
    return found;
  }

  return {
    get: (id) => byId.get(id),
    upsert(seen, state, nowIso) {
      const params = {
        ...seen, titleKey: titleKey(seen.title), finalized: seen.finalized ? 1 : 0, shared: seen.shared ? 1 : 0, state, now: nowIso,
      };
      if (byId.get(seen.id) === undefined) insert.run(params);
      else refresh.run(params);
      return row(seen.id);
    },
    setState(id, state, nowIso) {
      setStateStmt.run(state, nowIso, id);
    },
    setDetails(id, details, nowIso) {
      setDetailsStmt.run({ id, summary: details.summary, todos: details.todos, people: details.people ?? '', now: nowIso });
    },
    note(id, fields, nowIso) {
      const current = row(id);
      const day = nowIso.slice(0, 10);
      const notes = fields.note === undefined ? current.notes : `${current.notes}${current.notes === '' ? '' : '\n'}- ${day}: ${fields.note.trim()}`;
      db.prepare('UPDATE meetings SET gist = ?, project = ?, notes = ?, updated_at = ? WHERE id = ?').run(
        fields.gist?.trim() ?? current.gist, fields.project?.trim().toLowerCase() ?? current.project, notes, nowIso, id,
      );
      return row(id);
    },
    open: () => openStmt.all(),
    search(filter) {
      const where: string[] = ["m.state IN ('announced', 'history', 'live')"];
      const args: Array<string | number> = [];
      const match = buildFtsQuery(filter.query);
      if (match !== null) {
        where.push('m.rowid IN (SELECT rowid FROM meetings_fts WHERE meetings_fts MATCH ?)');
        args.push(match);
      }
      if (filter.project !== undefined) {
        where.push('m.project = ?');
        args.push(filter.project.trim().toLowerCase());
      }
      if (filter.since !== undefined) {
        where.push('m.started_at >= ?');
        args.push(filter.since);
      }
      if (filter.until !== undefined) {
        where.push('m.started_at < ?');
        args.push(filter.until);
      }
      args.push(filter.limit);
      return db.prepare<Array<string | number>, MeetingRow>(
        `SELECT m.* FROM meetings m WHERE ${where.join(' AND ')} ORDER BY m.started_at DESC LIMIT ?`,
      ).all(...args);
    },
    previous: (key, beforeIso, sinceIso) => (key === '' ? undefined : previousStmt.get(key, beforeIso, sinceIso)),
    count: () => countStmt.get()?.n ?? 0,
  };
}
