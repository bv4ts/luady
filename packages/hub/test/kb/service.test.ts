import { afterEach, describe, expect, it, vi } from 'vitest';
import { KbPageFullDTOSchema, type CtlKbFile, type ProjectDTO, type ServerDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { NotFoundError, RefusedError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { KB_PROJECTS_CHECK_MS, createKbService } from '../../src/kb/index.js';
import { KB_SYNC_DELAY_MS } from '../../src/kb/sync.js';
import { createFakeFleet, serverDto } from '../fleet/fake-fleet.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';

const ORCHARD: ProjectDTO = {
  server: 'birch', path: '/home/dev/projects/orchard', name: 'orchard', remote: 'git@github.com:o/orchard.git', branch: 'main',
  commits: [{ hash: 'a1b2c3d4e5', date: '2026-11-14T10:00:00+04:00', subject: 'feat: checkout' }], stack: ['php', 'laravel'], updatedAt: '2026-11-15T08:00:00.000Z',
};

const online = (name: ServerDTO['name'], kitVersion: string | null = '2.1.0'): ServerDTO => ({ ...serverDto(name, 'online'), kitVersion });

function setup(projects: ProjectDTO[] = []) {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock('2026-11-15T09:00:00.000Z');
  const puts: Array<{ server: string; files: readonly CtlKbFile[]; prune: boolean }> = [];
  const ctl = (server: string) => createFakeCtl({
    kbPut: async (files, prune) => {
      puts.push({ server, files, prune });
      return { written: files.length, removed: 0 };
    },
  });
  const fleet = createFakeFleet({ birch: ctl('birch'), cedar: ctl('cedar'), ash: ctl('ash'), local: ctl('local') });
  fleet.setServers([online('birch'), online('cedar', '2.0.3'), serverDto('ash', 'offline')]);
  let list = projects;
  const projectsService = { list: () => list, refresh: async () => undefined };
  const events: string[] = [];
  bus.on('kb.changed', () => events.push('kb'));
  const kb = createKbService({ db, bus, clock, log: silentLogger(), fleet, projects: projectsService });
  return { db, bus, clock, fleet, kb, puts, events, setProjects: (next: ProjectDTO[]) => { list = next; } };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('pages', () => {
  it('creates, reads, edits, pins and deletes; each change says kb.changed', async () => {
    const t = setup();
    const created = KbPageFullDTOSchema.parse(await t.kb.create({ scope: 'office', server: 'birch', title: 'Deploy steps', body: 'Run deploy.sh', tags: ['ops', 'ops'] }, 'owner'));
    expect(created).toMatchObject({ scope: 'office', server: 'birch', project: null, slug: 'deploy-steps', tags: ['ops'], auto: false, size: 13, updatedBy: 'owner' });
    expect(t.kb.get(created.id)?.body).toBe('Run deploy.sh');
    const pinned = await t.kb.update(created.id, { pinned: true, title: 'Deploy' }, 'manager');
    expect(pinned).toMatchObject({ pinned: true, slug: 'deploy', title: 'Deploy', updatedBy: 'manager' });
    await t.kb.remove(created.id);
    expect(t.kb.get(created.id)).toBeNull();
    await expect(t.kb.remove(created.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(t.events).toEqual(['kb', 'kb', 'kb']);
  });

  it('a clashing title in the same place gets its own slug; another place may reuse it', async () => {
    const t = setup();
    const a = await t.kb.create({ scope: 'global', title: 'Rules', body: 'a' }, 'owner');
    const b = await t.kb.create({ scope: 'global', title: 'Rules!', body: 'b' }, 'owner');
    const c = await t.kb.create({ scope: 'project', server: 'birch', project: 'orchard', title: 'Rules', body: 'c' }, 'owner');
    expect([a.slug, b.slug, c.slug]).toEqual(['rules', 'rules-2', 'rules']);
  });

  it('kb_write replaces the page with the same slug in that place', async () => {
    const t = setup();
    const first = await t.kb.write({ scope: 'global', title: 'Lessons', body: 'one' }, 'manager');
    const again = await t.kb.write({ scope: 'global', title: 'lessons', body: 'two', tags: ['x'] }, 'manager');
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ body: 'two', title: 'lessons', tags: ['x'] });
    expect(t.kb.list({}).items).toHaveLength(1);
  });

  it('kb_write never replaces a page the owner wrote or pinned', async () => {
    const t = setup();
    const owners = await t.kb.create({ scope: 'global', title: 'House rules', body: 'mine' }, 'owner');
    const managers = await t.kb.write({ scope: 'office', server: 'birch', title: 'Deploy', body: 'one' }, 'manager');
    await t.kb.update(managers.id, { pinned: true }, 'manager');
    const draft = await t.kb.write({ scope: 'global', title: 'Notes', body: 'draft' }, 'manager');
    await expect(t.kb.write({ scope: 'global', title: 'house rules', body: 'replaced' }, 'manager')).rejects.toBeInstanceOf(RefusedError);
    await expect(t.kb.write({ scope: 'office', server: 'birch', title: 'Deploy', body: 'two' }, 'manager')).rejects.toBeInstanceOf(RefusedError);
    expect(t.kb.get(owners.id)).toMatchObject({ body: 'mine', updatedBy: 'owner' });
    expect(t.kb.get(managers.id)).toMatchObject({ body: 'one', pinned: true });
    await expect(t.kb.write({ scope: 'global', title: 'Notes', body: 'final' }, 'manager')).resolves.toMatchObject({ id: draft.id, body: 'final' });
    await t.kb.update(draft.id, { body: 'edited by me' }, 'owner');
    await expect(t.kb.write({ scope: 'global', title: 'Notes', body: 'again' }, 'manager')).rejects.toThrow(/owner wrote or pinned/);
  });

  it('refuses a scope without its server and a body over the limit', async () => {
    const t = setup();
    await expect(t.kb.create({ scope: 'project', server: 'birch', title: 'x', body: '' } as never, 'owner')).rejects.toBeInstanceOf(ValidationError);
    await expect(t.kb.create({ scope: 'global', title: 'x', body: 'y'.repeat(60_001) }, 'owner')).rejects.toBeInstanceOf(ValidationError);
    await expect(t.kb.update(99, { body: 'x' }, 'owner')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists with filters and searches title, tags and body (Arabic too)', async () => {
    const t = setup();
    await t.kb.create({ scope: 'global', title: 'Release checklist', body: 'Tag, then deploy', tags: ['shipping'] }, 'owner');
    await t.kb.create({ scope: 'project', server: 'birch', project: 'orchard', title: 'Payments', body: 'Stripe keys live in the vault' }, 'owner');
    await t.kb.create({ scope: 'project', server: 'cedar', project: 'meadow-hr', title: 'Payroll', body: 'ملاحظات الرواتب' }, 'owner');
    expect(t.kb.list({ scope: 'project', server: 'birch' }).items.map((p) => p.title)).toEqual(['Payments']);
    expect(t.kb.list({ query: 'deploy' }).items.map((p) => p.title)).toEqual(['Release checklist']);
    expect(t.kb.list({ query: 'shipp' }).items.map((p) => p.title)).toEqual(['Release checklist']);
    expect(t.kb.list({ query: 'الرواتب' }).items.map((p) => p.title)).toEqual(['Payroll']);
    const hits = t.kb.search('vault', { server: 'birch', limit: 5 });
    expect(hits.map((h) => [h.title, h.excerpt])).toEqual([['Payments', 'Stripe keys live in the vault']]);
    expect(t.kb.search('vault', { server: 'cedar', limit: 5 })).toEqual([]);
    expect(t.kb.search('"', { limit: 5 })).toEqual([]);
  });
});

describe('automatic Overview pages', () => {
  it('one per project, rebuilt when the project list changes, never once someone edited it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const t = setup([ORCHARD]);
    t.kb.start();
    const auto = t.kb.list({ scope: 'project', server: 'birch', project: 'orchard' }).items;
    expect(auto).toMatchObject([{ slug: 'overview', title: 'Overview', auto: true, updatedBy: 'system' }]);
    const body = t.kb.get(auto[0]!.id)!.body;
    expect(body).toContain('`/home/dev/projects/orchard`');
    expect(body).toContain('- 2026-11-14 feat: checkout (`a1b2c3d`)');

    t.setProjects([{ ...ORCHARD, branch: 'develop' }]);
    await vi.advanceTimersByTimeAsync(KB_PROJECTS_CHECK_MS);
    expect(t.kb.get(auto[0]!.id)!.body).toContain('Branch: develop');

    await t.kb.update(auto[0]!.id, { body: 'My own notes' }, 'owner');
    expect(t.kb.get(auto[0]!.id)).toMatchObject({ auto: false, body: 'My own notes' });
    t.setProjects([{ ...ORCHARD, branch: 'release' }]);
    await vi.advanceTimersByTimeAsync(KB_PROJECTS_CHECK_MS);
    expect(t.kb.get(auto[0]!.id)!.body).toBe('My own notes');
    t.kb.stop();
  });

  it('pinning an automatic page is not an edit', async () => {
    const t = setup([ORCHARD]);
    t.kb.start();
    const id = t.kb.list({}).items[0]!.id;
    expect(await t.kb.update(id, { pinned: true }, 'owner')).toMatchObject({ pinned: true, auto: true });
    t.kb.stop();
  });
});

describe('the copy on the servers', () => {
  it('Sync now sends the file set with prune to servers on kit 2.1, skipping old kits and offline servers', async () => {
    const t = setup();
    await t.kb.create({ scope: 'global', title: 'Rules', body: 'Be kind' }, 'owner');
    t.events.length = 0;
    await t.kb.sync();
    expect(t.puts.map((p) => [p.server, p.prune, p.files.map((f) => f.path)])).toEqual([['birch', true, ['INDEX.md', 'global/rules.md']]]);
    expect(t.kb.list({}).syncedAt).toEqual({ birch: '2026-11-15T09:00:00.000Z', cedar: null, ash: null });
    expect(t.events).toEqual(['kb']);
  });

  it('a change is copied 30 seconds later, once for a burst; nothing changed means nothing sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const t = setup();
    t.kb.start();
    await settle();
    expect(t.puts).toHaveLength(1);
    await t.kb.create({ scope: 'global', title: 'One', body: '1' }, 'owner');
    await t.kb.create({ scope: 'global', title: 'Two', body: '2' }, 'owner');
    await vi.advanceTimersByTimeAsync(KB_SYNC_DELAY_MS - 1);
    expect(t.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.puts).toHaveLength(2);
    expect(t.puts[1]!.files.map((f) => f.path)).toEqual(['INDEX.md', 'global/one.md', 'global/two.md']);

    const id = t.kb.list({}).items.find((p) => p.title === 'Two')!.id;
    await t.kb.update(id, { body: '2' }, 'owner');
    await vi.advanceTimersByTimeAsync(KB_SYNC_DELAY_MS);
    expect(t.puts).toHaveLength(2);

    await t.kb.remove(id);
    await vi.advanceTimersByTimeAsync(KB_SYNC_DELAY_MS);
    expect(t.puts).toHaveLength(3);
    expect(t.puts[2]!.files.map((f) => f.path)).toEqual(['INDEX.md', 'global/one.md']);
    expect(t.puts[2]!.prune).toBe(true);
    t.kb.stop();
  });

  it('a server that comes online gets its copy; a later update of the same server sends nothing new', async () => {
    const t = setup();
    t.kb.start();
    await settle();
    t.puts.length = 0;
    t.fleet.setServers([online('birch'), online('cedar', '2.0.3'), online('ash', '2.1.0')]);
    t.bus.emit('server.updated', online('ash', '2.1.0'));
    await settle();
    expect(t.puts.map((p) => p.server)).toEqual(['ash']);
    t.bus.emit('server.updated', online('ash', '2.1.0'));
    await settle();
    expect(t.puts).toHaveLength(1);
    t.kb.stop();
  });

  it('an online server whose kit is upgraded gets its copy without reconnecting', async () => {
    const t = setup();
    t.kb.start();
    await settle();
    expect(t.puts.map((p) => p.server)).toEqual(['birch']);
    t.puts.length = 0;
    t.fleet.setServers([online('birch'), online('cedar', '2.1.0'), serverDto('ash', 'offline')]);
    t.bus.emit('server.updated', online('cedar', '2.1.0'));
    await settle();
    expect(t.puts.map((p) => p.server)).toEqual(['cedar']);
    t.bus.emit('server.updated', online('cedar', '2.1.0'));
    await settle();
    expect(t.puts).toHaveLength(1);
    t.kb.stop();
  });

  it('a failing kb-put of one server is thrown for that server only', async () => {
    const t = setup();
    t.fleet.setClient('birch', createFakeCtl({ kbPut: async () => { throw new Error('ssh down'); } }));
    await expect(t.kb.sync('birch')).rejects.toThrow('ssh down');
    await expect(t.kb.sync()).resolves.toBeUndefined();
  });
});
