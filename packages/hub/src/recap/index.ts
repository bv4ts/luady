import { LIMITS, type QuestionDTO, type RecapDTO, type RecapLine } from '@luady/shared';
import type { Clock, Db, Logger, QuestionService, RecapService } from '../core/contracts.js';
import { clipUnits, oneLine } from '../board/text.js';
import { createOfficeSources, officeRef, serverOf } from '../timeline/sources.js';

/** Everything the recap needs (wired in app.ts). */
export interface RecapDeps {
  /** Cards (`todos`), notices of kind alert, meetings and session events. */
  db: Db;
  clock: Clock;
  log: Logger;
  /** Questions that wait for the owner now. */
  questions: Pick<QuestionService, 'pending'>;
}

const DAY_MS = 24 * 60 * 60_000;
const RESULT_MAX = 120;

const text = (value: string): string => clipUnits(oneLine(value), LIMITS.recapTextMax);
const newestFirst = (lines: readonly RecapLine[]): RecapLine[] =>
  [...lines].sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMITS.recapLinesMax);

/** The start the recap really uses: never older than LIMITS.recapSinceMaxDays, never later than now. */
export function recapStart(since: Date, now: Date): Date {
  const floor = now.getTime() - LIMITS.recapSinceMaxDays * DAY_MS;
  const wanted = Number.isFinite(since.getTime()) ? since.getTime() : floor;
  return new Date(Math.min(now.getTime(), Math.max(floor, wanted)));
}

function waitingLine(question: QuestionDTO): RecapLine {
  const asked = question.kind === 'permission'
    ? `asks to use ${question.permission?.toolName ?? 'a tool'}`
    : `asks: ${question.questions[0]?.question ?? 'a question'}`;
  return {
    at: question.createdAt, text: text(`${question.sessionLabel} ${asked}`), ref: { kind: 'question', id: question.qid },
    server: serverOf(question.host),
  };
}

/** The welcome-back card: what happened while the owner was away. */
export function createRecapService(deps: RecapDeps): RecapService {
  const sources = createOfficeSources(deps.db);
  return {
    recap(since) {
      const now = deps.clock.now();
      const from = recapStart(since, now).toISOString();
      const until = now.toISOString();
      // `until` is now; a row stamped this very millisecond still counts.
      const to = new Date(now.getTime() + 1).toISOString();
      const done = sources.cardsDone(from, to);
      const finished = done.map((card): RecapLine => ({
        at: card.at, text: text(card.result === null ? card.title : `${card.title}: ${clipUnits(oneLine(card.result), RESULT_MAX)}`),
        ref: { kind: 'todo', id: String(card.id) }, server: serverOf(card.server),
      }));
      const failed = sources.alerts(from, to).map((alert): RecapLine => {
        const session = alert.refKind === 'session' && alert.refId !== null ? sources.session(alert.refId) : undefined;
        return { at: alert.at, text: text(alert.text), ref: officeRef(alert.refKind, alert.refId), server: serverOf(session?.host ?? null) };
      });
      const meetings = sources.meetingsAnnounced(from, to).map((meeting): RecapLine => ({
        at: meeting.at, text: text(meeting.people.trim() === '' ? meeting.title || 'Meeting' : `${meeting.title || 'Meeting'} · ${meeting.people}`),
        ref: { kind: 'note', id: `m:${meeting.id}` }, server: null,
      }));
      const sessions = sources.sessionEvents(from, to);
      const recap: RecapDTO = {
        since: from,
        until,
        finished: newestFirst(finished),
        failed: newestFirst(failed),
        waiting: newestFirst(deps.questions.pending().map(waitingLine)),
        meetings: newestFirst(meetings),
        cards: { added: sources.cardsAdded(from, to).length, done: done.length },
        sessions: {
          started: sessions.filter((event) => event.type === 'arrived').length,
          ended: sessions.filter((event) => event.type === 'left').length,
        },
      };
      return recap;
    },
  };
}
