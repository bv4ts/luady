import type { Palette } from '@luady/office';
import type { WinDTO, WinsDTO } from '@luady/shared';
import type { RoomLookup } from '../../../rooms/room-lookup.js';
import { compareOffices, officeHosts } from '../library/library-model.js';
import { WEEKDAYS, dayKey, ownerParts, startOfOwnerDay } from '../schedule/owner-time.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;

export interface WinDay {
  readonly key: string;
  readonly label: string;
  readonly items: readonly WinDTO[];
}

/** "Today", "Yesterday", else "Monday, Nov 10" (owner days). */
export function winDayLabel(ms: number, now: number): string {
  const diff = Math.round((startOfOwnerDay(now) - startOfOwnerDay(ms)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const p = ownerParts(ms);
  return `${WEEKDAYS[p.weekday] ?? ''}, ${MONTHS[p.month - 1] ?? ''} ${String(p.day)}`;
}

/** The wins by owner day, newest day first and newest win first inside a day. */
export function winsByDay(items: readonly WinDTO[], now: number): readonly WinDay[] {
  const sorted = items.filter((item) => Number.isFinite(Date.parse(item.doneAt))).toSorted((a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt));
  const days: { key: string; label: string; items: WinDTO[] }[] = [];
  for (const item of sorted) {
    const at = Date.parse(item.doneAt);
    const key = dayKey(at);
    const last = days.at(-1);
    if (last !== undefined && last.key === key) last.items.push(item);
    else days.push({ key, label: winDayLabel(at, now), items: [item] });
  }
  return days;
}

export interface OfficeCount {
  readonly server: string;
  readonly name: string;
  readonly palette: Palette;
  readonly count: number;
}

/**
 * The week per office, in reading order: every room's host (zero included), then any other host that shipped
 * something: a count, never a ranking.
 */
export function officeCounts(byServer: WinsDTO['byServer'], lookup: RoomLookup): readonly OfficeCount[] {
  const hosts = [...new Set([...officeHosts(lookup), ...Object.keys(byServer)])].toSorted(compareOffices(lookup));
  return hosts.map((server) => ({
    server, name: lookup.hostLabel(server), palette: lookup.roomPalette(server), count: byServer[server] ?? 0,
  }));
}

/** "5 shipped this week" / "Nothing shipped yet this week". */
export function weekLine(total: number): string {
  if (total === 0) return 'Nothing shipped yet this week';
  return `${String(total)} shipped this week`;
}

const KNOWN_LINKS: readonly (readonly [RegExp, string])[] = [
  [/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/, 'Pull request #$1'],
  [/gitlab\.com\/.+\/merge_requests\/(\d+)/, 'Merge request !$1'],
  [/atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)/, 'Ticket $1'],
  [/github\.com\/[^/]+\/[^/]+\/commit\/([0-9a-f]{7})/, 'Commit $1'],
];

/** A link in a few words: "Pull request #42", "Ticket ORC-12", else the host and the last part of the path. */
export function linkLabel(url: string): string {
  for (const [re, label] of KNOWN_LINKS) {
    const match = re.exec(url);
    if (match !== null) return label.replace('$1', match[1] ?? '');
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const tail = parsed.pathname.split('/').filter(Boolean).at(-1);
    return tail === undefined ? host : `${host} · ${decodeURIComponent(tail).slice(0, 24)}`;
  } catch {
    return url.slice(0, 40);
  }
}

/** A photo's slight tilt, the same for a card every time (-2.5 to 2.5 degrees). */
export function tiltOf(id: number): number {
  return ((id * 37) % 11) / 2 - 2.5;
}
