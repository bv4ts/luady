import { LIMITS, ownerZone, wallTimeToUtc, type TimelineDTO, type TimelineItem } from '@luady/shared';
import type { Clock, Db, Logger, SessionService, TimelineService } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { clipUnits, oneLine } from '../board/text.js';
import { createOfficeSources, officeRef, serverOf, type OfficeSources } from './sources.js';

/** Everything the today strip needs (wired in app.ts). */
export interface TimelineDeps {
  /** Card log rows, questions, session events, meetings and alert notices. */
  db: Db;
  clock: Clock;
  log: Logger;
  /** Session names for the labels (never raw ids). */
  sessions: Pick<SessionService, 'get'>;
}

const DAY_MS = 24 * 60 * 60_000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `[from, to)` of one owner calendar day as ISO times, from its local midnight to the next one: 23 or 25 hours on a
 * DST change.
 */
export function ownerDayRange(day: string): { from: string; to: string } {
  const match = DAY_KEY_RE.exec(day);
  const utcMidnight = match === null ? Number.NaN : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utcMidnight) || new Date(utcMidnight).toISOString().slice(0, 10) !== day) throw new ValidationError(`Not a day: ${day}`);
  const tz = ownerZone();
  const local = (ms: number): number => {
    const d = new Date(ms);
    return wallTimeToUtc(tz, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0 });
  };
  return { from: new Date(local(utcMidnight)).toISOString(), to: new Date(local(utcMidnight + DAY_MS)).toISOString() };
}

const label = (text: string): string => clipUnits(oneLine(text), LIMITS.timelineLabelMax);

function sessionItems(sources: OfficeSources, from: string, to: string, name: (id: string | null, fallback: string | null) => string): TimelineItem[] {
  return sources.sessionEvents(from, to).map((row) => ({
    at: row.at, kind: row.type, label: label(`${name(row.sessionId, row.name)} ${row.type === 'arrived' ? 'arrived' : 'left'}`),
    server: serverOf(row.host), ref: row.sessionId === null ? null : { kind: 'session', id: row.sessionId },
  }));
}

/** Everything that happened on one owner day, in the owner's words. */
export function timelineItems(sources: OfficeSources, from: string, to: string, name: (id: string | null, fallback: string | null) => string): TimelineItem[] {
  const cards: TimelineItem[] = sources.cardLog(from, to).map((row) => ({
    at: row.at, kind: row.kind === 'done' ? 'done' : 'started', label: label(row.title), server: serverOf(row.server),
    ref: { kind: 'todo', id: String(row.id) },
  }));
  const asked: TimelineItem[] = sources.questionsAsked(from, to).map((row) => ({
    at: row.at, kind: 'asked', label: label(row.kind === 'permission' ? `${row.name ?? 'A session'} asked for permission` : `${row.name ?? 'A session'} asked: ${row.question ?? 'a question'}`), server: serverOf(row.host),
    ref: { kind: 'question', id: row.qid },
  }));
  const answered: TimelineItem[] = sources.questionsAnswered(from, to).map((row) => ({
    at: row.at, kind: 'answered', label: label(`${row.name ?? 'A session'} got its answer`), server: serverOf(row.host),
    ref: { kind: 'question', id: row.qid },
  }));
  const meetings: TimelineItem[] = sources.meetingsStarted(from, to).map((row) => ({
    at: row.at, kind: 'meeting', label: label(row.title.trim() || 'Meeting'), server: null, ref: { kind: 'note', id: `m:${row.id}` },
  }));
  const alerts: TimelineItem[] = sources.alerts(from, to).map((row) => {
    const session = row.refKind === 'session' && row.refId !== null ? sources.session(row.refId) : undefined;
    return { at: row.at, kind: 'alert', label: label(row.text), server: serverOf(session?.host ?? null), ref: officeRef(row.refKind, row.refId) };
  });
  const all = [...cards, ...asked, ...answered, ...sessionItems(sources, from, to, name), ...meetings, ...alerts];
  // Oldest first; a very busy day keeps its latest marks.
  return all.sort((a, b) => a.at.localeCompare(b.at)).slice(-LIMITS.timelineItemsMax);
}

/** The today strip: one owner day from card log rows, questions, sessions, meetings and alerts. */
export function createTimelineService(deps: TimelineDeps): TimelineService {
  const sources = createOfficeSources(deps.db);
  const name = (id: string | null, fallback: string | null): string => {
    const live = id === null ? undefined : deps.sessions.get(id);
    return live?.displayName ?? fallback ?? 'A session';
  };
  return {
    day(day) {
      const { from, to } = ownerDayRange(day);
      return { day, items: timelineItems(sources, from, to, name) };
    },
  };
}
