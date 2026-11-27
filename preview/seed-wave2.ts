import { randomUUID } from 'node:crypto';
import { formatOffset, localParts, ownerZone, wallTimeToUtc, zoneOffsetMs, type BoardItemDTO, type CreateLinkBody, type LinkDTO, type HostId } from '@luady/shared';
import type { BoardActor, BoardAddInput, BoardPatch, Db } from '../packages/hub/dist/core/contracts.js';

/**
 * The extras seed: links per office, Luady's schedules (one-off and repeating), a week of done cards with results and
 * links for the wins wall, events across today and yesterday for the today strip, and cards that are snoozed, due
 * soon and overdue. Runs once per database (the links table being empty says so).
 */

export interface Wave2SeedHub {
  readonly db: Db;
  readonly clock: () => Date;
  readonly board: {
    add(input: BoardAddInput, by: BoardActor): Promise<BoardItemDTO>;
    update(id: number, patch: BoardPatch, by: BoardActor): Promise<BoardItemDTO>;
  };
  readonly links: { list(): LinkDTO[]; create(body: CreateLinkBody): Promise<LinkDTO> };
  readonly scheduler: { list(): readonly unknown[]; add(when: string, task: string): unknown };
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/**
 * An instant `daysAgo` owner days back at `hh:mm` owner time, in the zone the preview stored (ownerZone: the fixed
 * zone for tests and `--clock`, else the machine's own), summer time included.
 */
export function ownerAt(now: Date, daysAgo: number, hh: number, mm: number, tz: string = ownerZone()): Date {
  const today = localParts(tz, now.getTime());
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day - daysAgo));
  return new Date(wallTimeToUtc(tz, { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: hh, minute: mm }));
}

/** `HH:MM` → ISO with the owner's offset for the next such time after `now` (a one-off schedule). */
export function nextOwnerIso(now: Date, hh: number, mm: number, tz: string = ownerZone()): string {
  let at = ownerAt(now, 0, hh, mm, tz);
  if (at.getTime() <= now.getTime()) at = ownerAt(now, -1, hh, mm, tz);
  const offsetMs = zoneOffsetMs(tz, at.getTime());
  const local = new Date(at.getTime() + offsetMs).toISOString().slice(0, 19);
  return `${local}${formatOffset(Math.round(offsetMs / MIN_MS))}`;
}

export const PREVIEW_LINKS: readonly CreateLinkBody[] = [
  { server: 'birch', label: 'Jira board', url: 'https://luady-preview.atlassian.net/jira/software/projects/ORC/boards/1' },
  { server: 'birch', label: 'GitHub', url: 'https://git.example/orchard/orchard-api' },
  { server: 'birch', label: 'Staging', url: 'https://staging.orchard.example' },
  { server: 'birch', label: 'App Store Connect', url: 'https://appstoreconnect.apple.com' },
  { server: 'ash', label: 'Harbor site', url: 'https://harbor.example' },
  { server: 'ash', label: 'Figma', url: 'https://www.figma.com/files/example-harbor' },
  { server: 'ash', label: 'GitHub', url: 'https://git.example/harbor/harbor-web' },
  { server: 'cedar', label: 'Meadow admin', url: 'https://admin.meadow.example' },
  { server: 'cedar', label: 'VAT portal', url: 'https://tax.example/vat' },
  { server: 'local', label: 'Research notes', url: 'https://notes.example/research' },
];

interface Win { title: string; server: HostId; project: string; result: string; daysAgo: number; hh: number; mm: number }

/** A week of shipped work for the wins wall (and yesterday's part of the today strip). */
const WINS: readonly Win[] = [
  { title: 'Checkout total includes the delivery fee', server: 'birch', project: 'app-backend', daysAgo: 1, hh: 15, mm: 40,
    result: 'Fixed and deployed: https://github.com/example-org/orchard-api/pull/412 https://staging.orchard.example/checkout' },
  { title: 'Saved cards API for returning customers', server: 'birch', project: 'app-backend', daysAgo: 1, hh: 11, mm: 20,
    result: 'Merged: https://github.com/example-org/orchard-api/pull/409' },
  { title: 'Arabic home page copy reviewed', server: 'ash', project: 'harbor-new-home', daysAgo: 2, hh: 13, mm: 5,
    result: 'Copy merged: https://github.com/example-org/harbor-web/pull/88' },
  { title: 'VAT return draft for October', server: 'cedar', project: 'meadow-vat', daysAgo: 3, hh: 10, mm: 30,
    result: 'Draft ready to review: https://admin.meadow.example/vat/october' },
  { title: 'Store screenshots for 4.12', server: 'birch', project: 'app-frontend', daysAgo: 4, hh: 16, mm: 15,
    result: 'Uploaded for review on both stores.' },
  { title: 'Nightly backup check', server: 'local', project: 'research-desk', daysAgo: 5, hh: 9, mm: 45,
    result: 'All three backups restored cleanly in a scratch folder.' },
  { title: 'Promo code expiry check', server: 'birch', project: 'app-backend', daysAgo: 0, hh: -1, mm: 35,
    result: 'Expired codes are refused now: https://github.com/example-org/orchard-api/pull/415' },
];

