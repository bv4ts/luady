import type { ModalState } from '../../model/ui-state.js';
import type { OfficeRef, QuestionDTO, TimelineItem, TimelineKind } from '@luady/shared';
import { clockText, dayKey, dayStart } from '../schedule/owner-time.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const STRIP_START_HOUR = 6;
/** Marks closer than this share of the strip stack on rows. */
const CROWD = 0.018;
export const STRIP_ROWS = 4;

export type Shape = 'circle' | 'ring' | 'square' | 'diamond' | 'up' | 'down' | 'bar' | 'star';

export const KIND_LOOK: Readonly<Record<TimelineKind, { readonly shape: Shape; readonly words: string }>> = Object.freeze({
  started: { shape: 'ring', words: 'Work started' },
  done: { shape: 'circle', words: 'Finished' },
  asked: { shape: 'diamond', words: 'Asked you' },
  answered: { shape: 'square', words: 'Answered' },
  arrived: { shape: 'up', words: 'Arrived' },
  left: { shape: 'down', words: 'Left' },
  meeting: { shape: 'bar', words: 'Meeting' },
  alert: { shape: 'star', words: 'Alert' },
});

export interface StripRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The strip's window for an owner day: from 6 AM (or the hour of an earlier event, or midnight while it is not 6 AM yet)
 * to now on the day that is today, to midnight on a past day; never shorter than one hour.
 */
export function stripRange(day: string, items: readonly Pick<TimelineItem, 'at'>[], now: number): StripRange {
  const start = dayStart(day) ?? now - DAY_MS;
  const earliest = items.reduce((min, item) => Math.min(min, Date.parse(item.at) || min), Number.POSITIVE_INFINITY);
  const isToday = dayKey(now) === day;
  // Before 6 AM today the strip starts at midnight, so "now" is on it.
  const six = isToday && now < start + STRIP_START_HOUR * HOUR_MS ? start : start + STRIP_START_HOUR * HOUR_MS;
  const from = earliest < six ? Math.max(start, Math.floor((earliest - start) / HOUR_MS) * HOUR_MS + start) : six;
  const end = isToday ? Math.min(now, start + DAY_MS) : start + DAY_MS;
  return { from, to: Math.max(end, from + HOUR_MS) };
}

/** Where a moment sits on the strip, 0 (left) to 1 (right). */
export function stripAt(ms: number, range: StripRange): number {
  return Math.min(1, Math.max(0, (ms - range.from) / (range.to - range.from)));
}

/** The hour marks along the strip ("6 AM", "9 AM", "12 PM"), every `step` hours. */
export function hourTicks(range: StripRange): readonly { readonly at: number; readonly label: string }[] {
  const hours = (range.to - range.from) / HOUR_MS;
  const step = hours > 12 ? 3 : hours > 6 ? 2 : 1;
  const first = Math.ceil(range.from / HOUR_MS) * HOUR_MS;
  const ticks: { at: number; label: string }[] = [];
  for (let ms = first; ms <= range.to; ms += HOUR_MS) {
    const hour = Math.round(((ms % DAY_MS) + DAY_MS) % DAY_MS / HOUR_MS + 4) % 24;
    if (hour % step === 0) ticks.push({ at: stripAt(ms, range), label: clockText(ms).replace(':00', '') });
  }
  return ticks;
}

export interface PlacedMark {
  readonly item: TimelineItem;
  readonly x: number;
  readonly row: number;
}

/** Each mark at its time, stacked on up to four rows where marks crowd together (oldest first). */
export function placeMarks(items: readonly TimelineItem[], range: StripRange): readonly PlacedMark[] {
  const lastOnRow = Array.from({ length: STRIP_ROWS }, () => Number.NEGATIVE_INFINITY);
  return items.map((item) => {
    const x = stripAt(Date.parse(item.at), range);
    const free = lastOnRow.findIndex((last) => x - last >= CROWD);
    const row = free === -1 ? lastOnRow.indexOf(Math.min(...lastOnRow)) : free;
    lastOnRow[row] = x;
    return { item, x, row };
  });
}

/** "Today" and "Yesterday" as owner days. */
export function dayChoices(now: number): { readonly today: string; readonly yesterday: string } {
  return { today: dayKey(now), yesterday: dayKey(now - DAY_MS) };
}

/** A row in words: "9:12 AM · Finished · Payroll export". */
export function rowText(item: TimelineItem): string {
  return `${clockText(Date.parse(item.at))} · ${KIND_LOOK[item.kind].words} · ${item.label}`;
}

export type RefTarget =
  | { readonly kind: 'modal'; readonly modal: ModalState }
  | { readonly kind: 'agent'; readonly sessionId: string }
  | null;

/** What a mark opens: a card on the board, a note, the agent view, or the agent that asked a question still open. */
export function refTarget(ref: OfficeRef | null, questions: readonly QuestionDTO[]): RefTarget {
  if (ref === null) return null;
  switch (ref.kind) {
    case 'todo': {
      const id = Number(ref.id);
      return Number.isInteger(id) && id > 0 ? { kind: 'modal', modal: { kind: 'board', itemId: id } } : null;
    }
    case 'note': return { kind: 'modal', modal: { kind: 'notes', noteId: ref.id } };
    case 'session': return { kind: 'agent', sessionId: ref.id };
    case 'question': {
      const question = questions.find((q) => q.qid === ref.id);
      return question === undefined ? null : { kind: 'agent', sessionId: question.sessionId };
    }
  }
}
