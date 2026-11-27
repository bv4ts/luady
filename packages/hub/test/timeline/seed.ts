import type { Db } from '../../src/core/contracts.js';

/** Rows the recap and the today strip read, written straight into the hub's tables. */
export function seedSession(db: Db, id: string, host: string, name: string): void {
  db.prepare(`INSERT INTO sessions (id, host, tmux_target, display_name, state, created_at) VALUES (?, ?, ?, ?, 'idle', '2026-11-01T00:00:00.000Z')`)
    .run(id, host, `${name}:0.0`, name);
}

export function seedEvent(db: Db, id: string, host: string, sessionId: string, type: string, ts: string, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO events (id, host, session_id, type, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, host, sessionId, type, ts, JSON.stringify({ event: type, data }));
}

export function seedQuestion(db: Db, qid: string, sessionId: string, host: string, question: string, createdAt: string, answeredAt: string | null): void {
  db.prepare(`INSERT INTO questions (qid, kind, host, session_id, payload_json, state, created_at, resolved_at)
    VALUES (?, 'question', ?, ?, ?, ?, ?, ?)`)
    .run(qid, host, sessionId, JSON.stringify({ questions: [{ question, options: [] }] }), answeredAt === null ? 'pending' : 'answered', createdAt, answeredAt);
}

export function seedAlert(db: Db, id: string, text: string, at: string, ref: { kind: string; id: string } | null = null): void {
  db.prepare('INSERT INTO notices (id, kind, text, ref_kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'alert', text, ref?.kind ?? null, ref?.id ?? null, at);
}

export function seedNotice(db: Db, id: string, kind: string, text: string, at: string): void {
  db.prepare('INSERT INTO notices (id, kind, text, created_at) VALUES (?, ?, ?, ?)').run(id, kind, text, at);
}

export function seedMeeting(db: Db, id: string, title: string, startedAt: string, endedAt: string, state = 'announced', people = 'Sara'): void {
  db.prepare(`INSERT INTO meetings (id, title, title_key, started_at, ended_at, state, people, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, title.toLowerCase(), startedAt, endedAt, state, people, endedAt);
}

/** A card, done at `doneAt` when given; its log gets `created` and, for a done card, `started` and `done`. */
export function seedCard(
  db: Db, title: string, createdAt: string, over: { doneAt?: string; startedAt?: string; server?: string; result?: string; project?: string } = {},
): number {
  const done = over.doneAt === undefined ? 0 : 1;
  const id = Number(db.prepare(`INSERT INTO todos (text, today, done, created_at, done_at, state, server, result, project, updated_at)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, done, createdAt, over.doneAt ?? null, done === 1 ? 'done' : 'open', over.server ?? null, over.result ?? null, over.project ?? null,
    over.doneAt ?? createdAt,
  ).lastInsertRowid);
  const log = db.prepare('INSERT INTO todo_events (todo_id, at, kind, text) VALUES (?, ?, ?, ?)');
  log.run(id, createdAt, 'created', 'Added on the website.');
  if (over.startedAt !== undefined) log.run(id, over.startedAt, 'started', 'A session took it.');
  if (over.doneAt !== undefined) log.run(id, over.doneAt, 'done', over.result ?? 'Done.');
  return id;
}
