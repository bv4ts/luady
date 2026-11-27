import { describe, expect, it } from 'vitest';
import { WinsDTOSchema } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { createWinsService, linksIn } from '../../src/wins/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { seedCard } from '../timeline/seed.js';

const NOW = '2026-11-15T12:00:00.000Z';

function setup() {
  const db = openMemoryDb();
  return { db, wins: createWinsService({ db, clock: createFakeClock(NOW), log: silentLogger() }) };
}

describe('links in a result or a log', () => {
  it('finds https addresses once each, drops end punctuation, skips http and long ones, at most 5', () => {
    expect(linksIn(['PR: https://github.com/o/r/pull/12. Live at https://staging.example.com, see (https://x.example/a)'])).toEqual([
      'https://github.com/o/r/pull/12', 'https://staging.example.com', 'https://x.example/a',
    ]);
    expect(linksIn(['http://plain.example', `https://long.example/${'a'.repeat(300)}`, 'https://github.com/o/r/pull/12'])).toEqual([
      'https://github.com/o/r/pull/12',
    ]);
    const many = Array.from({ length: 8 }, (_, i) => `https://s${i}.example`).join(' ');
    expect(linksIn([many, 'https://s0.example'])).toHaveLength(5);
  });
});

describe('the wins wall', () => {
  it('done cards of the last days, newest first, with links from the result and the log, and a count per office', () => {
    const t = setup();
    const a = seedCard(t.db, 'Fix the total', '2026-11-10T00:00:00.000Z', { doneAt: '2026-11-14T10:00:00.000Z', server: 'birch', project: 'orchard', result: 'Merged https://github.com/birch/app/pull/7' });
    t.db.prepare("INSERT INTO todo_events (todo_id, at, kind, text) VALUES (?, '2026-11-14T09:00:00.000Z', 'report', 'Preview at https://preview.example.com')").run(a);
    seedCard(t.db, 'Leave report', '2026-11-10T00:00:00.000Z', { doneAt: '2026-11-15T08:00:00.000Z', server: 'cedar' });
    seedCard(t.db, 'Older win', '2026-11-01T00:00:00.000Z', { doneAt: '2026-11-07T08:00:00.000Z', server: 'birch' });
    seedCard(t.db, 'Still open', '2026-11-14T00:00:00.000Z');
    const wins = WinsDTOSchema.parse(t.wins.wins(7));
    expect(wins.items.map((item) => item.title)).toEqual(['Leave report', 'Fix the total']);
    expect(wins.items[1]).toEqual({
      id: a, title: 'Fix the total', project: 'orchard', server: 'birch', result: 'Merged https://github.com/birch/app/pull/7',
      links: ['https://github.com/birch/app/pull/7', 'https://preview.example.com'], doneAt: '2026-11-14T10:00:00.000Z',
    });
    expect(wins.byServer).toEqual({ birch: 1, cedar: 1 });
    expect(t.wins.wins(30).byServer).toEqual({ birch: 2, cedar: 1 });
    expect(t.wins.wins(1).items.map((item) => item.title)).toEqual(['Leave report']);
  });
});
