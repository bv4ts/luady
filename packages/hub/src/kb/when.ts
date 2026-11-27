import { ownerFormat } from '@luady/shared';
import { clock12 } from '../core/time.js';

const DAY_FORMAT = ownerFormat('en-US', { month: 'short', day: 'numeric' });

/** "Nov 15, 3:20 PM" in owner time; the text as it came when it is not a date. */
export function whenText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${DAY_FORMAT.format(date)}, ${clock12(date)}`;
}
