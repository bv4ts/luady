import type { SeatMap } from '@luady/office';
import { reportError } from '../../../lib/report.js';

/** Desk numbers are remembered per device so characters keep their desks across reloads. */
export const SEATS_KEY = 'hub.agency.seats';

/** No room holds more desks than this; anything larger is not a desk number. */
const MAX_DESK = 999;
const NO_SEATS: SeatMap = Object.freeze({});

const isDesk = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DESK;

/** The saved desk numbers. Missing, corrupt or unreadable data gives {}; bad entries are dropped. */
export function loadSeats(storage: Pick<Storage, 'getItem'>): SeatMap {
  try {
    const raw = storage.getItem(SEATS_KEY);
    if (raw === null || raw === '') return NO_SEATS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_SEATS;
    return Object.freeze(Object.fromEntries(Object.entries(parsed).filter(([, value]) => isDesk(value))));
  } catch {
    // Corrupt JSON or a blocked storage: start with fresh desks, which is always safe.
    return NO_SEATS;
  }
}

/** Saves the desk numbers; a full or blocked storage only costs desk stability, so it never throws. */
export function saveSeats(storage: Pick<Storage, 'setItem'>, seats: SeatMap): void {
  try {
    storage.setItem(SEATS_KEY, JSON.stringify(seats));
  } catch (err) {
    reportError('saving office desks', err);
  }
}

/** window.localStorage, or null where reading it throws (blocked cookies, sandboxed frames). */
export function deviceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
