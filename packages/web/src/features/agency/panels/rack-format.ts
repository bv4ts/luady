import { ownerFormat } from '@luady/shared';
import { formatClock } from '../hud/Clock.js';

const DAY = ownerFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const MONTH_DAY = ownerFormat('en-US', { month: 'short', day: 'numeric' });

/** Kilobytes as gigabytes with one decimal: "3.8 GB". */
export function gb(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

/** "3:20 PM" today in owner time, "Oct 9, 3:20 PM" on another day, "never" without a time. */
export function seenAt(iso: string | null, now: number): string {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(at)) return 'never';
  const time = formatClock(at);
  return DAY.format(at) === DAY.format(now) ? time : `${MONTH_DAY.format(at)}, ${time}`;
}

/** Load averages as plain numbers. */
export function loadText(load1: number, load5: number): string {
  return `${load1.toFixed(2)} over 1 min, ${load5.toFixed(2)} over 5 min`;
}
