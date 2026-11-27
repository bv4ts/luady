import { LIMITS, NOTE_ID_RE, type NoteDTO } from '@luady/shared';
import type { Db } from '../core/contracts.js';
import type { MeetingRow } from '../meetings/store.js';
import { UNTITLED } from '../meetings/text.js';
import { buildFtsQuery } from '../memory/fts-query.js';
import { clipUnits, oneLine } from '../board/text.js';

/** One typed or pasted note (migration 012). */
export interface NoteRow {
  id: number;
  title: string;
  body: string;
  project: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const TITLE_FROM_BODY_MAX = 80;
const MEETING_STATES = "('announced', 'history', 'live', 'waiting')";
/** The listed meetings that can be new: a meeting filed as history was never announced, so it never is. */
const NEW_STATES = "('announced', 'live', 'waiting')";

/** A note without a title is named by its first line. */
export function noteTitle(row: Pick<NoteRow, 'title' | 'body'>): string {
  const title = oneLine(row.title);
  if (title !== '') return title;
  const first = row.body.split(/\r?\n/).map(oneLine).find((line) => line !== '') ?? 'Note';
  return clipUnits(first.replace(/^[#>*\-\s]+/, '') || 'Note', TITLE_FROM_BODY_MAX);
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text);

export function typedNoteDto(row: NoteRow): NoteDTO {
  return {
    id: `n:${row.id}`, kind: 'note', title: noteTitle(row), at: row.created_at, project: row.project, people: null, gist: null,
    summary: row.body, actionItems: null, ownerNotes: null, link: null, hasTranscript: false, editable: true, isNew: false,
  };
}

/** A meeting is new until the owner opens it; one filed as history never is. */
export function meetingIsNew(row: Pick<MeetingRow, 'state' | 'opened_at'>): boolean {
  return (row.opened_at ?? null) === null && row.state !== 'history';
}

/** A Wispr Flow meeting as a note; null when its id does not fit a note id (never expected from Wispr). */
export function meetingNoteDto(row: MeetingRow): NoteDTO | null {
  const id = `m:${row.id}`;
  if (!NOTE_ID_RE.test(id)) return null;
  return {
    id, kind: 'meeting', title: row.title.trim() || UNTITLED, at: row.started_at, project: orNull(row.project), people: orNull(row.people),
    gist: orNull(row.gist), summary: row.summary, actionItems: orNull(row.todos), ownerNotes: orNull(row.notes), link: orNull(row.link),
    hasTranscript: true, editable: false, isNew: meetingIsNew(row),
  };
}

/** The list cuts summaries (the full note has all of it). */
export function listed(note: NoteDTO): NoteDTO {
  return { ...note, summary: clipUnits(note.summary, LIMITS.noteListSummaryMax) };
}

export interface NoteStore {
  get(id: number): NoteRow | undefined;
  meeting(id: string): MeetingRow | undefined;
  insert(note: { title: string; body: string; project: string | null; at: string }): number;
  update(id: number, fields: Partial<Pick<NoteRow, 'title' | 'body' | 'project'>>, at: string): void;
  remove(id: number): void;
  /** Newest first; `query` searches the full text of both kinds. */
  notes(query: string | undefined, limit: number): NoteRow[];
  meetings(query: string | undefined, limit: number): MeetingRow[];
  /** Changes the meetings service makes (new, summarised, noted): a stamp that moves when any of them does. */
  meetingsStamp(): string;
  /** Marks a listed meeting opened; false when it already was (or cannot be new). */
  markOpened(id: string, at: string): boolean;
  /** Listed meetings not opened yet. */
  newCount(): number;
}

export function createNoteStore(db: Db): NoteStore {
  const byId = db.prepare<[number], NoteRow>('SELECT * FROM notes WHERE id = ?');
  const meetingById = db.prepare<[string], MeetingRow>(`SELECT * FROM meetings WHERE id = ? AND state IN ${MEETING_STATES}`);
  const insertRow = db.prepare<[string, string, string | null, string, string]>(
    "INSERT INTO notes (title, body, project, source, created_at, updated_at) VALUES (?, ?, ?, 'web', ?, ?)",
  );
  const deleteRow = db.prepare<[number]>('DELETE FROM notes WHERE id = ?');
  const stamp = db.prepare<[], { n: number; at: string | null }>('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM meetings');
  const open = db.prepare<[string, string]>(`UPDATE meetings SET opened_at = ? WHERE id = ? AND opened_at IS NULL AND state IN ${NEW_STATES}`);
  const unopened = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM meetings WHERE opened_at IS NULL AND state IN ${NEW_STATES}`);

  return {
    get: (id) => byId.get(id),
    meeting: (id) => meetingById.get(id),
    insert(note) {
      return Number(insertRow.run(note.title, note.body, note.project, note.at, note.at).lastInsertRowid);
    },
    update(id, fields, at) {
      const keys = (['title', 'body', 'project'] as const).filter((key) => fields[key] !== undefined);
      const sets = [...keys.map((key) => `${key} = @${key}`), 'updated_at = @at'].join(', ');
      db.prepare(`UPDATE notes SET ${sets} WHERE id = @id`).run({ ...fields, at, id });
    },
    remove: (id) => {
      deleteRow.run(id);
    },
    notes(query, limit) {
      const match = query === undefined ? null : buildFtsQuery(query);
      if (query !== undefined && match === null) return [];
      return match === null
        ? db.prepare<[number], NoteRow>('SELECT * FROM notes ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
        : db.prepare<[string, number], NoteRow>(
          'SELECT n.* FROM notes n WHERE n.id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?) ORDER BY n.created_at DESC, n.id DESC LIMIT ?',
        ).all(match, limit);
    },
    meetings(query, limit) {
      const match = query === undefined ? null : buildFtsQuery(query);
      if (query !== undefined && match === null) return [];
      return match === null
        ? db.prepare<[number], MeetingRow>(`SELECT * FROM meetings WHERE state IN ${MEETING_STATES} ORDER BY started_at DESC LIMIT ?`).all(limit)
        : db.prepare<[string, number], MeetingRow>(
          `SELECT m.* FROM meetings m WHERE m.state IN ${MEETING_STATES}
             AND m.rowid IN (SELECT rowid FROM meetings_fts WHERE meetings_fts MATCH ?) ORDER BY m.started_at DESC LIMIT ?`,
        ).all(match, limit);
    },
    meetingsStamp() {
      const row = stamp.get();
      return `${row?.n ?? 0}|${row?.at ?? ''}`;
    },
    markOpened: (id, at) => open.run(at, id).changes > 0,
    newCount: () => unopened.get()?.n ?? 0,
  };
}
