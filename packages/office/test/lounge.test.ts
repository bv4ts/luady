import { describe, expect, it } from 'vitest';
import { findPath } from '../src/path.js';
import type { PropDef } from '../src/props.js';
import { CLASSIC_ROOMS, classicRooms } from './rooms-fixture.js';
import { buildSnapshot, type AgencySnapshot, type SnapshotInput } from '../src/snapshot.js';
import { walkGrid } from '../src/walk.js';
import { ALL_SERVERS, NOW, luadyStatus, session } from './fixtures.js';
import { open, walkable } from './route.js';

const ROOMS = ['birch', 'ash', 'cedar', 'local'] as const;

const snapshot = (over: Partial<SnapshotInput> = {}): AgencySnapshot =>
  buildSnapshot({ servers: ALL_SERVERS, rooms: CLASSIC_ROOMS, sessions: [], questions: [], luady: luadyStatus(), now: NOW, previousSeats: {}, ...over });
const crowd = (room: string, n: number) => Array.from({ length: n }, (_, i) => session(`${room}:s${String(i).padStart(2, '0')}`));
const loungeProps = (snap: AgencySnapshot, room: string): readonly PropDef[] => snap.props.filter((p) => p.room === room && p.lounge);

/** Every desk the snapshot says exists, checked against every piece of furniture it shows. */
const deskPropClashes = (snap: AgencySnapshot, room: string): readonly string[] =>
  (snap.slots[room] ?? []).flatMap((slot) => slot.blocks.flatMap((b) => snap.props
    .filter((p) => p.blocks.some((r) => b.tx >= r.x && b.tx < r.x + r.w && b.ty >= r.y && b.ty < r.y + r.h))
    .map((p) => `desk ${slot.index} at ${b.tx},${b.ty} under ${p.id}`)));

describe('lounge furniture follows the desks', () => {
  it('stays out with 8 desks while 8 actors sit on desks 0 to 7', () => {
    const snap = snapshot({ sessions: crowd('ash', 8) });
    expect(Object.values(snap.actors).map((a) => a.seat).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(snap.rooms.ash?.lounge).toBe(true);
    expect(snap.slots.ash?.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loungeProps(snap, 'ash').map((p) => p.id)).toEqual(['table-2']);
  });

  it('goes away and brings the third desk row when a ninth actor takes desk 8', () => {
    const snap = snapshot({ sessions: crowd('ash', 9) });
    expect(snap.actors['ash:s08']?.seat).toBe(8);
    expect(snap.rooms.ash?.lounge).toBe(false);
    expect(snap.slots.ash).toHaveLength(12);
    expect(loungeProps(snap, 'ash')).toEqual([]);
  });

  it('stays away for one actor on a sticky desk 9, and comes back when it leaves', () => {
    const sticky = snapshot({ sessions: [session('ash:x')], previousSeats: { 'ash:x': 9 } });
    expect(sticky.actors['ash:x']?.seat).toBe(9);
    expect(sticky.rooms.ash?.mode).toBe('normal');
    expect(sticky.rooms.ash?.lounge).toBe(false);
    expect(sticky.slots.ash).toHaveLength(12);
    expect(loungeProps(sticky, 'ash')).toEqual([]);
    const after = snapshot({ sessions: [], previousSeats: sticky.seats });
    expect(after.rooms.ash?.lounge).toBe(true);
    expect(after.slots.ash).toHaveLength(8);
    expect(loungeProps(after, 'ash')).toHaveLength(1);
  });

  it('is never out in tight mode', () => {
    const snap = snapshot({ sessions: crowd('cedar', 13) });
    expect(snap.rooms.cedar?.mode).toBe('tight');
    expect(snap.rooms.cedar?.lounge).toBe(false);
    expect(snap.slots.cedar).toHaveLength(20);
    expect(loungeProps(snap, 'cedar')).toEqual([]);
  });

  it('is out only in empty rooms that have a lounge; Orchard, HQ and empty slots have none', () => {
    const servers = ALL_SERVERS.filter((s) => s.name !== 'ash');
    const snap = buildSnapshot({ servers, rooms: classicRooms(servers.map((s) => s.name)), sessions: [], questions: [], luady: null, now: NOW, previousSeats: {} });
    expect(snap.rooms.local?.lounge).toBe(true);
    expect(snap.rooms.cedar?.lounge).toBe(true);
    expect(snap.rooms.birch?.lounge).toBe(false);
    expect(snap.rooms.hq?.lounge).toBe(false);
    expect(snap.rooms['lot-1']?.lounge).toBe(false);
  });

  it('keeps all 12 Orchard desks, since nothing stands on its third row', () => {
    expect(snapshot({ sessions: crowd('birch', 1) }).slots.birch).toHaveLength(12);
  });
});

describe('the walk grid agrees with what is drawn', () => {
  it('opens the floor of the third desk row while the lounge is out, and closes it when the desks come', () => {
    const free = snapshot({ sessions: crowd('ash', 2) });
    const full = snapshot({ sessions: crowd('ash', 9) });
    const thirdRow = { tx: 66, ty: 13 };
    expect(open(walkGrid(free.map, free.slots, free.props), thirdRow)).toBe(true);
    expect(open(walkGrid(full.map, full.slots, full.props), thirdRow)).toBe(false);
  });
});

describe('no desk ever stands on furniture', () => {
  const counts = Array.from({ length: 20 }, (_, i) => i + 1);

  it.each(ROOMS)('in any of the four rooms while %s fills from 1 to 20', (busy) => {
    counts.forEach((n) => {
      const snap = snapshot({ sessions: crowd(busy, n) });
      ROOMS.forEach((room) => expect([n, room, deskPropClashes(snap, room)]).toEqual([n, room, []]));
      Object.values(snap.actors).forEach((a) => expect(snap.slots[a.room]?.[a.seat]?.index).toBe(a.seat));
    });
  });

  it.each(ROOMS)('and every used desk of %s can be reached from the entry', (busy) => {
    counts.forEach((n) => {
      const snap = snapshot({ sessions: crowd(busy, n) });
      const grid = walkGrid(snap.map, snap.slots, snap.props);
      const west = snap.map.spots.entries[0];
      expect(west).toBeDefined();
      if (west === undefined) return;
      Object.values(snap.actors).forEach((a) => {
        const tile = snap.slots[a.room]?.[a.seat]?.tile;
        expect(tile).toBeDefined();
        if (tile === undefined) return;
        expect([n, a.id, walkable(grid, west, findPath(grid, west, tile))]).toEqual([n, a.id, true]);
      });
    });
  });
});
