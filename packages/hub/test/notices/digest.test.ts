import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, LIMITS, type PresenceDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { formatDigest } from '../../src/notices/digest.js';
import { createNoticesRepo, type NoticeRow } from '../../src/notices/repo.js';
import { createNoticeRouter } from '../../src/notices/router.js';
import { splitForChat } from '../../src/notify/format.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

const NO_QUIET: Settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' } };
const FOUR_PM = '2026-11-14T12:00:00.000Z'; // 4:00 PM in owner time
const MINUTE = 60_000;
const at = (base: string, minutes: number): string => new Date(Date.parse(base) + minutes * MINUTE).toISOString();

function row(id: string, over: Partial<NoticeRow> = {}): NoticeRow {
  return {
    id, kind: 'result', text: `Mission ${id} done`, ref: null, createdAt: FOUR_PM, chatDueAt: at(FOUR_PM, 10), chatSentAt: null,
    chatMsgId: null, settledAt: null, settledVia: null, ...over,
  };
}

const question = (id: string, minute: number): NoticeRow => row(id, {
  kind: 'question', text: `🔴 *Needs your answer* · cedar · meadow-hr  #${id}\nWhich DB?`, ref: { kind: 'question', id },
  createdAt: at(FOUR_PM, minute), chatDueAt: at(FOUR_PM, minute + 10),
});

/** A hub starting at `startIso` on a database that already holds these notices. */
function hubWith(db: Db, startIso: string, opts: { settings?: Settings; mode?: PresenceDTO['mode'] } = {}) {
  const clock = createFakeClock(startIso);
  const chat = createFakeChat();
  const presence = {
    state: (): PresenceDTO => ({ mode: opts.mode ?? 'here', online: true, clients: 1, forcedUntil: null }),
    forced: () => false, capable: () => true,
  };
  const bus = createBus();
  const router = createNoticeRouter({ state: { webTabHello: () => true, setWebTabHello: () => undefined },  db, bus, clock, log: silentLogger(), chat, presence, settings: { get: () => opts.settings ?? NO_QUIET } });
  const pass = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= Math.min(left, 1_000)) {
      clock.advance(Math.min(left, 1_000));
      await vi.advanceTimersByTimeAsync(Math.min(left, 1_000));
    }
  };
  return { clock, chat, router, bus, pass, texts: () => chat.sent.map((s) => s.text) };
}

