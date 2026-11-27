import { describe, expect, it } from 'vitest';
import type { RoomDTO, ServerDTO } from '@luady/shared';
import { buildOffice, type OfficeMap } from '../src/layout.js';
import { hashBytes, hashId } from '../src/looks.js';
import { propsFor } from '../src/props.js';
import { fixturesFor } from '../src/fixtures.js';
import { mapLayerRaster } from '../src/sprites/map-layer.js';
import { daylightRaster } from '../src/sprites/panes.js';
import { exteriorRaster } from '../src/sprites/exterior.js';
import { buildSnapshot, type AgencySnapshot } from '../src/snapshot.js';
import { walkGrid, type WalkGrid } from '../src/walk.js';
import { ALL_SERVERS, NOW, luadyStatus, server } from './fixtures.js';
import { CLASSIC_ROOMS, classic } from './rooms-fixture.js';

/**
 * The oracles: FNV-1a hashes of the pictures and plans of the classic offices, pinned once. Every change to the office
 * must keep them, so the four-room office (and the smaller ones) stays pixel for pixel the same.
 * A changed hash means the code is wrong, not the pin.
 *
 * Each office is built from RoomDTOs (empty slots are lots).
 */

type Office = 'classic' | 'birch' | 'none';

const SERVERS: Readonly<Record<Office, readonly ServerDTO[]>> = {
  classic: ALL_SERVERS,
  birch: [server('birch')],
  none: [],
};

const ROOMS: Readonly<Record<Office, readonly RoomDTO[]>> = {
  classic: CLASSIC_ROOMS,
  birch: [classic('birch')],
  none: [],
};

const mapOf = (office: Office): OfficeMap => buildOffice(ROOMS[office]);

const emptySnapshot = (office: Office): AgencySnapshot => buildSnapshot({
  servers: SERVERS[office], rooms: ROOMS[office],
  sessions: [], questions: [], luady: luadyStatus(), now: NOW, previousSeats: {},
});

/** The walk grid row by row, one byte per tile (1 = open). */
const gridBytes = (grid: WalkGrid): Uint8Array => Uint8Array.from(grid.flatMap((row) => row.map((open) => (open ? 1 : 0))));

const walkHash = (snap: AgencySnapshot): number => hashBytes(gridBytes(walkGrid(snap.map, snap.slots, snap.props)));

describe('oracles from rooms: the classic four', () => {
  const map = mapOf('classic');
  const snap = emptySnapshot('classic');
  const rooms = ['birch', 'ash', 'cedar', 'local'];

  it('map layer (the pinned picture of map-layer.test.ts)', () => {
    expect(hashBytes(mapLayerRaster(map).data)).toBe(PINNED.map);
  });

  it('map layer with a Jira board in every room', () => {
    expect(hashBytes(mapLayerRaster(map, { jiraRooms: rooms }).data)).toBe(PINNED.mapJira);
  });

  it('exterior', () => {
    expect(hashBytes(exteriorRaster(map).data)).toBe(PINNED.exterior);
  });

  it('daylight', () => {
    expect(hashBytes(daylightRaster(map).data)).toBe(PINNED.daylight);
  });

  it('walk grid of an empty snapshot', () => {
    expect(walkHash(snap)).toBe(PINNED.walk);
  });

  it('props of an empty snapshot, and with every lounge in and a Jira board in every room', () => {
    expect(hashId(JSON.stringify(snap.props))).toBe(PINNED.props);
    expect(hashId(JSON.stringify(propsFor(map, {}, { jiraRooms: rooms })))).toBe(PINNED.propsJira);
  });

  it('fixtures of an empty snapshot, and with a Jira board in every room', () => {
    expect(hashId(JSON.stringify(snap.fixtures))).toBe(PINNED.fixtures);
    expect(hashId(JSON.stringify(fixturesFor(map, { jiraRooms: rooms })))).toBe(PINNED.fixturesJira);
  });
});

describe('oracles from rooms: smaller offices (empty slots drawn as vacant shells)', () => {
  it.each(['birch', 'none'] as const)('%s: map layer, daylight, walk grid, props and fixtures', (office) => {
    const map = mapOf(office);
    const snap = emptySnapshot(office);
    expect({
      map: hashBytes(mapLayerRaster(map).data),
      daylight: hashBytes(daylightRaster(map).data),
      walk: walkHash(snap),
      props: hashId(JSON.stringify(snap.props)),
      fixtures: hashId(JSON.stringify(snap.fixtures)),
    }).toEqual(SMALL[office]);
  });
});

/** The pinned hashes of the classic four. `map` is map-layer.test.ts's PINNED. */
const PINNED = {
  map: 1898176028,
  mapJira: 2319364805,
  exterior: 3780108158,
  daylight: 3272980757,
  walk: 878191253,
  props: 2453962575,
  propsJira: 30330300,
  fixtures: 282657907,
  fixturesJira: 3119145653,
} as const;

const SMALL: Readonly<Record<'birch' | 'none', Readonly<Record<string, number>>>> = {
  birch: { map: 2134378688, daylight: 200888013, walk: 329373619, props: 194158484, fixtures: 816821644 },
  none: { map: 3049359205, daylight: 611435269, walk: 1954455768, props: 1317594006, fixtures: 3788302986 },
};
