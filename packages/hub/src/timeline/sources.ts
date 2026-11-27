import { SELF_HOST_ID, isHostId, isSelfHost, type OfficeRef, type HostId } from '@luady/shared';
import type { Db } from '../core/contracts.js';

/**
 * Read-only queries the welcome-back card (recap/) and the today strip (timeline/) share. Every range is
 * `[from, to)` as ISO times; every row says which office it belongs to and a name the owner knows (never a raw id).
 */

/** Session start sources that mean a session arrived (a compaction or /clear keeps it the same session). */
const ARRIVALS = ['startup', 'resume'];
/** session_end reasons that keep the session going (sessions/registry.ts CONTINUING_END_REASONS). */
const CONTINUING = ['clear', 'resume'];
const MEETING_STATES = "('announced', 'history', 'live')";

export interface CardRow { id: number; title: string; server: string | null; result: string | null; at: string }
export interface CardLogRow { id: number; title: string; server: string | null; kind: string; at: string }
export interface AlertRow { id: string; text: string; refKind: string | null; refId: string | null; at: string }
export interface QuestionRow { qid: string; kind: string; name: string | null; host: string; question: string | null; at: string }
export interface SessionEventRow { sessionId: string | null; name: string | null; host: string; type: 'arrived' | 'left'; at: string }
export interface MeetingRow { id: string; title: string; people: string; at: string }

export function serverOf(value: string | null): HostId | null {
  return value !== null && isHostId(value) && !isSelfHost(value) ? value : null;
}

/** A notice's link as something the website can open; actions and Luady's own chat open nothing. */
export function officeRef(kind: string | null, id: string | null): OfficeRef | null {
  if (kind === null || id === null) return null;
  return kind === 'session' || kind === 'question' || kind === 'todo' || kind === 'note' ? { kind, id } : null;
}

export interface OfficeSources {
  cardsAdded(from: string, to: string): CardRow[];
  cardsDone(from: string, to: string): CardRow[];
  /** `started` and `done` lines of the card log. */
  cardLog(from: string, to: string): CardLogRow[];
  alerts(from: string, to: string): AlertRow[];
  questionsAsked(from: string, to: string): QuestionRow[];
  questionsAnswered(from: string, to: string): QuestionRow[];
  /** Sessions that arrived (started or resumed) and left (ended), not Luady's own. */
  sessionEvents(from: string, to: string): SessionEventRow[];
  /** Meetings that started in the range (the today strip). */
  meetingsStarted(from: string, to: string): MeetingRow[];
  /** Meetings Luady announced that ended in the range (the welcome-back card). */
  meetingsAnnounced(from: string, to: string): MeetingRow[];
  /** A session's office and name for a notice that points at it. */
  session(id: string): { host: string; name: string } | undefined;
}

export function createOfficeSources(db: Db): OfficeSources {
  const added = db.prepare<[string, string], CardRow>(
    'SELECT id, text AS title, server, result, created_at AS at FROM todos WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC',
  );
  const done = db.prepare<[string, string], CardRow>(
    'SELECT id, text AS title, server, result, done_at AS at FROM todos WHERE done = 1 AND done_at >= ? AND done_at < ? ORDER BY done_at DESC, id DESC',
  );
  const log = db.prepare<[string, string], CardLogRow>(
    `SELECT t.id, t.text AS title, t.server, e.kind, e.at FROM todo_events e JOIN todos t ON t.id = e.todo_id
     WHERE e.kind IN ('started', 'done') AND e.at >= ? AND e.at < ? ORDER BY e.at, e.id`,
  );
  const alerts = db.prepare<[string, string], AlertRow>(
    `SELECT id, text, ref_kind AS refKind, ref_id AS refId, created_at AS at FROM notices
     WHERE kind = 'alert' AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, rowid DESC`,
  );
  const questionSelect = `SELECT q.qid, q.kind, s.display_name AS name, q.host, json_extract(q.payload_json, '$.questions[0].question') AS question`;
  const asked = db.prepare<[string, string], QuestionRow>(
    `${questionSelect}, q.created_at AS at FROM questions q LEFT JOIN sessions s ON s.id = q.session_id
     WHERE q.created_at >= ? AND q.created_at < ? ORDER BY q.created_at`,
  );
  const answered = db.prepare<[string, string], QuestionRow>(
    `${questionSelect}, q.resolved_at AS at FROM questions q LEFT JOIN sessions s ON s.id = q.session_id
     WHERE q.state = 'answered' AND q.resolved_at >= ? AND q.resolved_at < ? ORDER BY q.resolved_at`,
  );
  const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');
  const sessionEvents = db.prepare<[string, string, string], SessionEventRow>(
    `SELECT e.session_id AS sessionId, s.display_name AS name, e.host,
       CASE WHEN e.type = 'session_start' THEN 'arrived' ELSE 'left' END AS type, e.ts AS at
     FROM events e LEFT JOIN sessions s ON s.id = e.session_id
     WHERE e.host != ? AND e.ts >= ? AND e.ts < ? AND (
       (e.type = 'session_start' AND COALESCE(json_extract(e.payload_json, '$.data.source'), 'startup') IN (${list(ARRIVALS)}))
       OR (e.type = 'session_end' AND COALESCE(json_extract(e.payload_json, '$.data.reason'), '') NOT IN (${list(CONTINUING)})))
     ORDER BY e.ts`,
  );
  const started = db.prepare<[string, string], MeetingRow>(
    `SELECT id, title, people, started_at AS at FROM meetings WHERE state IN ${MEETING_STATES} AND started_at >= ? AND started_at < ?
     ORDER BY started_at`,
  );
  const announced = db.prepare<[string, string], MeetingRow>(
    `SELECT id, title, people, ended_at AS at FROM meetings WHERE state = 'announced' AND ended_at >= ? AND ended_at < ?
     ORDER BY ended_at DESC`,
  );
  const session = db.prepare<[string], { host: string; name: string }>('SELECT host, display_name AS name FROM sessions WHERE id = ?');

  return {
    cardsAdded: (from, to) => added.all(from, to),
    cardsDone: (from, to) => done.all(from, to),
    cardLog: (from, to) => log.all(from, to),
    alerts: (from, to) => alerts.all(from, to),
    questionsAsked: (from, to) => asked.all(from, to),
    questionsAnswered: (from, to) => answered.all(from, to),
    sessionEvents: (from, to) => sessionEvents.all(SELF_HOST_ID, from, to),
    meetingsStarted: (from, to) => started.all(from, to),
    meetingsAnnounced: (from, to) => announced.all(from, to),
    session: (id) => session.get(id),
  };
}
