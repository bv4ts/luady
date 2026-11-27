import type { RecapDTO, RecapLine } from '@luady/shared';

/** Where this device remembers when the owner was last looking at the office. */
export const LAST_HERE_KEY = 'hub.lastHere';
/** Away at least this long, and Luady hands over the welcome-back card. */
export const AWAY_MS = 30 * 60_000;
/** "Last here" is written at most this often while the owner is active. */
export const LAST_HERE_EVERY_MS = 30_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function readLastHere(store: Store | null): number | null {
  try {
    const saved = Number(store?.getItem(LAST_HERE_KEY) ?? Number.NaN);
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  } catch {
    return null;
  }
}

export function writeLastHere(store: Store | null, at: number): void {
  try {
    store?.setItem(LAST_HERE_KEY, String(at));
  } catch {
    // Storage refused (a private window): the card then only shows within this page's life.
  }
}

/** The time to ask the recap from: when the owner was last here, if that was 30 minutes or more ago; else null. */
export function recapSince(lastHere: number | null, now: number): number | null {
  if (lastHere === null || now - lastHere < AWAY_MS) return null;
  return lastHere;
}

/** One section of the card, in the order it is read. */
export interface RecapSection {
  readonly key: 'waiting' | 'failed' | 'finished' | 'meetings';
  readonly title: string;
  readonly lines: readonly RecapLine[];
}

const TITLES: Readonly<Record<RecapSection['key'], string>> = {
  waiting: 'Waiting for you', failed: 'Went wrong', finished: 'Finished', meetings: 'New meeting notes',
};

/** What needs the owner first, then what broke, then what is done, then meetings; empty sections left out. */
export function recapSections(recap: RecapDTO): readonly RecapSection[] {
  return (['waiting', 'failed', 'finished', 'meetings'] as const)
    .map((key) => ({ key, title: TITLES[key], lines: recap[key] }))
    .filter((section) => section.lines.length > 0);
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "3 cards added, 5 done · 2 sessions started, 1 ended"; only what is not zero; '' when all are. */
export function recapCounts(recap: RecapDTO): string {
  const cards = [
    recap.cards.added > 0 ? `${plural(recap.cards.added, 'card', 'cards')} added` : null,
    recap.cards.done > 0 ? (recap.cards.added > 0 ? `${recap.cards.done} done` : `${plural(recap.cards.done, 'card', 'cards')} done`) : null,
  ].filter((part): part is string => part !== null).join(', ');
  const sessions = [
    recap.sessions.started > 0 ? `${plural(recap.sessions.started, 'session', 'sessions')} started` : null,
    recap.sessions.ended > 0 ? (recap.sessions.started > 0 ? `${recap.sessions.ended} ended` : `${plural(recap.sessions.ended, 'session', 'sessions')} ended`) : null,
  ].filter((part): part is string => part !== null).join(', ');
  return [cards, sessions].filter((part) => part !== '').join(' · ');
}
