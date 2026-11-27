import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Fleet } from '../../src/core/contracts.js';
import { RefusedError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createHostLookups, type KnownHost } from '../../src/fleet/host-lookups.js';
import { checkProjectCwd, createSessionCommands } from '../../src/sessions/commands.js';
import { createSessionRow } from '../../src/sessions/registry.js';
import { createSessionsRepo } from '../../src/sessions/repo.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';

const NOW = '2026-11-21T08:00:00.000Z';

function rig(known: readonly KnownHost[]) {
  const ctl = createFakeCtl();
  const fleet = {
    ...createHostLookups(() => known), client: () => ctl, servers: () => [], start: async () => undefined, stop: async () => undefined,
    openShell: async () => { throw new Error('no shell'); }, tailEvents: () => ({ stop: () => undefined, done: Promise.resolve() }),
  } as Fleet;
  const repo = createSessionsRepo(openMemoryDb(), silentLogger());
  const commands = createSessionCommands({ repo, bus: createBus(), clock: createFakeClock(NOW), fleet, log: silentLogger() });
  return { commands, repo, ctl };
}

const MARS: KnownHost = { name: 'mars', projectsRoot: '/srv/mars' };

describe('starting a session (open hosts, each with its projects folder)', () => {
  it('a start on the manager\'s own host is refused', async () => {
    const { commands, ctl } = rig([MARS]);
    await expect(commands.start({ server: 'hq', cwd: '/srv/mars/app', origin: 'owner' })).rejects.toBeInstanceOf(ValidationError);
    expect(ctl.calls).toEqual([]);
  });

  it('a start on mars is allowed while the fleet has it, in its own projects folder', async () => {
    const { commands, ctl } = rig([MARS]);
    const started = await commands.start({ server: 'mars', cwd: '/srv/mars/rover', origin: 'owner' });
    expect(started).toMatchObject({ host: 'mars', cwd: '/srv/mars/rover', state: 'starting' });
    expect(ctl.calls.map((call) => call.method)).toEqual(['start']);
    await expect(rig([]).commands.start({ server: 'mars', cwd: '/srv/mars/rover', origin: 'owner' })).rejects.toThrow(/unknown server/);
  });

  it('this computer starts sessions in its own folder too', async () => {
    const { commands } = rig([{ name: LOCAL_HOST_ID, kind: 'local', projectsRoot: '/home/owner/projects' }]);
    await expect(commands.start({ server: LOCAL_HOST_ID, cwd: '/home/owner/projects/site', origin: 'owner' })).resolves.toMatchObject({ host: LOCAL_HOST_ID });
  });

  it('a cwd outside the host\'s root is refused: elsewhere, the root itself, a look-alike, a climb out', async () => {
    const { commands, ctl } = rig([MARS]);
    for (const cwd of ['/etc', '/srv/mars', '/srv/marsX/app', '/srv/mars/../etc', '/home/dev/projects/app']) {
      await expect(commands.start({ server: 'mars', cwd, origin: 'owner' }), cwd).rejects.toBeInstanceOf(ValidationError);
    }
    expect(ctl.calls).toEqual([]);
  });

  it('checkProjectCwd takes the host\'s root, trailing slashes and all', () => {
    expect(checkProjectCwd('/srv/mars/app/', '/srv/mars/')).toBe('/srv/mars/app');
    expect(() => checkProjectCwd('/srv/mars', '/srv/mars')).toThrow(ValidationError);
  });

  it('reopening an ended session needs its host in the fleet, not a fixed list', async () => {
    const { commands, repo } = rig([MARS]);
    const row = { ...createSessionRow({ host: 'mars', target: 'cc-rover:0.0', createdAt: NOW, origin: 'owner', cwd: '/srv/mars/rover' }), state: 'ended' as const, claudeSessionId: 'c-1' };
    repo.save(row);
    await expect(commands.restart(row.id)).resolves.toBeUndefined();
    const gone = rig([]);
    gone.repo.save(row);
    await expect(gone.commands.restart(row.id)).rejects.toBeInstanceOf(RefusedError);
  });
});
