import { describe, expect, it } from 'vitest';
import { classicRooms } from './rooms-fixture.js';
import { buildOffice } from '../src/layout.js';
import { slotsFor } from '../src/desks.js';
import { LOUNGE_FIRST_BLOCKING_SEAT, hasLounge, loungeOn, propsFor, shownSlots, type PropDef } from '../src/props.js';
import { FURNITURE_SIZE } from '../src/sprites/furniture.js';

const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
const ALL_ON = { birch: true, ash: true, cedar: true, local: true } as const;
const ids = (props: readonly PropDef[]): readonly string[] => props.map((p) => p.id);
const find = (props: readonly PropDef[], id: string): PropDef | undefined => props.find((p) => p.id === id);
const lounges = (props: readonly PropDef[], room: string): readonly PropDef[] => props.filter((p) => p.room === room && p.lounge);

describe('propsFor', () => {
  it('lists the furniture with a rack per server room and the HQ fixtures when every lounge is on', () => {
    const props = propsFor(map, ALL_ON);
    expect(props).toHaveLength(45);
    expect(ids(props).slice(-13)).toEqual([
      'board-hq', 'library-hq', 'notes-hq', 'fuse-hq', 'clock-hq', 'schedule-hq', 'tv-hq', 'wins-hq', 'robot-hq',
      'links-birch', 'links-ash', 'links-cedar', 'links-local',
    ]);
    expect(ids(props).slice(0, 4)).toEqual(['rack-birch', 'rack-ash', 'rack-cedar', 'rack-local']);
    expect(new Set(ids(props)).size).toBe(props.length);
  });

  it('places the cedar rack at its fixed position', () => {
    const rack = find(propsFor(map, {}), 'rack-cedar');
    expect(rack).toEqual({ id: 'rack-cedar', kind: 'rack', x: 385, y: 402, sortY: 448, room: 'cedar', blocks: [{ x: 24, y: 26, w: 2, h: 2 }], lounge: false });
  });

  it('keeps the position and blocked tiles of fixed furniture', () => {
    const props = propsFor(map, {});
    expect(find(props, 'luadydesk-1')).toMatchObject({ x: 640, y: 302, sortY: 336, room: 'hq', blocks: [{ x: 40, y: 19, w: 4, h: 2 }] });
    expect(find(props, 'sofa-1')).toMatchObject({ x: 130, y: 284, sortY: 304, room: null, blocks: [{ x: 8, y: 18, w: 4, h: 1 }] });
    expect(find(props, 'workbench-1')).toMatchObject({ x: 592, room: 'hq', blocks: [{ x: 37, y: 36, w: 5, h: 1 }] });
    expect(find(props, 'robot-hq')).toMatchObject({ x: 725, room: 'hq', blocks: [{ x: 45, y: 35, w: 2, h: 2 }] });
    expect(find(props, 'versions-1')).toMatchObject({ x: 688, room: 'hq' });
    expect(find(props, 'table-1')).toMatchObject({ x: 1120, room: null, blocks: [{ x: 70, y: 20, w: 4, h: 2 }] });
    expect(find(props, 'plant-2')).toMatchObject({ x: 1297, room: 'ash' });
    expect(props.some((p) => (p.kind as string) === 'bookshelf')).toBe(false);
  });

  it('includes the lounge table in ash when its lounge is on', () => {
    const table = propsFor(map, { ash: true }).find((p) => p.kind === 'table' && p.room === 'ash');
    expect(table).toMatchObject({ lounge: true, blocks: [{ x: 70, y: 13, w: 4, h: 2 }] });
  });

  it('drops the lounge of a room whose lounge is off but keeps its rack and the other rooms', () => {
    const props = propsFor(map, { ash: false, local: true });
    expect(lounges(props, 'ash')).toEqual([]);
    expect(ids(props)).toContain('rack-ash');
    expect(lounges(props, 'local').map((p) => p.kind)).toEqual(['table']);
  });

  it('switches the three cedar plants with the cedar lounge', () => {
    expect(lounges(propsFor(map, { cedar: true }), 'cedar').map((p) => p.kind)).toEqual(['plant', 'plant', 'plant']);
    expect(lounges(propsFor(map, { cedar: false }), 'cedar')).toEqual([]);
  });

  it('counts a room missing from the record as off and leaves racks and other furniture alone', () => {
    const props = propsFor(map, {});
    expect(props.some((p) => p.lounge)).toBe(false);
    expect(props).toHaveLength(45 - 5);
    expect(ids(props).filter((id) => id.startsWith('rack-'))).toHaveLength(4);
    expect(ids(propsFor(map, ALL_ON)).filter((id) => !find(props, id))).toEqual(['table-2', 'table-3', 'plant-7', 'plant-8', 'plant-9']);
  });

  it('puts no furniture in a lot', () => {
    const small = buildOffice(classicRooms(['birch']));
    const props = propsFor(small, ALL_ON);
    expect(ids(props).filter((id) => id.startsWith('rack-'))).toEqual(['rack-birch']);
    expect(props.every((p) => p.room === null || p.room === 'birch' || p.room === 'hq')).toBe(true);
  });

  it('furnishes HQ like a manager office: a meeting table, a reading bench, a water cooler, a coffee corner, a sofa and plants', () => {
    const hq = propsFor(map, {}).filter((p) => p.room === 'hq').map((p) => p.kind);
    expect(hq).toEqual(expect.arrayContaining(['meeting', 'readbench', 'cooler', 'coffee', 'sofa', 'plant']));
    expect(find(propsFor(map, {}), 'meeting-1')).toMatchObject({ x: 768, blocks: [{ x: 48, y: 8, w: 6, h: 4 }] });
  });

  it('puts nothing else where the clock, schedule, TV, wins board and robot hang and stand', () => {
    const props = propsFor(map, ALL_ON);
    const size = (p: PropDef) => FURNITURE_SIZE[p.kind];
    const box = (p: PropDef) => ({ x: p.x, y: p.y, w: size(p).w, h: size(p).h });
    const meet = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    ['clock-hq', 'schedule-hq', 'tv-hq', 'wins-hq', 'robot-hq', 'links-birch', 'links-ash', 'links-cedar', 'links-local'].forEach((id) => {
      const fixture = find(props, id)!;
      expect([id, props.filter((p) => p !== fixture && meet(box(p), box(fixture))).map((p) => p.id)]).toEqual([id, []]);
    });
  });

  it('hangs a Jira board only in the server rooms that have Jira, and keeps the same list for the same rooms', () => {
    const props = propsFor(map, {}, { jiraRooms: ['ash', 'hq', 'mars', 'ash'] });
    expect(props.filter((p) => p.kind === 'jira').map((p) => p.id)).toEqual(['jira-ash']);
    expect(find(props, 'jira-ash')).toMatchObject({ x: 960, y: 25, room: 'ash', blocks: [] });
    expect(propsFor(map, {}, { jiraRooms: ['ash'] })).toBe(props);
    expect(propsFor(map, {})).not.toBe(props);
    expect(propsFor(buildOffice(classicRooms(['birch'])), {}, { jiraRooms: ['ash'] }).some((p) => p.kind === 'jira')).toBe(false);
  });

  it('returns frozen props', () => {
    const props = propsFor(map, ALL_ON);
    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isFrozen(props[0])).toBe(true);
    expect(Object.isFrozen(props[0]?.blocks)).toBe(true);
  });
});