function backDate(db: Db, id: number, createdAt: Date, doneAt: Date | null): void {
  const created = createdAt.toISOString();
  const done = doneAt?.toISOString() ?? null;
  db.prepare('UPDATE todos SET created_at = ?, updated_at = ?, done_at = COALESCE(?, done_at) WHERE id = ?').run(created, done ?? created, done, id);
  db.prepare("UPDATE todo_events SET at = ? WHERE todo_id = ? AND kind IN ('created', 'edited')").run(created, id);
  if (done !== null) {
    db.prepare("UPDATE todo_events SET at = ? WHERE todo_id = ? AND kind = 'done'").run(done, id);
    const started = new Date((doneAt as Date).getTime() - 50 * MIN_MS).toISOString();
    db.prepare("INSERT INTO todo_events (todo_id, at, kind, text) VALUES (?, ?, 'started', 'A session took it.')").run(id, started);
  }
}

async function seedWins(hub: Wave2SeedHub, now: Date): Promise<void> {
  for (const win of WINS) {
    const doneAt = win.hh < 0 ? new Date(now.getTime() - win.mm * MIN_MS) : ownerAt(now, win.daysAgo, win.hh, win.mm);
    const card = await hub.board.add({ title: win.title, server: win.server, project: win.project, source: 'web' }, 'owner');
    await hub.board.update(card.id, { state: 'done', result: win.result }, 'hub');
    backDate(hub.db, card.id, new Date(doneAt.getTime() - 3 * HOUR_MS), doneAt);
  }
}

/** Sessions that arrived and left yesterday, and alerts today and yesterday (settled: nothing waits on them). */
function seedEvents(db: Db, now: Date): void {
  const event = db.prepare('INSERT INTO events (id, host, session_id, type, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)');
  const visits: ReadonlyArray<[string, string, number, number, number, number]> = [
    ['cedar', 'cedar:cc-meadow-hr:0.0', 8, 55, 18, 10],
    ['birch', 'birch:cc-release-notes:0.0', 10, 5, 12, 40],
    ['ash', 'ash:cc-harbor-api:0.0', 14, 20, 17, 0],
  ];
  for (const [host, sessionId, inH, inM, outH, outM] of visits) {
    event.run(randomUUID(), host, sessionId, 'session_start', ownerAt(now, 1, inH, inM).toISOString(), JSON.stringify({ data: { source: 'startup' } }));
    event.run(randomUUID(), host, sessionId, 'session_end', ownerAt(now, 1, outH, outM).toISOString(), JSON.stringify({ data: { reason: 'prompt_input_exit' } }));
  }
  const notice = db.prepare(
    "INSERT INTO notices (id, kind, text, ref_kind, ref_id, created_at, settled_at, settled_via) VALUES (?, 'alert', ?, ?, ?, ?, ?, 'web')",
  );
  const alerts: ReadonlyArray<[string, string | null, string | null, Date]> = [
    ['Server ash was offline for 4 minutes and came back.', null, null, ownerAt(now, 1, 16, 20)],
    ['push-notifs stopped: the usage limit was reached.', 'session', 'birch:cc-push-notifs:0.0', new Date(now.getTime() - 50 * MIN_MS)],
  ];
  for (const [text, refKind, refId, at] of alerts) notice.run(randomUUID(), text, refKind, refId, at.toISOString(), at.toISOString());
}

/** Snoozed until later today and tomorrow, due in a few minutes, and overdue: Later, chips and their notices. */
async function seedReminders(hub: Wave2SeedHub, now: Date): Promise<void> {
  const add = async (title: string, server: HostId, project: string, patch: BoardPatch) => {
    const card = await hub.board.add({ title, server, project, source: 'web' }, 'owner');
    await hub.board.update(card.id, patch, 'owner');
  };
  await add('Call the bank about the card terminal', 'birch', 'app-backend', { snoozeUntil: new Date(now.getTime() + 3 * MIN_MS).toISOString() });
  await add('Plan the Harbor launch post', 'ash', 'harbor-web-app', { snoozeUntil: ownerAt(now, -1, 9, 0).toISOString() });
  await add('Send the October invoice to Meadow', 'cedar', 'meadow-hr', { dueAt: new Date(now.getTime() + 5 * MIN_MS).toISOString() });
  await add('Renew the Apple developer account', 'birch', 'app-frontend', { dueAt: new Date(now.getTime() - 2 * HOUR_MS).toISOString(), priority: 1 });
}

function seedSchedules(hub: Wave2SeedHub, now: Date): void {
  if (hub.scheduler.list().length > 0) return;
  hub.scheduler.add(nextOwnerIso(now, 9, 0), 'Remind the owner to send the VAT return for October.');
  hub.scheduler.add('0 9 * * 1-5', 'Check the Orchard staging build and tell the owner if it is red.');
  hub.scheduler.add('30 17 * * 4', 'Collect this week\'s wins for the Thursday update.');
}

/** True when it seeded; false when the database already had links (a kept preview folder). */
export async function seedWave2(hub: Wave2SeedHub): Promise<boolean> {
  if (hub.links.list().length > 0) return false;
  const now = hub.clock();
  for (const link of PREVIEW_LINKS) await hub.links.create(link);
  seedSchedules(hub, now);
  await seedWins(hub, now);
  seedEvents(hub.db, now);
  await seedReminders(hub, now);
  return true;
}