function seed(rows: readonly NoticeRow[]): Db {
  const db = openMemoryDb();
  const repo = createNoticesRepo(db);
  for (const r of rows) repo.insert(r);
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a backlog never leaves as a stream', () => {
  it('restart at 5:00 PM with 2 questions and 6 results overdue: 2 red messages and ONE digest, 3 seconds apart, all sent', async () => {
    const results = Array.from({ length: 6 }, (_, i) => row(`r${i}`, { createdAt: at(FOUR_PM, i * 5), chatDueAt: at(FOUR_PM, i * 5 + 10) }));
    const db = seed([question('Q1', 1), question('Q2', 2), ...results]);
    const t = hubWith(db, at(FOUR_PM, 60));
    t.router.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.texts()).toHaveLength(1);
    await t.pass(2_999);
    expect(t.texts()).toHaveLength(1);
    await t.pass(1);
    expect(t.texts()).toHaveLength(2);
    await t.pass(3_000);
    expect(t.texts()).toHaveLength(3);
    const [first, second, digest] = t.texts();
    expect(first).toContain('#Q1');
    expect(second).toContain('#Q2');
    expect(digest?.split('\n')).toEqual([
      '📦 *6 updates* · 5:00 PM',
      '• 4:00 PM · Mission r0 done', '• 4:05 PM · Mission r1 done', '• 4:10 PM · Mission r2 done',
      '• 4:15 PM · Mission r3 done', '• 4:20 PM · Mission r4 done', '• 4:25 PM · Mission r5 done',
    ]);
    expect(t.chat.sent[2]?.link).toBeNull();
    const list = t.router.list();
    expect(list.filter((n) => n.kind === 'result').every((n) => n.settledVia === 'test-channel' && n.chatSentAt !== null)).toBe(true);
    expect(list.filter((n) => n.kind === 'question').every((n) => n.settledAt === null && n.chatSentAt !== null)).toBe(true);
    await t.pass(15 * MINUTE);
    expect(t.texts()).toHaveLength(3);
    t.router.stop();
  });

  it('five red questions at once: three alone, the other two named in the digest', async () => {
    const db = seed(['A', 'B', 'C', 'D', 'E'].map((id, i) => question(id, i)));
    const t = hubWith(db, at(FOUR_PM, 30));
    t.router.start();
    await t.pass(10_000);
    expect(t.texts().map((text) => text.split('\n')[0])).toEqual([
      '🔴 *Needs your answer* · cedar · meadow-hr  #A', '🔴 *Needs your answer* · cedar · meadow-hr  #B',
      '🔴 *Needs your answer* · cedar · meadow-hr  #C',
      '📦 *2 updates* · 4:30 PM',
    ]);
    expect(t.texts()[3]?.split('\n').slice(1)).toEqual([
      '• 4:03 PM · 🔴 Needs your answer · cedar · meadow-hr #D', '• 4:04 PM · 🔴 Needs your answer · cedar · meadow-hr #E',
    ]);
    expect(t.router.list().every((n) => n.chatSentAt !== null && n.settledAt === null)).toBe(true);
    t.router.stop();
  });

  it('fourteen results after "Updates: chat": ten lines, then "+4 more on the website"', async () => {
    const db = openMemoryDb();
    const t = hubWith(db, FOUR_PM);
    t.router.start();
    for (let i = 0; i < 14; i += 1) {
      await t.router.post({ kind: 'result', source: 'hub', text: `Result ${i}`, ref: null });
      t.clock.advance(MINUTE);
    }
    t.bus.emit('presence.updated', { mode: 'chat', online: true, clients: 1, forcedUntil: at(FOUR_PM, 74) });
    await t.pass(5_000);
    expect(t.texts()).toHaveLength(1);
    const lines = t.texts()[0]?.split('\n') ?? [];
    expect(lines[0]).toBe('📦 *14 updates* · 4:14 PM');
    expect(lines.slice(1, 11)).toHaveLength(10);
    expect(lines[10]).toBe('• 4:09 PM · Result 9');
    expect(lines.slice(11)).toEqual(['+4 more on the website']);
    expect(t.router.list().every((n) => n.settledVia === 'test-channel')).toBe(true);
    t.router.stop();
  });

  it('results older than 12 hours (yesterday 7 PM, hub back at 8 AM) appear only as a count', async () => {
    const yesterday = '2026-11-13T15:00:00.000Z'; // 7:00 PM in owner time
    const old = [0, 1, 2].map((i) => row(`old${i}`, { createdAt: at(yesterday, i), chatDueAt: at(yesterday, i + 10) }));
    const fresh = [0, 1].map((i) => row(`new${i}`, { text: `Fresh ${i}`, createdAt: at('2026-11-14T03:40:00.000Z', i), chatDueAt: at('2026-11-14T03:50:00.000Z', i) }));
    const t = hubWith(seed([...old, ...fresh]), '2026-11-14T04:00:00.000Z'); // 8:00 AM
    t.router.start();
    await t.pass(1_000);
    expect(t.texts()).toEqual([['📦 *5 updates* · 8:00 AM', '• 7:40 AM · Fresh 0', '• 7:41 AM · Fresh 1', '+3 older ones (over 12 hours) on the website'].join('\n')]);
    t.router.stop();
  });

  it('exactly three due at once still go one by one', async () => {
    const t = hubWith(seed([row('a'), row('b'), row('c')]), at(FOUR_PM, 30));
    t.router.start();
    await t.pass(10_000);
    expect(t.texts()).toEqual(['Mission a done', 'Mission b done', 'Mission c done']);
    t.router.stop();
  });

  it('when the link comes back with five due, they leave as one digest; at the end of quiet hours too', async () => {
    const back = hubWith(seed(['a', 'b', 'c', 'd', 'e'].map((id) => row(id))), at(FOUR_PM, 9));
    back.chat.up = false;
    back.router.start();
    await back.pass(30 * MINUTE);
    expect(back.chat.sent).toEqual([]);
    back.chat.up = true;
    await back.pass(5_000);
    expect(back.texts()).toHaveLength(1);
    expect(back.texts()[0]?.startsWith('📦 *5 updates*')).toBe(true);
    back.router.stop();
    const night = '2026-11-13T20:30:00.000Z'; // 12:30 AM in owner time
    const quiet = hubWith(seed(['a', 'b', 'c', 'd'].map((id) => row(id, { createdAt: night, chatDueAt: at(night, 10) }))), night, { settings: DEFAULT_SETTINGS });
    quiet.router.start();
    await quiet.pass(15 * MINUTE);
    expect(quiet.chat.sent).toEqual([]);
    quiet.clock.set('2026-11-14T03:59:58.000Z');
    await quiet.pass(10_000);
    expect(quiet.texts()).toHaveLength(1);
    expect(quiet.texts()[0]?.split('\n')[0]).toBe('📦 *4 updates* · 8:00 AM');
    quiet.router.stop();
  });

  it('the digest always fits in one chat message', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`x${i}`, { text: `${'🚀 very long result text '.repeat(200)}${i}` }));
    const text = formatDigest(rows, new Date(at(FOUR_PM, 60)));
    expect(text.length).toBeLessThanOrEqual(LIMITS.chatMessageMax);
    expect(splitForChat(text, 3500)).toHaveLength(1);
    expect(text.split('\n')).toHaveLength(12);
  });
});
