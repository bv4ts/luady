import { LIMITS, NOTE_ID_RE, type NoteDTO, type NoteTranscriptDTO } from '@luady/shared';
import type { Clock, Db, EventBus, LuadyService, Logger, NotesService } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { noteAbout } from '../luady/about.js';
import type { MeetingsService } from '../meetings/service.js';
import { createNoteStore, listed, meetingNoteDto, typedNoteDto } from './store.js';

/** Everything notes need (wired in app.ts). */
export interface NotesDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** Wispr Flow meetings: live transcripts (the `meetings` table is read directly). */
  meetings: Pick<MeetingsService, 'get'>;
  /** "Send to Luady" posts the note as an owner message about it. */
  luady: Pick<LuadyService, 'postOwnerMessage'>;
}

/** Notes and meetings, plus the watch that tells the website when the meetings service changed a meeting. */
export interface NotesHub extends NotesService {
  start(): void;
  stop(): void;
  /** One look for changed meetings; exposed for tests. */
  check(): void;
}

/** Wispr hands out a transcript in parts of this many characters (meetings/service.ts). */
export const TRANSCRIPT_PART = 12_000;
export const NOTES_WATCH_MS = 60_000;
/** The owner's words when a note is sent to Luady; the note itself goes in front as the `about` block. */
export const DISCUSS_TEXT = 'Please read this note and answer briefly. Add the to-dos you see in it to the board.';

type ParsedId = { kind: 'meeting'; id: string } | { kind: 'note'; id: number };

function parseId(id: string): ParsedId {
  if (!NOTE_ID_RE.test(id)) throw new ValidationError(`Not a note id: ${id}`);
  return id.startsWith('m:') ? { kind: 'meeting', id: id.slice(2) } : { kind: 'note', id: Number(id.slice(2)) };
}

function cleanTitle(title: string | undefined): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > LIMITS.noteTitleMax) throw new ValidationError(`A note title is at most ${LIMITS.noteTitleMax} characters`);
  return clean;
}

function cleanBody(body: string): string {
  const clean = body.trim();
  if (clean === '' || clean.length > LIMITS.noteBodyMax) throw new ValidationError(`A note needs 1-${LIMITS.noteBodyMax} characters`);
  return clean;
}

function cleanProject(project: string | null | undefined): string | null {
  const clean = project?.trim() ?? '';
  if (clean.length > LIMITS.noteProjectMax) throw new ValidationError(`A project name is at most ${LIMITS.noteProjectMax} characters`);
  return clean === '' ? null : clean;
}

const TRANSCRIPT_MARK = /\nTranscript \(from char \d+\):\n/;

/** The transcript part out of meetings.get's text (it is its last section); null when Wispr was not reachable. */
export function transcriptPart(text: string, start: number): NoteTranscriptDTO | null {
  const match = TRANSCRIPT_MARK.exec(text);
  if (match === null) return null;
  const part = text.slice(match.index + match[0].length);
  const clean = part.trim() === '(empty)' ? '' : part;
  return { text: clean, nextStart: clean.length >= TRANSCRIPT_PART ? start + clean.length : null };
}

/** One list over Wispr Flow meetings and the owner's typed notes. */
export function createNotesService(deps: NotesDeps): NotesHub {
  const store = createNoteStore(deps.db);
  const nowIso = (): string => deps.clock.now().toISOString();
  let stamp = store.meetingsStamp();
  let timer: ReturnType<typeof setInterval> | null = null;

  const changed = (): void => deps.bus.emit('notes.changed', { at: nowIso() });

  function typed(id: string): number {
    const parsed = parseId(id);
    if (parsed.kind === 'meeting') throw new RefusedError('A meeting note comes from Wispr Flow and cannot be changed here.');
    if (store.get(parsed.id) === undefined) throw new NotFoundError(`No note ${id}`);
    return parsed.id;
  }

  async function get(id: string): Promise<NoteDTO | null> {
    const parsed = parseId(id);
    if (parsed.kind === 'note') {
      const row = store.get(parsed.id);
      return row === undefined ? null : typedNoteDto(row);
    }
    const meeting = store.meeting(parsed.id);
    return meeting === undefined ? null : meetingNoteDto(meeting);
  }

  function check(): void {
    const next = store.meetingsStamp();
    if (next === stamp) return;
    stamp = next;
    changed();
  }

  return {
    async list({ query, limit }) {
      const notes = store.notes(query, limit).map(typedNoteDto);
      const meetings = store.meetings(query, limit).map(meetingNoteDto).filter((note): note is NoteDTO => note !== null);
      return [...notes, ...meetings].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).map(listed);
    },
    get,
    async create(body) {
      const at = nowIso();
      const id = store.insert({ title: cleanTitle(body.title), body: cleanBody(body.body), project: cleanProject(body.project), at });
      const note = await get(`n:${id}`);
      if (note === null) throw new Error('note was not saved');
      changed();
      if (body.discuss === true) await deps.luady.postOwnerMessage(DISCUSS_TEXT, 'web', noteAbout(note));
      return note;
    },
    async update(id, body) {
      const rowId = typed(id);
      store.update(rowId, {
        ...(body.title === undefined ? {} : { title: cleanTitle(body.title) }),
        ...(body.body === undefined ? {} : { body: cleanBody(body.body) }),
        ...(body.project === undefined ? {} : { project: cleanProject(body.project) }),
      }, nowIso());
      const note = await get(id);
      if (note === null) throw new NotFoundError(`No note ${id}`);
      changed();
      return note;
    },
    async remove(id) {
      store.remove(typed(id));
      changed();
    },
    async transcript(id, start) {
      const parsed = parseId(id);
      if (parsed.kind === 'note') throw new RefusedError('A typed note has no transcript.');
      if (store.meeting(parsed.id) === undefined) throw new NotFoundError(`No meeting ${id}`);
      const part = transcriptPart(await deps.meetings.get(parsed.id, true, start), start);
      if (part === null) throw new RefusedError('Wispr Flow is not reachable right now. Try again in a minute.');
      return part;
    },
    async opened(id) {
      const parsed = parseId(id);
      if (parsed.kind === 'note') {
        if (store.get(parsed.id) === undefined) throw new NotFoundError(`No note ${id}`);
        return;
      }
      if (store.meeting(parsed.id) === undefined) throw new NotFoundError(`No meeting ${id}`);
      if (store.markOpened(parsed.id, nowIso())) changed();
    },
    newCount: () => store.newCount(),
    start() {
      timer ??= setInterval(() => {
        try {
          check();
        } catch (err) {
          deps.log.warn({ err }, 'notes: meeting check failed');
        }
      }, NOTES_WATCH_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    check,
  };
}
