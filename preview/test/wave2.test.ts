import { createServer } from 'node:net';
import type {
  BoardListDTO, FleetHistoryDTO, LinkListDTO, MeDTO, NoticeListDTO, RecapDTO, ScheduleListDTO, TimelineDTO, WinsDTO,
} from '@luady/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPreview, type Preview } from '../main.ts';
import { PAGE_HOOK_PATH } from '../page-hook.ts';
import { ownerAt } from '../seed-wave2.ts';
import { signInPreview, signedIn } from './sign-in.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

let preview: Preview;
let cookie = '';
/** The page key of the sign-in. */
let pageKey = '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${preview.url}${path}`, { headers: signedIn({ cookie, pageKey }) });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}
async function drive(scenario: string, args: readonly string[]): Promise<string> {
  const res = await fetch(`${preview.url}/__preview/run`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `https://localhost:${preview.port}` }, body: JSON.stringify({ scenario, args }),
  });
  const body = (await res.json()) as { ok: boolean; result?: string; error?: string };
  if (!body.ok) throw new Error(body.error);
  return body.result ?? '';
}
const ownerDay = (at: Date): string => new Date(at.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);

describe('the fleet wall, links, wins, today strip and reminders in a running preview', () => {
  beforeAll(async () => {
    preview = await startPreview({ port: await freePort(), env: {} });
    await preview.ready;
    ({ cookie, pageKey } = await signInPreview(preview));
    expect(((await (await fetch(`${preview.url}/api/me`, { headers: signedIn({ cookie, pageKey }) })).json()) as MeDTO).pinSet).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await preview?.stop();
  });

  it('the fleet wall has 24 hours of graphs at once; local runs an older kit without disk size', async () => {
    const history = await get<FleetHistoryDTO>('/api/fleet/history');
    for (const server of history.servers) {
      expect(server.points.length, server.name).toBeGreaterThan(200);
      const span = server.points.at(-1)![0] - server.points[0]![0];
      expect(span).toBeGreaterThan(23 * 3600);
    }
    expect(history.servers.find((s) => s.name === 'local')?.points.every((p) => p[3] === null)).toBe(true);
    expect(history.servers.find((s) => s.name === 'birch')?.points.every((p) => typeof p[3] === 'number')).toBe(true);
    // Every Claude account the Accounts list shows has its 24 hours (the same ids as the wall's rows).
    const accounts = (await get<{ accounts: Array<{ id: string; provider: string }> }>('/api/accounts')).accounts
      .filter((a) => a.provider === 'claude');
    const withHistory = new Set(history.accounts.filter((a) => a.points.length > 50).map((a) => a.id));
    expect(accounts.filter((a) => withHistory.has(a.id)).length).toBeGreaterThanOrEqual(3);
  });

  it('links per office and Luady\'s schedules, one-off and repeating', async () => {
    const links = (await get<LinkListDTO>('/api/links')).items;
    expect(new Set(links.map((l) => l.server))).toEqual(new Set(['birch', 'ash', 'cedar', 'local']));
    expect(links.every((l) => l.url.startsWith('https://'))).toBe(true);
    const schedules = (await get<ScheduleListDTO>('/api/schedules')).items;
    expect(schedules.some((s) => s.when.endsWith('+04:00'))).toBe(true);
    expect(schedules.some((s) => s.when === '0 9 * * 1-5')).toBe(true);
    expect(schedules.every((s) => s.nextRunAt !== null)).toBe(true);
  });

  it('the wins wall has a week of done cards with results and links', async () => {
    const wins = await get<WinsDTO>('/api/wins?days=7');
    expect(wins.items.length).toBeGreaterThanOrEqual(8);
    expect(wins.items.some((w) => w.links.some((l) => l.startsWith('https://github.com/example-org/')))).toBe(true);
    const days = new Set(wins.items.map((w) => ownerDay(new Date(w.doneAt))));
    expect(days.size).toBeGreaterThanOrEqual(5);
    expect(Object.keys(wins.byServer).sort()).toEqual(['ash', 'birch', 'cedar', 'local']);
  });

  it('the today strip has events today and yesterday', async () => {
    const now = new Date();
    const today = await get<TimelineDTO>(`/api/timeline?day=${ownerDay(now)}`);
    const yesterday = await get<TimelineDTO>(`/api/timeline?day=${ownerDay(ownerAt(now, 1, 12, 0))}`);
    // Cards finished at the preview's start are always today, whatever the hour.
    expect(today.items.some((i) => i.kind === 'done')).toBe(true);
    expect([...new Set(yesterday.items.map((i) => i.kind))]).toEqual(expect.arrayContaining(['started', 'done', 'arrived', 'left', 'alert']));
  });

  it('a recap worth showing, and away makes the next page load ask for it', async () => {
    const recap = await get<RecapDTO>(`/api/recap?since=${encodeURIComponent(new Date(Date.now() - 3 * 3_600_000).toISOString())}`);
    expect(recap.finished.length).toBeGreaterThan(2);
    expect(recap.waiting.length).toBeGreaterThan(0);
    expect(recap.failed.length).toBeGreaterThan(0);
    const html = await (await fetch(`${preview.url}/`, { headers: { cookie } })).text();
    expect(html).toContain(PAGE_HOOK_PATH);
    await drive('away', ['120']);
    await drive('light', ['night']);
    const script = await (await fetch(`${preview.url}${PAGE_HOOK_PATH}`, { headers: { cookie } })).text();
    expect(script).toContain('hub.lastHere');
    expect(script).toContain('__LUADY_CLOCK__');
    const again = await (await fetch(`${preview.url}${PAGE_HOOK_PATH}`, { headers: { cookie } })).text();
    expect(again).not.toContain('hub.lastHere');
    await drive('clock', ['off']);
  });

  it('snoozed, due and overdue cards; a snooze that ends and a due time that passes each give their notice', async () => {
    const board = (await get<BoardListDTO>('/api/board')).items;
    expect(board.some((c) => c.snoozeUntil !== null)).toBe(true);
    expect(board.some((c) => c.dueAt !== null && Date.parse(c.dueAt) < Date.now() && c.state !== 'done')).toBe(true);
    await drive('snooze', ['0.02', 'Water', 'the', 'plants']);
    await drive('due', ['0.02', 'Send', 'the', 'contract']);
    await sleep(1_500);
    await drive('remind', []);
    const texts = async () => (await get<NoticeListDTO>('/api/notices?limit=50')).items.map((n) => n.text);
    let seen = await texts();
    for (let i = 0; i < 20 && !(seen.includes('Back on your board: Water the plants') && seen.includes('Due now: Send the contract')); i += 1) {
      await sleep(250);
      seen = await texts();
    }
    expect(seen).toEqual(expect.arrayContaining(['Back on your board: Water the plants', 'Due now: Send the contract']));
    expect(seen.some((text) => text.startsWith('Due now: Renew the Apple developer account'))).toBe(true);
    const plants = (await get<BoardListDTO>('/api/board')).items.find((c) => c.title === 'Water the plants');
    expect(plants?.snoozeUntil).toBeNull();
  });
});
