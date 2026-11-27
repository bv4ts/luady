import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryDTOSchema, type BoardItemDTO, type CtlSkills, type ProjectDTO, type ServerDTO, type SessionDTO } from '@luady/shared';
import type { BoardService, KbService } from '../../src/core/contracts.js';
import { createBus } from '../../src/core/bus.js';
import { SKILLS_REFRESH_MS, createLibraryService } from '../../src/library/index.js';
import { frontMatter, readLuadySkills } from '../../src/library/skills.js';
import { createFakeFleet, serverDto } from '../fleet/fake-fleet.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';
import { CLASSIC_ROOMS } from '../helpers/classic-rooms.js';
import { makeSession } from '../tools/fake-context.js';

const project = (server: ProjectDTO['server'], name: string): ProjectDTO => ({
  server, path: `/home/dev/projects/${name}`, name, remote: null, branch: 'main', commits: [], stack: ['node'], updatedAt: '2026-11-15T08:00:00.000Z',
});
const online = (name: ServerDTO['name'], kitVersion: string | null): ServerDTO => ({ ...serverDto(name, 'online'), kitVersion });
const card = (over: Partial<BoardItemDTO>): BoardItemDTO => ({
  id: 1, title: 'Card', details: '', project: 'orchard', server: 'birch', source: 'web', sourceRef: null, state: 'open', today: false, priority: 0,
  auto: false, runId: null, sessionId: null, result: null, createdAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T08:00:00.000Z',
  dueAt: null, snoozeUntil: null, ...over,
} as BoardItemDTO);

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function brain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'luady-brain-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'skills', 'agency'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'agency', 'SKILL.md'), '---\nname: agency\ndescription: How Luady works with the office.\n---\n# Body');
  mkdirSync(join(dir, 'skills', 'patterns'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'patterns', 'SKILL.md'), '---\nname: "patterns"\ndescription: >-\n  Folded text\n  over lines\n---\n');
  mkdirSync(join(dir, 'skills', 'empty'), { recursive: true });
  return dir;
}

function setup(opts: { skills?: () => Promise<CtlSkills> } = {}) {
  const bus = createBus();
  const clock = createFakeClock('2026-11-15T09:00:00.000Z');
  const skillsCalls: string[] = [];
  const ctl = (server: string, impl?: () => Promise<CtlSkills>) => createFakeCtl({
    skills: async () => {
      skillsCalls.push(server);
      return (impl ?? (async () => ({ skills: [{ name: 'deploy', description: 'Deploys', source: 'project', path: '/p/.claude/skills/deploy/SKILL.md' }] })))();
    },
  });
  const fleet = createFakeFleet({ birch: ctl('birch', opts.skills), cedar: ctl('cedar'), ash: ctl('ash'), local: ctl('local') });
  fleet.setServers([online('cedar', '2.1.0'), online('birch', '2.1.0'), online('ash', '2.0.3'), serverDto('local', 'offline')]);
  const projects = { list: vi.fn((server?: string) => [project('birch', 'orchard'), project('birch', 'orchard-admin'), project('cedar', 'meadow-hr')].filter((p) => server === undefined || p.server === server)), refresh: vi.fn(async () => undefined) };
  const sessions = { list: vi.fn((): SessionDTO[] => [
    makeSession({ host: 'birch', cwd: '/home/dev/projects/orchard', project: 'orchard' }),
    makeSession({ id: 's2', host: 'birch', cwd: '/home/dev/projects/orchard/api', project: null }),
    makeSession({ id: 's3', host: 'birch', cwd: '/home/dev/projects/orchard', project: 'orchard', state: 'ended' }),
  ]) };
  const board = { list: vi.fn(() => [card({}), card({ id: 2, state: 'running' }), card({ id: 3, state: 'done' }), card({ id: 4, server: 'cedar' })]) } as unknown as BoardService;
  const kb = { list: vi.fn(() => ({ items: [{ project: 'orchard' }, { project: 'orchard' }, { project: 'orchard-admin' }], syncedAt: {} })) } as unknown as KbService;
  const events: string[] = [];
  bus.on('library.changed', () => events.push('library'));
  const library = createLibraryService({
    bus, clock, log: silentLogger(), fleet, projects, sessions: sessions as never, board, kb, brainDir: brain(),
    // The office order is the rooms' order (the classic four as rooms: Orchard, Harbor, Meadow, Private Projects).
    rooms: () => CLASSIC_ROOMS,
  });
  return { bus, fleet, library, projects, skillsCalls, events };
}

