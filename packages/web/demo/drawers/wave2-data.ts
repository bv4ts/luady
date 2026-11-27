import type { BoardItemDTO, FleetHistoryDTO, LinkDTO, ScheduleItemDTO, TimelineItem, WinDTO } from '@luady/shared';
import { dayKey, dayStart, ownerMs, ownerParts, startOfOwnerDay } from '../../src/features/agency/drawers/schedule/owner-time.js';

/** Fixtures for the drawers demo page: the fleet wall, wins, the today strip, the schedule, links and reminders. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Deterministic noise: the same wiggle every time the page loads. */
const wiggle = (i: number, seed: number): number => Math.sin(i * 0.21 + seed) * 0.5 + Math.sin(i * 0.057 + seed * 2) * 0.35 + Math.sin(i * 1.3 + seed) * 0.15;

export function fleetHistory(now: number): FleetHistoryDTO {
  const end = Math.floor(now / 1000);
  const ts = Array.from({ length: 240 }, (_, i) => end - (239 - i) * 360);
  const server = (seed: number, load: number, mem: number, disk: number | null) =>
    ts.map((t, i) => [t, Math.max(0, load + wiggle(i, seed) * load * 0.8), Math.min(99, Math.max(5, mem + wiggle(i, seed + 1) * 12)),
      disk === null ? null : Math.min(99, disk + i * 0.01)] as [number, number, number, number | null]);
  const limit = (seed: number, base: number) => ts.map((t, i) => {
    const cycle = (i % 50) / 50;
    return [t, Math.min(100, base * cycle + Math.max(0, wiggle(i, seed)) * 8), Math.min(100, 30 + i * 0.13)] as [number, number | null, number | null];
  });
  return {
    servers: [
      { name: 'birch', points: server(1, 3, 82, 76) },
      { name: 'cedar', points: server(2, 0.6, 38, 41) },
      { name: 'ash', points: server(3, 1.6, 64, null) },
      { name: 'local', points: server(4, 0.3, 25, 18) },
    ],
    accounts: [
      { id: 'claude:org_max', label: 'owner@example.com', points: limit(5, 96) },
      { id: 'claude:org_luady', label: 'Luady', points: limit(6, 30) },
    ],
  };
}

export function wins(now: number): { items: WinDTO[]; byServer: Partial<Record<'birch' | 'cedar' | 'ash' | 'local', number>> } {
  const win = (id: number, hoursAgo: number, title: string, server: WinDTO['server'], project: string | null, result: string, links: string[] = []): WinDTO =>
    ({ id, title, server, project, result, links, doneAt: iso(now - hoursAgo * HOUR) });
  const items = [
    win(31, 1.2, 'Checkout total includes the delivery fee', 'birch', 'orchard-web', 'Coupon and delivery fee add up; 14 tests added.', ['https://github.com/example-org/web/pull/482', 'https://staging.orchard.example/checkout']),
    win(29, 3.5, 'Payroll export uses ISO dates', 'birch', 'orchard-backend', 'export.ts and csv.ts write 2026-11-15; payroll tests pass.', ['https://github.com/example-org/backend/pull/1290']),
    win(27, 5, 'Harbor admin: bulk invite', 'ash', 'harbor-admin', 'Invite 50 users from a CSV.', ['https://github.com/example-org/admin/pull/77']),
    win(25, 20, 'VAT return PDF matches the tax form', 'cedar', 'meadow-vat', 'Boxes 1–12 line up; long labels wrap cleanly.', ['https://meadow-vat.example/returns']),
    win(24, 26, 'Menu import streams large files', 'birch', 'orchard-backend', 'A 40 MB menu imports in 19 seconds.', ['https://orchard-demo.atlassian.net/browse/ORC-1130']),
    win(22, 49, 'Store desk shows prep time', 'birch', 'orchard-store', 'Prep time per order on the tablet.'),
    win(21, 53, 'Picture desk: new hero image', 'local', 'pictures', 'Three options for the landing page.'),
    win(19, 74, 'Meadow API rate limits', 'cedar', 'meadow-api', '429 with Retry-After on every route.', ['https://github.com/example-org/api/pull/203']),
    win(17, 98, 'Harbor web: Arabic search', 'ash', 'harbor-web', 'Search finds words with and without diacritics.'),
  ];
  return { items, byServer: { birch: 4, ash: 2, cedar: 2, local: 1 } };
}