describe('hasLounge', () => {
  it('is true only for server rooms with lounge pieces', () => {
    expect(['birch', 'ash', 'cedar', 'local', 'hq'].map((id) => hasLounge(map.rooms[id]!))).toEqual([false, true, true, true, false]);
    expect(hasLounge(buildOffice([]).rooms['lot-1']!)).toBe(false);
    expect(hasLounge(buildOffice(classicRooms(['birch'])).rooms['lot-1']!)).toBe(false);
  });
});

describe('shownSlots', () => {
  const all = slotsFor(map.rooms.ash!, 'normal');

  it('keeps the first 8 desks while the lounge is out, and every desk otherwise', () => {
    expect(shownSlots(all, true).map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(shownSlots(all, false)).toBe(all);
    expect(Object.isFrozen(shownSlots(all, true))).toBe(true);
  });

  it('never adds desks to a shorter list', () => {
    expect(shownSlots(all.slice(0, 3), true)).toHaveLength(3);
  });
});

describe('loungeOn', () => {
  it('is on in normal mode while every seat is below the third desk row', () => {
    expect(LOUNGE_FIRST_BLOCKING_SEAT).toBe(8);
    expect(loungeOn('normal', [])).toBe(true);
    expect(loungeOn('normal', [0, 1, 2, 3, 4, 5, 6, 7])).toBe(true);
    expect(loungeOn('normal', [0, 8])).toBe(false);
    expect(loungeOn('normal', [9])).toBe(false);
  });

  it('is always off in tight mode', () => {
    expect(loungeOn('tight', [])).toBe(false);
    expect(loungeOn('tight', [0])).toBe(false);
  });
});