describe('the library', () => {
  it('projects per office with sessions now, open cards and pages; offices in room order', async () => {
    const t = setup();
    const dto = LibraryDTOSchema.parse(await t.library.get());
    expect(dto.offices.map((o) => o.server)).toEqual(['birch', 'ash', 'cedar', 'local']);
    const birch = dto.offices[0]!;
    expect(birch.projects.map((p) => [p.name, p.sessions, p.openItems, p.pages])).toEqual([['orchard', 2, 2, 2], ['orchard-admin', 0, 0, 1]]);
    expect(dto.managerSkills.map((s) => [s.name, s.description, s.source, s.path])).toEqual([
      ['agency', 'How Luady works with the office.', 'user', 'skills/agency/SKILL.md'],
      ['patterns', 'Folded text over lines', 'user', 'skills/patterns/SKILL.md'],
    ]);
  });

  it('skills: listed for kit 2.1, null for an older kit, null when the call fails, kept while offline', async () => {
    const t = setup({ skills: async () => { throw new Error('verb failed'); } });
    t.library.start();
    await vi.waitFor(() => expect(t.events.length).toBeGreaterThan(0));
    const dto = await t.library.get();
    const by = Object.fromEntries(dto.offices.map((o) => [o.server, o]));
    expect(by.cedar?.skills).toEqual([{ name: 'deploy', description: 'Deploys', source: 'project', path: '/p/.claude/skills/deploy/SKILL.md' }]);
    expect(by.cedar?.skillsAt).toBe('2026-11-15T09:00:00.000Z');
    expect(by.birch?.skills).toBeNull();
    expect(by.ash?.skills).toBeNull();
    expect(by.local?.skills).toBeNull();
    expect(t.skillsCalls.sort()).toEqual(['birch', 'cedar']);
    t.library.stop();
  });

  it('reads the skills of an online server whose kit is upgraded, without a reconnect', async () => {
    const t = setup();
    t.library.start();
    await vi.waitFor(() => expect(t.skillsCalls).toHaveLength(2));
    t.skillsCalls.length = 0;
    t.fleet.setServers([online('cedar', '2.1.0'), online('birch', '2.1.0'), online('ash', '2.1.0'), serverDto('local', 'offline')]);
    t.bus.emit('server.updated', online('ash', '2.1.0'));
    await vi.waitFor(() => expect(t.skillsCalls).toEqual(['ash']));
    t.bus.emit('server.updated', online('ash', '2.1.0'));
    await Promise.resolve();
    expect(t.skillsCalls).toEqual(['ash']);
    t.library.stop();
  });

  it('refreshes when a server comes online, every 6 hours and on request', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = setup();
    t.library.start();
    await vi.waitFor(() => expect(t.skillsCalls).toHaveLength(2));
    t.fleet.setServers([online('cedar', '2.1.0'), online('birch', '2.1.0'), online('ash', '2.0.3'), online('local', '2.1.0')]);
    t.bus.emit('server.updated', online('local', '2.1.0'));
    await vi.waitFor(() => expect(t.skillsCalls).toContain('local'));
    t.skillsCalls.length = 0;
    await vi.advanceTimersByTimeAsync(SKILLS_REFRESH_MS);
    expect(t.skillsCalls.sort()).toEqual(['birch', 'cedar', 'local']);
    t.skillsCalls.length = 0;
    t.events.length = 0;
    await t.library.refresh('cedar');
    expect(t.skillsCalls).toEqual(['cedar']);
    expect(t.projects.refresh).toHaveBeenCalledWith('cedar');
    expect(t.events).toEqual(['library']);
    t.library.stop();
  });
});

describe('Luady skills', () => {
  it('a missing folder is no skills', async () => {
    await expect(readLuadySkills(join(tmpdir(), 'no-such-brain-dir-xyz'))).resolves.toEqual([]);
  });

  it('front matter with quotes and literal blocks', () => {
    expect(frontMatter("---\nname: 'x'\ndescription: |\n  one\n  two\nother: y\n---")).toEqual({ name: 'x', description: 'one two', other: 'y' });
    expect(frontMatter('no front matter')).toEqual({});
  });
});
