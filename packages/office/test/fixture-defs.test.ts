import { describe, expect, it } from 'vitest';
import type { HostId } from '@luady/shared';
import { slotsFor, type DeskMode } from '../src/desks.js';
import { FIXTURE_KINDS, fixturesFor, type FixtureDef } from '../src/fixtures.js';
import { buildOffice, roomRectPx } from '../src/layout.js';
import { propsFor } from '../src/props.js';
import { ENTRIES, HQ_DOORS } from '../src/rooms.js';
import { TILE, type PixelRect, type TileRect } from '../src/types.js';
import { classicRooms } from './rooms-fixture.js';

const ALL: readonly HostId[] = ['cedar', 'birch', 'ash', 'local'];
const map = buildOffice(classicRooms(ALL));
const withJira = fixturesFor(map, { jiraRooms: ALL });
const byId = (list: readonly FixtureDef[], id: string): FixtureDef | undefined => list.find((f) => f.id === id);

const px = (r: TileRect): PixelRect => ({ x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE });
const overlaps = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: PixelRect, b: PixelRect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/** A desk with its monitor standing on its back edge. */
const deskBoxes = (mode: DeskMode): readonly PixelRect[] =>
  ALL.flatMap((s) => slotsFor(map.rooms[s]!, mode).map((slot) => ({ x: slot.desk.x, y: slot.desk.y - 9, w: 48, h: 27 })));
const doorBoxes: readonly PixelRect[] = [...ALL.map((s) => px(map.rooms[s]!.doorway)), ...HQ_DOORS.map(px), ...ENTRIES.map(px)];