export function timeline(day: string | null, now: number): { day: string; items: TimelineItem[] } {
  const today = dayKey(now);
  const key = day ?? today;
  const start = dayStart(key) ?? startOfOwnerDay(now);
  const at = (hour: number, minute: number) => iso(start + hour * HOUR + minute * MINUTE);
  const item = (h: number, m: number, kind: TimelineItem['kind'], label: string, server: TimelineItem['server'], ref: TimelineItem['ref'] = null): TimelineItem =>
    ({ at: at(h, m), kind, label, server, ref });
  const all: TimelineItem[] = [
    item(6, 40, 'arrived', 'app-backend', 'birch', { kind: 'session', id: 'birch:app-backend:0.0' }),
    item(7, 5, 'started', 'Payroll export uses ISO dates', 'birch', { kind: 'todo', id: '24' }),
    item(8, 30, 'meeting', 'Stand-up', null, { kind: 'note', id: 'm:standup-1114' }),
    item(8, 58, 'asked', 'jira-1105: which coupon wins?', 'birch', { kind: 'question', id: 'QASKAAAA' }),
    item(9, 10, 'answered', 'jira-1105: the larger one', 'birch'),
    item(9, 40, 'arrived', 'harbor-api', 'ash', { kind: 'session', id: 'ash:harbor-api:0.0' }),
    item(10, 15, 'done', 'Harbor admin: bulk invite', 'ash', { kind: 'todo', id: '27' }),
    item(10, 16, 'left', 'harbor-admin', 'ash'),
    item(11, 2, 'started', 'VAT return PDF', 'cedar', { kind: 'todo', id: '25' }),
    item(11, 45, 'alert', 'The cedar account is at 96% of its 5-hour limit', 'cedar'),
    item(12, 20, 'done', 'Payroll export uses ISO dates', 'birch', { kind: 'todo', id: '29' }),
    item(12, 21, 'asked', 'meadow-api asks permission', 'cedar', { kind: 'question', id: 'QPERMAAA' }),
    item(13, 5, 'arrived', 'checkout-fee', 'birch', { kind: 'session', id: 'birch:client-preferences:0.0' }),
    item(13, 50, 'done', 'Checkout total includes the delivery fee', 'birch', { kind: 'todo', id: '31' }),
    item(14, 30, 'meeting', 'Design review', null),
    item(15, 15, 'started', 'Menu import streams large files', 'birch', { kind: 'todo', id: '24' }),
    item(16, 40, 'left', 'figma-sync', 'birch'),
    item(18, 5, 'done', 'Arabic search', 'ash'),
    item(20, 30, 'alert', 'orchard-android stopped with an error', 'birch', { kind: 'session', id: 'birch:orchard-android:0.0' }),
  ];
  return { day: key, items: all.filter((one) => key !== today || Date.parse(one.at) <= now) };
}

/** The next owner wall time at hour:minute after `now` on one of `days` (0 = Sunday; all days when left out). */
function nextAt(now: number, hour: number, minute: number, days?: readonly number[]): string {
  const today = ownerParts(now);
  for (let offset = 0; offset < 40; offset += 1) {
    const at = ownerMs(today.year, today.month, today.day + offset, hour, minute);
    const day = ownerParts(at);
    if (at > now && (days === undefined || days.includes(day.weekday)) && (hour !== 6 || day.day === 1 || days !== undefined)) return iso(at);
  }
  return iso(now + 24 * HOUR);
}

export function schedules(now: number): ScheduleItemDTO[] {
  const once = new Date(now + 3 * HOUR);
  return [
    { id: 'sch_1', when: '0 9 * * 1-5', task: 'Check the overnight deploys and tell me what failed', nextRunAt: nextAt(now, 9, 0, [1, 2, 3, 4, 5]) },
    { id: 'sch_2', when: '30 17 * * 4', task: 'Remind me to send the weekly invoices to Finance', nextRunAt: nextAt(now, 17, 30, [4]) },
    { id: 'sch_3', when: once.toISOString().replace('Z', '+00:00'), task: 'Call Omar about the iOS release', nextRunAt: iso(once.getTime()) },
    { id: 'sch_4', when: '0 21 * * *', task: 'Summarise the day in the chat', nextRunAt: nextAt(now, 21, 0) },
    { id: 'sch_5', when: '0 6 1 * *', task: 'Rotate the staging passwords', nextRunAt: nextAt(now, 6, 0) },
  ];
}

export const LINKS: LinkDTO[] = [
  { id: 1, server: 'birch', label: 'Jira board', url: 'https://orchard-demo.atlassian.net/jira/software/projects/ORC/boards/1', position: 0 },
  { id: 2, server: 'birch', label: 'GitHub', url: 'https://git.example/orchard', position: 1 },
  { id: 3, server: 'birch', label: 'Staging', url: 'https://staging.orchard.example', position: 2 },
  { id: 4, server: 'birch', label: 'Figma: checkout', url: 'https://www.figma.com/file/abc/checkout', position: 3 },
  { id: 5, server: 'birch', label: 'App Store Connect', url: 'https://appstoreconnect.apple.com/apps', position: 4 },
  { id: 6, server: 'birch', label: 'Play Console', url: 'https://play.google.com/console', position: 5 },
  { id: 7, server: 'birch', label: 'Sentry', url: 'https://errors.example/organizations/orchard', position: 6 },
  { id: 8, server: 'cedar', label: 'tax portal', url: 'https://tax-portal.example', position: 0 },
];

/** Board cards with a due date (one passed) and two hidden for later. */
export function remindCards(now: number): BoardItemDTO[] {
  const card = (id: number, title: string, over: Partial<BoardItemDTO>): BoardItemDTO => ({
    id, title, details: '', project: null, server: 'birch', source: 'web', sourceRef: null, state: 'open', today: false, priority: 0, auto: false,
    runId: null, sessionId: null, result: null, createdAt: iso(now - 30 * HOUR), updatedAt: iso(now - HOUR), doneAt: null, dueAt: null, snoozeUntil: null, ...over,
  });
  return [
    card(60, 'Send the App Store screenshots', { project: 'dev_orchard-ios', dueAt: iso(now - 2 * HOUR), details: 'Six screenshots, English and Arabic.' }),
    card(61, 'Renew the staging certificate', { project: 'orchard-web', dueAt: iso(now + 50 * HOUR) }),
    card(62, 'Ask Sara about the coupon edge cases', { snoozeUntil: iso(now + 18 * HOUR) }),
    card(63, 'Review the Harbor pricing page', { server: 'ash', project: 'harbor-web', snoozeUntil: iso(now + 70 * HOUR) }),
  ];
}
