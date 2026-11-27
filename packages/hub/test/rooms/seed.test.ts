import { describe, expect, it } from 'vitest';
import type { RoomImport } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, HubConfig, ServerConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createFleetWith } from '../../src/fleet/fleet-core.js';
import type { RemoteExecutor } from '../../src/fleet/executor.js';
import { createRoomsService, seedRooms } from '../../src/rooms/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeExecutor } from '../fleet/fake-executor.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import { NOW } from './helpers.js';

const FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

const server = (name: string): ServerConfig => ({ name, host: `${name}.example.com`, user: 'dev', port: 22, hostKeyFp: FP });

const CLASSIC: RoomImport[] = [
  { id: 'harbor', name: 'Harbor', kind: 'server', host: 'ash', position: 1, species: 'bot', colour: '#3d7bff' },
  { id: 'orchard', name: 'Orchard', kind: 'server', host: 'birch', position: 0, species: 'bun', colour: '#d6336c' },
  { id: 'meadow', name: 'Meadow', kind: 'server', host: 'cedar', position: 2, species: 'shield' },
];

function config(rooms: RoomImport[] | undefined): HubConfig {
  return {
    ...loadedDefaults('/srv/hub/data'),
    servers: [server('ash'), server('birch'), server('cedar')], fleetKeyPath: '/srv/hub/data/fleet_ed25519', dataDir: '/srv/hub/data',
    brainDir: '/srv/hub/brain', runDir: '/srv/hub/run', webDir: '/srv/hub/web', webPort: 7410, publicOrigin: 'http://localhost:7410',
    rpId: 'localhost', cfTeamDomain: '', cfAccessAud: '', sessionSecret: 'a'.repeat(64),
    hubSocketToken: 'b'.repeat(64), claudePath: '/srv/hub/bin/claude', localCtlPath: '/srv/hub/bin/luady-ctl',
    remoteCtlPath: '~/.luady/bin/luady-ctl', rooms,
  };
}

/** One start: the fleet writes the config host rows while it is built, then the rooms service and the seed run. */
function start(db: Db, rooms: RoomImport[] | undefined) {
  const cfg = config(rooms);
  const bus = createBus();
  const clock = createFakeClock(NOW);
  const fleet = createFleetWith({ config: cfg, db, bus, clock, log: silentLogger() }, {
    local: createFakeExecutor(), build: (): RemoteExecutor => createFakeExecutor(),
  });
  const service = createRoomsService({ db, bus, clock, log: silentLogger(), fleet });
  return { added: seedRooms(service, cfg, silentLogger()), service };
}

describe('seedRooms: config.rooms imported once', () => {
  it('a first start with config servers plus rooms passes the host check, keeping ids and positions', () => {
    const db = openMemoryDb();
    const { added, service } = start(db, CLASSIC);
    expect(added).toBe(3);
    expect(service.list().items.map((room) => [room.id, room.host, room.position, room.species])).toEqual([
      ['orchard', 'birch', 0, 'bun'], ['harbor', 'ash', 1, 'bot'], ['meadow', 'cedar', 2, 'shield'],
    ]);
  });

  it('a second start does nothing, even after the owner removed every room', async () => {
    const db = openMemoryDb();
    start(db, CLASSIC);
    const again = start(db, CLASSIC);
    expect(again.added).toBe(0);
    expect(again.service.list().items).toHaveLength(3);
    for (const room of again.service.list().items) await again.service.remove(room.id, { links: 'delete', jira: 'disconnect' }, async () => undefined);
    expect(start(db, CLASSIC).added).toBe(0);
    expect(start(db, CLASSIC).service.list().items).toEqual([]);
  });

  it('a room whose host is not a server is left out with a warning; the others go in', () => {
    const db = openMemoryDb();
    const { added, service } = start(db, [...CLASSIC, { id: 'labs', name: 'Labs', kind: 'server', host: 'mars', position: 3 }]);
    expect(added).toBe(3);
    expect(service.get('labs')).toBeNull();
  });

  it('without config.rooms nothing is seeded and the office starts empty (no rooms in code)', () => {
    const db = openMemoryDb();
    const { added, service } = start(db, undefined);
    expect(added).toBe(0);
    expect(service.list().items).toEqual([]);
    expect(service.seeded()).toBe(false);
  });

  it('rooms made on the website first: the file is never imported over them', () => {
    const db = openMemoryDb();
    start(db, undefined).service.create({ name: 'Mine', kind: 'server', host: 'ash' });
    expect(start(db, CLASSIC).added).toBe(0);
    expect(start(db, CLASSIC).service.list().items.map((room) => room.id)).toEqual(['mine']);
  });
});
