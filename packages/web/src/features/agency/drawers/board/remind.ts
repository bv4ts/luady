import type { BoardItemDTO } from '@luady/shared';
import { parseTime } from '../../../../lib/format.js';
import { WEEKDAYS, ownerMs, ownerParts, whenWords } from '../schedule/owner-time.js';
import { isSnoozed } from './lanes.js';

/** "Remind me…" (snooze) and due dates on board cards, in owner time. */

export interface RemindPreset {
  readonly id: string;
  readonly label: string;
  /** The moment the card comes back (epoch ms). */
  readonly at: number;
}

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** The day `offset` days after the owner day of `now`, at an owner hour. */
function dayAt(now: number, offset: number, hour: number): number {
  const p = ownerParts(now);
  return ownerMs(p.year, p.month, p.day + offset, hour);
}

/**
 * The presets at fixed clock times: this evening at 6 PM (only before 6 PM), tomorrow at 9 AM, and each of the next
 * days after tomorrow by its name at 9 AM ("Thursday, 9:00 AM"), up to a week ahead.
 */
export function remindPresets(now: number): readonly RemindPreset[] {
  const evening = dayAt(now, 0, EVENING_HOUR);
  const named = [2, 3, 4, 5, 6].map((offset) => {
    const at = dayAt(now, offset, MORNING_HOUR);
    return { id: `day-${String(offset)}`, label: `${WEEKDAYS[ownerParts(at).weekday] ?? ''}, 9:00 AM`, at };
  });
  return [
    ...(evening > now ? [{ id: 'evening', label: 'This evening, 6:00 PM', at: evening }] : []),
    { id: 'tomorrow', label: 'Tomorrow, 9:00 AM', at: dayAt(now, 1, MORNING_HOUR) },
    ...named,
  ];
}

/** The ISO time the hub stores for a moment. */
export const isoAt = (ms: number): string => new Date(ms).toISOString();

/** Open cards hidden until later, soonest back first. */
export function snoozedCards(cards: readonly BoardItemDTO[], now: number): readonly BoardItemDTO[] {
  return cards
    .filter((card) => card.state === 'open' && isSnoozed(card, now))
    .toSorted((a, b) => (parseTime(a.snoozeUntil) ?? 0) - (parseTime(b.snoozeUntil) ?? 0) || a.id - b.id);
}

/** "Back Tomorrow, 9:00 AM". */
export function backText(card: Pick<BoardItemDTO, 'snoozeUntil'>, now: number): string {
  const at = parseTime(card.snoozeUntil);
  return at === null ? 'Back now' : `Back ${whenWords(at, now)}`;
}

export type DueState = 'none' | 'ahead' | 'past';

/** Whether a card's due time is set, still ahead, or has passed (a done card is never overdue). */
export function dueState(card: Pick<BoardItemDTO, 'dueAt' | 'state'>, now: number): DueState {
  const at = parseTime(card.dueAt);
  if (at === null) return 'none';
  return at <= now && card.state !== 'done' ? 'past' : 'ahead';
}

/** The chip on a card: "Due Thursday, 9:00 AM" or "Overdue · Yesterday, 5:00 PM"; null without a due time. */
export function dueText(card: Pick<BoardItemDTO, 'dueAt' | 'state'>, now: number): string | null {
  const at = parseTime(card.dueAt);
  if (at === null) return null;
  return dueState(card, now) === 'past' ? `Overdue · ${whenWords(at, now)}` : `Due ${whenWords(at, now)}`;
}
