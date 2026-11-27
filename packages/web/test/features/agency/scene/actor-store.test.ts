import type { AgencySnapshot } from '@luady/office';
import type { SessionDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { ARRIVAL_GAP_MS, createActorStore, doorFor, type ActorStore } from '../../../../src/features/agency/scene/actor-store.js';
import { LUADY_ACTOR_ID } from '../../../../src/features/agency/stage-types.js';
import { many, roomSnap, roomsOf, session, snap } from './office-fixtures.js';

/** Feeds snapshots in order, stepping the clock between them, like the ticker does. */
const drive = (store: ActorStore, frames: readonly { snapshot?: AgencySnapshot; ms?: number }[]): void => {
  frames.forEach((f) => {
    if (f.snapshot !== undefined) store.apply(f.snapshot);
    for (let t = 0; t < (f.ms ?? 0); t += 16) store.step(16);
  });
};

/** Steps until nobody walks any more (or gives up after a minute of walking). */
const settle = (store: ActorStore): void => {
  for (let i = 0; i < 4000 && store.list().some((a) => a.walk !== null); i += 1) store.step(16);
};

const sessionIds = (store: ActorStore): string[] => store.list().filter((a) => a.id !== LUADY_ACTOR_ID).map((a) => a.id).sort();

const expectAllSeated = (store: ActorStore, snapshot: AgencySnapshot): void => {
  expect(sessionIds(store)).toEqual(Object.keys(snapshot.actors).sort());
  Object.values(snapshot.actors).forEach((a) => {
    expect(store.get(a.id)?.pos, a.id).toEqual(a.sit);
    expect(store.get(a.id)?.walk, a.id).toBeNull();
  });
};

describe('createActorStore', () => {
  it('places everyone at their seats on the first snapshot, without walking, with Luady at his desk', () => {
    const store = createActorStore();
    const first = snap([...many('birch', 3), ...many('local', 2)]);
    store.apply(first);
    expectAllSeated(store, first);
    expect(store.get(LUADY_ACTOR_ID)?.pos).toEqual(first.map.spots.luadySit);
  });

  it('a settling snapshot seats everyone at once, even after an empty one from before the overview loaded', () => {
    const store = createActorStore();
    store.apply(snap([]));
    const loaded = snap([...many('birch', 3), ...many('cedar', 2)]);
    store.apply(loaded, { settle: true });
    expectAllSeated(store, loaded);
    expect(store.step(16)).toBe(false);
  });

  it('after a settling snapshot, a session that appears later walks in as usual', () => {
    const store = createActorStore();
    store.apply(snap([]));
    const loaded = snap(many('ash', 1));
    store.apply(loaded, { settle: true });
    store.apply(snap(many('ash', 2), { previous: loaded }));
    expect(store.get('ash:s01')?.walk).not.toBeNull();
    expect(store.get('ash:s00')?.walk).toBeNull();
  });

  it('walks a newcomer in from the nearer street door to its seat', () => {
    const store = createActorStore();
    const before = snap(many('ash', 1));
    store.apply(before);
    const after = snap(many('ash', 2), { previous: before });
    store.apply(after);
    const newcomer = store.get('ash:s01');
    expect(newcomer?.walk).not.toBeNull();
    expect(newcomer?.pos.x).toBeGreaterThan(1050);
    expect(store.step(16)).toBe(true);
    settle(store);
    expectAllSeated(store, after);
  });

  it('starts several arrivals of one update 200 ms apart, so they never walk on top of each other', () => {
    const store = createActorStore();
    const before = snap(many('birch', 1));
    store.apply(before);
    const after = snap(many('birch', 4), { previous: before });
    store.apply(after);
    const arrivals = ['birch:s01', 'birch:s02', 'birch:s03'];
    expect(arrivals.map((id) => store.get(id)?.wait)).toEqual([0, ARRIVAL_GAP_MS, ARRIVAL_GAP_MS * 2]);
    store.step(ARRIVAL_GAP_MS - 1);
    expect(store.get('birch:s02')?.wait).toBe(1);
    store.step(1);
    expect(store.get('birch:s02')?.wait).toBe(0);
    for (let t = 0; t < 60_000 && store.list().some((a) => a.walk !== null); t += 16) {
      const out = arrivals.map((id) => store.get(id)).filter((a) => a !== undefined && a.wait === 0 && a.walk !== null);
      const spots = new Set(out.map((a) => `${a?.pos.x},${a?.pos.y}`));
      expect(spots.size).toBe(out.length);
      store.step(16);
    }
    expectAllSeated(store, after);
  });

  it('also spaces out arrivals that come in quick successive updates through the same door', () => {
    const store = createActorStore();
    const one = snap(many('cedar', 1));
    store.apply(one);
    const two = snap(many('cedar', 2), { previous: one });
    store.apply(two);
    store.step(50);
    store.apply(snap(many('cedar', 3), { previous: two }));
    expect(store.get('cedar:s01')?.wait).toBe(0);
    expect(store.get('cedar:s02')?.wait).toBe(ARRIVAL_GAP_MS - 50);
    store.step(ARRIVAL_GAP_MS * 3);
    const four = snap(many('cedar', 4), { previous: two });
    store.apply(four);
    expect(store.get('cedar:s03')?.wait).toBe(0);
  });

  it('forgets an arrival that leaves before its turn to walk in', () => {
    const store = createActorStore();
    const before = snap(many('ash', 1));
    store.apply(before);
    const three = snap(many('ash', 3), { previous: before });
    store.apply(three);
    expect(store.get('ash:s02')?.wait).toBeGreaterThan(0);
    store.apply(snap(many('ash', 2), { previous: three }));
    expect(store.get('ash:s02')).toBeUndefined();
  });

  it('walks a leaver out and then forgets it', () => {
    const store = createActorStore();
    const before = snap(many('cedar', 2));
    store.apply(before);
    store.apply(snap(many('cedar', 1), { previous: before }));
    expect(store.get('cedar:s01')?.leaving).toBe(true);
    settle(store);
    expect(store.get('cedar:s01')).toBeUndefined();
  });

  it('a session that appears, changes state and ends within two seconds leaves no ghost', () => {
    const store = createActorStore();
    const empty = snap(many('birch', 1));
    const arrived = snap([...many('birch', 1), session('birch:quick')], { previous: empty });
    const asking = snap([...many('birch', 1), session('birch:quick', { state: 'waiting_question' })], { previous: arrived });
    const gone = snap(many('birch', 1), { previous: asking });
    expect(() =>
      drive(store, [{ snapshot: empty }, { snapshot: arrived, ms: 600 }, { snapshot: asking, ms: 600 }, { snapshot: gone, ms: 300 }]),
    ).not.toThrow();
    expect(store.get('birch:quick')?.view?.state).toBe('waiting_question');
    settle(store);
    expect(store.get('birch:quick')).toBeUndefined();
    expectAllSeated(store, gone);
  });

  it('a session that ends before its first step is gone too, and one that comes back walks to its seat', () => {
    const store = createActorStore();
    const empty = snap([]);
    const arrived = snap([session('local:x')], { previous: empty });
    store.apply(empty);
    store.apply(arrived);
    store.apply(snap([], { previous: arrived }));
    settle(store);
    expect(sessionIds(store)).toEqual([]);
    const again = snap([session('local:y')]);
    store.apply(again);
    store.apply(snap([], { previous: again }));
    store.step(200);
    const back = snap([session('local:y')]);
    store.apply(back);
    expect(store.get('local:y')?.leaving).toBe(false);
    settle(store);
    expectAllSeated(store, back);
  });

  it('a room switching between 12 and 20 desks while people walk ends with everyone at the new seat', () => {
    const store = createActorStore();
    const ten = snap(many('birch', 10));
    const twelve = snap(many('birch', 12), { previous: ten });
    const fifteen = snap(many('birch', 15), { previous: twelve });
    const eleven = snap(many('birch', 11), { previous: fifteen });
    const twenty = snap(many('birch', 20), { previous: eleven });
    drive(store, [
      { snapshot: ten },
      { snapshot: twelve, ms: 400 },
      { snapshot: fifteen, ms: 700 },
      { snapshot: eleven, ms: 250 },
      { snapshot: twenty, ms: 900 },
    ]);
    expect(fifteen.rooms.birch?.mode).toBe('tight');
    expect(eleven.rooms.birch?.mode).toBe('normal');
    expect(store.list().some((a) => a.walk !== null)).toBe(true);
    settle(store);
    expectAllSeated(store, twenty);
  });

  it('a burst of ten updates keeps the final state', () => {
    const store = createActorStore();
    let previous = snap(many('ash', 3));
    store.apply(previous);
    const states: SessionDTO['state'][] = ['working', 'idle', 'waiting_question', 'working', 'error', 'idle', 'working', 'waiting_permission', 'idle', 'error'];
    states.forEach((state) => {
      const next = snap([...many('ash', 2), session('ash:s02', { state })], { previous });
      store.apply(next);
      previous = next;
    });
    expect(store.get('ash:s02')?.view?.state).toBe('error');
    expectAllSeated(store, previous);
  });

  it('picks the street door nearest a tile among every door of a bigger office', () => {
    const office = roomSnap(roomsOf(24));
    const { entries } = office.map.spots;
    expect(entries.length).toBeGreaterThan(2);
    entries.forEach((door) => expect(doorFor(office, door)).toEqual(door));
    const lowEast = entries.filter((d) => d.tx > office.map.width / 32).reduce((a, b) => (b.ty > a.ty ? b : a));
    expect(doorFor(office, { tx: lowEast.tx - 3, ty: lowEast.ty - 1 })).toEqual(lowEast);
    const classic = snap([]);
    expect(doorFor(classic, { tx: 10, ty: 5 })).toEqual(classic.map.spots.entries[0]);
    expect(doorFor(classic, { tx: 70, ty: 30 })).toEqual(classic.map.spots.entries[1]);
  });

  it('walks a newcomer in from the street door nearest its seat in a bigger office', () => {
    const store = createActorStore();
    const before = roomSnap(roomsOf(24), 1);
    store.apply(before);
    const after = roomSnap(roomsOf(24), 2, { previous: before });
    store.apply(after);
    const newcomer = store.get('site-20:s01');
    const seat = after.slots['site-20']?.[after.actors['site-20:s01']?.seat ?? 0]?.tile;
    expect(newcomer?.walk).not.toBeNull();
    const door = doorFor(after, seat ?? { tx: 0, ty: 0 });
    expect(newcomer?.pos).toEqual({ x: door.tx * 16 + 8, y: door.ty * 16 + 8 + 5 });
  });

  it('seats everyone at once when the layout changes, so nobody walks on the old coordinates', () => {
    const store = createActorStore();
    const four = roomSnap(roomsOf(4), 2);
    store.apply(four);
    store.apply(roomSnap(roomsOf(4), 3, { previous: four }));
    expect(store.list().some((a) => a.walk !== null)).toBe(true);
    const five = roomSnap(roomsOf(5), 3);
    expect(five.map.layoutKey).not.toBe(four.map.layoutKey);
    store.apply(five);
    expectAllSeated(store, five);
    expect(store.step(16)).toBe(false);
    const fewer = roomSnap(roomsOf(4), 1);
    store.apply(fewer);
    expectAllSeated(store, fewer);
  });

  it('jumps instead of walking with reduced motion, and finishes walks when it is switched on', () => {
    const store = createActorStore();
    const one = snap(many('cedar', 1));
    store.apply(one);
    const two = snap(many('cedar', 2), { previous: one });
    store.apply(two);
    expect(store.get('cedar:s01')?.walk).not.toBeNull();
    store.setReducedMotion(true);
    expectAllSeated(store, two);
    const three = snap(many('cedar', 3), { previous: two });
    store.apply(three);
    expectAllSeated(store, three);
    store.apply(snap(many('cedar', 1), { previous: three }));
    expect(sessionIds(store)).toEqual(['cedar:s00']);
  });
});