describe('fixturesFor', () => {
  it('lists the fixtures: a rack and a links board per server room and the nine HQ fixtures', () => {
    expect(fixturesFor(map).map((f) => f.id)).toEqual(['rack-birch', 'rack-ash', 'rack-cedar', 'rack-local', 'board-hq', 'library-hq', 'notes-hq', 'fuse-hq', 'clock-hq', 'schedule-hq', 'tv-hq', 'wins-hq', 'robot-hq', 'links-birch', 'links-ash', 'links-cedar', 'links-local']);
    const small = fixturesFor(buildOffice(classicRooms(['cedar']))).map((f) => f.id);
    expect(small.filter((id) => id.startsWith('links-'))).toEqual(['links-cedar']);
  });

  it('places the clock, schedule, TV, wins board, robot and links boards, with their labels', () => {
    expect(byId(withJira, 'clock-hq')).toMatchObject({ kind: 'clock', room: 'hq', box: { x: 614, w: 12, h: 12 }, label: 'Today' });
    expect(byId(withJira, 'schedule-hq')).toMatchObject({ kind: 'schedule', box: { x: 780, w: 26, h: 24 }, label: 'Schedule' });
    expect(byId(withJira, 'tv-hq')).toMatchObject({ kind: 'tv', box: { x: 812, w: 56, h: 28 }, label: 'Fleet' });
    expect(byId(withJira, 'wins-hq')).toMatchObject({ kind: 'wins', box: { x: 29 * 16, y: 31 * 16 - 26, w: 80, h: 26 }, label: 'Wins' });
    expect(byId(withJira, 'robot-hq')).toMatchObject({ kind: 'robot', box: { x: 725, w: 22, h: 28 }, label: 'Help' });
    ['birch', 'ash', 'cedar', 'local'].forEach((room) => expect(byId(withJira, `links-${room}`)).toMatchObject({ kind: 'links', room, box: { w: 24, h: 18 }, label: 'Links' }));
  });

  it('hangs the links boards beside the wall board: left of it in the west rooms, right of it in the east rooms', () => {
    ['birch', 'cedar'].forEach((room) => expect(byId(withJira, `links-${room}`)!.box.x + 24).toBeLessThan(byId(withJira, `jira-${room}`)!.box.x));
    ['ash', 'local'].forEach((room) => expect(byId(withJira, `links-${room}`)!.box.x).toBeGreaterThan(byId(withJira, `jira-${room}`)!.box.x + 62));
  });

  it('adds a Jira board for each server room in jiraRooms, and ignores anything else', () => {
    expect(withJira.filter((f) => f.kind === 'jira').map((f) => f.id)).toEqual(['jira-birch', 'jira-ash', 'jira-cedar', 'jira-local']);
    const some = fixturesFor(buildOffice(classicRooms(['birch'])), { jiraRooms: ['ash', 'birch', 'hq', 'lot-1', 'mars'] });
    expect(some.filter((f) => f.kind === 'jira').map((f) => f.id)).toEqual(['jira-birch']);
    expect(some.filter((f) => f.kind === 'rack').map((f) => f.id)).toEqual(['rack-birch']);
  });

  it('places the HQ fixtures at their pinned positions', () => {
    expect(byId(withJira, 'board-hq')).toEqual({ id: 'board-hq', kind: 'board', room: 'hq', box: { x: 464, y: 17, w: 144, h: 30 }, anchor: { x: 536, y: 17 }, label: 'Board' });
    expect(byId(withJira, 'library-hq')).toMatchObject({ kind: 'library', box: { x: 640, y: 32, w: 132, h: 32 }, label: 'Library' });
    expect(byId(withJira, 'fuse-hq')).toMatchObject({ kind: 'fuse', box: { x: 872, y: 20, w: 20, h: 26 }, label: 'Accounts' });
    const notes = byId(withJira, 'notes-hq');
    expect(notes).toMatchObject({ kind: 'notes', label: 'Notes', room: 'hq' });
    expect(notes!.box.x).toBeGreaterThanOrEqual(29 * TILE);
    expect(notes!.box.x + notes!.box.w).toBeLessThanOrEqual(33 * TILE);
    expect(notes!.box.y + notes!.box.h).toBe(10 * TILE);
    expect(byId(withJira, 'rack-cedar')).toMatchObject({ kind: 'rack', room: 'cedar', box: { x: 385, y: 402, w: 30, h: 46 }, anchor: { x: 400, y: 402 }, label: 'Server' });
    expect(byId(withJira, 'jira-ash')).toMatchObject({ kind: 'jira', room: 'ash', box: { x: 960, y: 25, w: 62, h: 18 }, label: 'Jira' });
  });

  it('hangs the board, clock, schedule, TV and fuse box on the north wall face, and the links boards on their back walls', () => {
    ['board-hq', 'clock-hq', 'schedule-hq', 'tv-hq', 'fuse-hq'].forEach((id) => {
      const box = byId(withJira, id)!.box;
      expect(box.y).toBeGreaterThanOrEqual(16);
      expect(box.y + box.h).toBeLessThanOrEqual(48);
    });
    ['birch', 'ash', 'cedar', 'local'].forEach((room) => {
      const box = byId(withJira, `links-${room}`)!.box;
      const top = map.rooms[room]!.rect.y * 16;
      expect(box.y).toBeGreaterThanOrEqual(top);
      expect(box.y + box.h).toBeLessThanOrEqual(top + 32);
    });
  });

  it('gives every fixture its anchor at the top centre of its box', () => {
    withJira.forEach((f) => expect(f.anchor).toEqual({ x: f.box.x + f.box.w / 2, y: f.box.y }));
  });

  it('keeps every fixture box inside its room', () => {
    withJira.forEach((f) => expect([f.id, inside(f.box, roomRectPx(map.rooms[f.room]!))]).toEqual([f.id, true]));
  });

  it.each(['normal', 'tight'] as DeskMode[])('puts no fixture over a desk (%s mode), a door or another fixture', (mode) => {
    const desks = deskBoxes(mode);
    withJira.forEach((f) => {
      expect([f.id, desks.filter((d) => overlaps(d, f.box))]).toEqual([f.id, []]);
      expect([f.id, doorBoxes.filter((d) => overlaps(d, f.box))]).toEqual([f.id, []]);
      expect([f.id, withJira.filter((g) => g !== f && overlaps(g.box, f.box)).map((g) => g.id)]).toEqual([f.id, []]);
    });
  });

  it('has a prop of the same id and place for every fixture', () => {
    const props = propsFor(map, {}, { jiraRooms: ALL });
    withJira.forEach((f) => expect(props.find((p) => p.id === f.id)).toMatchObject({ x: f.box.x, y: f.box.y, room: f.room }));
  });

  it('returns the same frozen list for the same inputs', () => {
    expect(fixturesFor(map, { jiraRooms: ['local', 'birch', 'cedar', 'ash'] })).toBe(withJira);
    expect(Object.isFrozen(withJira)).toBe(true);
    expect(Object.isFrozen(withJira[0])).toBe(true);
    expect(Object.isFrozen(withJira[0]?.box)).toBe(true);
  });
});

describe('FIXTURE_KINDS', () => {
  it('names the twelve kinds in use, and every one is placed', () => {
    expect(FIXTURE_KINDS).toEqual(['rack', 'board', 'library', 'notes', 'fuse', 'jira', 'tv', 'clock', 'schedule', 'wins', 'robot', 'links']);
    expect(new Set(withJira.map((f) => f.kind))).toEqual(new Set(FIXTURE_KINDS));
  });
});
