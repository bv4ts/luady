import { ownerFormat } from '@luady/shared';

const MINUTE_MS = 60_000;
const OFFSET_RE = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/;
const offsetFormatter = ownerFormat('en-US', { timeZoneName: 'longOffset' });
const dateFormatter = ownerFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });

/** UTC offset of the owner's zone at `at`, in ms (the zone is read at every call). */
export function zoneOffsetMs(at: Date): number {
  const name = offsetFormatter.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = OFFSET_RE.exec(name);
  if (!match?.[1]) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? '0')) * MINUTE_MS;
}

/** Calendar date in the owner's zone, e.g. "2026-10-09". */
export function ownerDateKey(at: Date): string {
  const parts = dateFormatter.formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
