import { describe, expect, it } from 'vitest';
import { LinkDTOSchema } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createLinksService, reorder } from '../../src/links/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

function setup() {
  const db = openMemoryDb();
  const bus = createBus();
  const changed: string[] = [];
  bus.on('links.changed', ({ at }) => changed.push(at));
  const links = createLinksService({ db, bus, clock: createFakeClock('2026-11-15T12:00:00.000Z'), log: silentLogger() });
  return { db, links, changed };
}

describe('the links shelf', () => {
  it('adds per office in order, renames, moves, removes, and says so each time', async () => {
    const t = setup();
    await t.links.create({ server: 'birch', label: '  Jira  ', url: 'https://orchard-demo.atlassian.net' });
    await t.links.create({ server: 'birch', label: 'GitHub', url: 'https://github.com/orchard' });
    await t.links.create({ server: 'birch', label: 'Staging', url: 'https://staging.orchard.example' });
    await t.links.create({ server: 'cedar', label: 'Store', url: 'https://play.google.com/console' });
    expect(t.links.list().map((link) => [link.server, link.label, link.position])).toEqual([
      ['birch', 'Jira', 0], ['birch', 'GitHub', 1], ['birch', 'Staging', 2], ['cedar', 'Store', 0],
    ]);
    expect(t.links.list().every((link) => LinkDTOSchema.safeParse(link).success)).toBe(true);
    expect(await t.links.update(3, { position: 0, label: 'Staging site' })).toMatchObject({ label: 'Staging site', position: 0 });
    expect(t.links.list().filter((link) => link.server === 'birch').map((link) => link.label)).toEqual(['Staging site', 'Jira', 'GitHub']);
    await t.links.remove(1);
    expect(t.links.list().filter((link) => link.server === 'birch').map((link) => [link.label, link.position])).toEqual([['Staging site', 0], ['GitHub', 1]]);
    expect(t.changed).toHaveLength(6);
  });

  it('only https addresses of at most 500 characters, a name of 1-40', async () => {
    const t = setup();
    for (const url of ['http://x.example', 'javascript:alert(1)', 'ftp://x.example', `https://x.example/${'a'.repeat(500)}`, 'not a url']) {
      await expect(t.links.create({ server: 'birch', label: 'x', url })).rejects.toMatchObject({ code: 'validation' });
    }
    await expect(t.links.create({ server: 'birch', label: '   ', url: 'https://x.example' })).rejects.toMatchObject({ code: 'validation' });
    await expect(t.links.create({ server: 'birch', label: 'x'.repeat(41), url: 'https://x.example' })).rejects.toMatchObject({ code: 'validation' });
    await t.links.create({ server: 'birch', label: 'ok', url: 'https://x.example' });
    await expect(t.links.update(1, { url: 'http://x.example' })).rejects.toMatchObject({ code: 'validation' });
    expect(t.links.list()[0]?.url).toBe('https://x.example');
    expect(t.changed).toHaveLength(1);
  });

  it('at most 12 an office; unknown ids are 404', async () => {
    const t = setup();
    for (let i = 0; i < 12; i += 1) await t.links.create({ server: 'ash', label: `Link ${i}`, url: `https://s${i}.example` });
    await expect(t.links.create({ server: 'ash', label: 'one more', url: 'https://more.example' })).rejects.toMatchObject({ code: 'refused' });
    await expect(t.links.create({ server: 'cedar', label: 'other office', url: 'https://more.example' })).resolves.toMatchObject({ position: 0 });
    await expect(t.links.update(99, { label: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.links.remove(99)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reorder clamps the position', () => {
    expect(reorder([1, 2, 3], 3, 0)).toEqual([3, 1, 2]);
    expect(reorder([1, 2, 3], 1, 99)).toEqual([2, 3, 1]);
    expect(reorder([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
});
