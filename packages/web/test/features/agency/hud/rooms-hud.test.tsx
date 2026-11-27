import { buildOffice, buildSnapshot, type AgencySnapshot } from '@luady/office';
import type { SessionDTO } from '@luady/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoomChips } from '../../../../src/features/agency/hud/RoomChips.js';
import { roomCounts } from '../../../../src/features/agency/model/room-counts.js';
import { labelView, nextLabelView, NO_VIEW } from '../../../../src/features/agency/model/view-rooms.js';
import { shortcutAction } from '../../../../src/features/agency/useShortcuts.js';
import { NOW, luadyStatus, server } from '../../../fixtures.js';
import { classicRoomDtos, manyRooms } from '../../../room-fixtures.js';
import { agent, snapshotOf } from '../agency-fixtures.js';

vi.mock('../../../../src/features/agency/model/room-counts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/features/agency/model/room-counts.js')>();
  return { ...real, roomCounts: vi.fn(real.roomCounts) };
});

/** 300 rooms on 300 hosts and 1,000 sessions spread over them (host k holds sessions i with i % 300 = k). */
function bigOffice(): { snapshot: AgencySnapshot; perHost: ReadonlyMap<string, number> } {
  const rooms = manyRooms(300);
  const sessions: SessionDTO[] = Array.from({ length: 1000 }, (_, i) => agent(`site-${(i % 300) + 1}`, `job-${i}`, { state: i % 7 === 0 ? 'idle' : 'working' }));
  const perHost = new Map<string, number>();
  sessions.forEach((s) => perHost.set(s.host, (perHost.get(s.host) ?? 0) + 1));
  const snapshot = buildSnapshot({
    servers: rooms.map((room) => server({ name: room.host ?? '' })), rooms, sessions, questions: [], luady: luadyStatus(),
    now: Date.parse(NOW), previousSeats: {},
  });
  return { snapshot, perHost };
}

describe('room chips at any number of rooms', () => {
  it('with 300 rooms and 1,000 sessions every count is right, from one grouping pass per render', () => {
    const { snapshot, perHost } = bigOffice();
    const counted = vi.mocked(roomCounts);
    counted.mockClear();
    const { rerender } = render(<RoomChips snapshot={snapshot} focus={{ kind: 'all' }} dispatch={() => undefined} />);
    expect(counted).toHaveBeenCalledTimes(1);
    const chips = screen.getAllByRole('button').filter((button) => button.dataset.room !== undefined);
    expect(chips).toHaveLength(301);
    const room = (id: string) => chips.find((chip) => chip.dataset.room === id);
    for (const id of ['site-1', 'site-100', 'site-300']) {
      expect(room(id)?.getAttribute('aria-label')).toContain(`${perHost.get(id) ?? 0} sessions`);
    }
    const total = roomCounts(snapshot).reduce((sum, chip) => sum + (chip.count ?? 0), 0);
    expect(total).toBe(1000);
    counted.mockClear();
    rerender(<RoomChips snapshot={snapshot} focus={{ kind: 'room', room: 'site-5' }} dispatch={() => undefined} />);
    expect(counted).toHaveBeenCalledTimes(1);
  });

  it('chips follow the slot order with HQ in its place, and none for empty slots', () => {
    const snapshot = snapshotOf({ rooms: classicRoomDtos().filter((room) => room.id !== 'cedar') });
    render(<RoomChips snapshot={snapshot} focus={{ kind: 'all' }} dispatch={() => undefined} />);
    const keys = screen.getAllByRole('button').flatMap((button) => (button.dataset.room === undefined ? [] : [button.dataset.room]));
    expect(keys).toEqual(['birch', 'ash', 'hq', 'local']);
  });
});

describe('the Rooms menu', () => {
  const open = (snapshot: AgencySnapshot, dispatch = vi.fn()) => {
    render(<RoomChips snapshot={snapshot} focus={{ kind: 'all' }} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId('rooms-menu-button'));
    return { dispatch, search: screen.getByRole('combobox', { name: 'Find a room by name, server or kind' }) };
  };

  it('finds rooms by name, by server and by kind; Enter flies there', () => {
    const { dispatch, search } = open(snapshotOf());
    expect(screen.getByTestId('rooms-menu-button').textContent).toContain('4');
    fireEvent.change(search, { target: { value: 'harb' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.dataset.room)).toEqual(['ash']);
    fireEvent.change(search, { target: { value: 'cedar' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.dataset.room)).toEqual(['cedar']);
    fireEvent.change(search, { target: { value: 'server' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(4);
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'focus', focus: { kind: 'room', room: 'ash' } });
    expect(screen.queryByTestId('rooms-menu')).toBeNull();
  });

  it('says so when nothing matches, and Esc closes it', () => {
    const { search } = open(snapshotOf());
    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No room matches.')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByTestId('rooms-menu')).toBeNull();
  });

  it('draws only the rows in view with 300 rooms, and still finds the last one', () => {
    const { search } = open(bigOffice().snapshot);
    expect(within(screen.getByRole('listbox')).getAllByRole('option').length).toBeLessThan(40);
    fireEvent.change(search, { target: { value: 'site 300' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.dataset.room)).toEqual(['site-300']);
  });

  it('opens the rooms list and a new room from its foot', () => {
    const { dispatch } = open(snapshotOf());
    fireEvent.click(screen.getByRole('button', { name: '+ Add a room' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'modal', modal: { kind: 'rooms', add: true } });
  });
});

describe('number keys follow the map order', () => {
  it('the classic four keep their keys: 1 Orchard, 2 Harbor, 3 HQ, 4 Meadow, 5 Private; 0 is the whole office', () => {
    const { order } = buildOffice(classicRoomDtos());
    const focus = (key: string) => shortcutAction(key, order);
    expect(['1', '2', '3', '4', '5'].map((key) => focus(key))).toEqual(['birch', 'ash', 'hq', 'cedar', 'local']
      .map((room) => ({ type: 'focus', focus: { kind: 'room', room } })));
    expect(focus('0')).toEqual({ type: 'focus', focus: { kind: 'all' } });
    expect(focus('6')).toBeNull();
  });

  it('9 reaches the eighth room; an empty slot\'s key does nothing', () => {
    const map = buildOffice(manyRooms(12));
    expect(shortcutAction('9', map.order)).toEqual({ type: 'focus', focus: { kind: 'room', room: 'site-8' } });
    const gap = buildOffice(classicRoomDtos().filter((room) => room.id !== 'ash'));
    const empty = new Set(gap.order.filter((key) => key.startsWith('lot-')));
    expect(shortcutAction('2', gap.order, empty)).toBeNull();
    expect(shortcutAction('3', gap.order, empty)).toEqual({ type: 'focus', focus: { kind: 'room', room: 'hq' } });
  });
});

describe('what the view labels', () => {
  const map = buildOffice(manyRooms(24));
  const rectOf = (id: string) => {
    const r = map.rooms[id]?.rect;
    if (r === undefined) throw new Error(`no room ${id}`);
    return { x: r.x * 16 + 8, y: r.y * 16 + 8, w: 64, h: 64 };
  };

  it('before the first view, every room; then only rooms meeting the view', () => {
    expect(labelView(map, null)).toBe(NO_VIEW);
    const view = labelView(map, { rect: rectOf('site-1'), scale: 1, far: false });
    expect(view.far).toBe(false);
    expect(view.rooms).toEqual(['site-1']);
  });

  it('in far mode, badges for the live rooms nearest the centre, never more than 300', () => {
    const all = { x: 0, y: 0, w: map.width, h: map.height };
    const view = labelView(map, { rect: all, scale: 0.2, far: true });
    expect(view.far).toBe(true);
    expect(view.rooms).toHaveLength(25);
    expect(view.lots).toEqual([]);
    const big = buildOffice(manyRooms(400));
    const far = labelView(big, { rect: { x: 0, y: 0, w: big.width, h: big.height }, scale: 0.05, far: true });
    expect(far.rooms?.length).toBeLessThanOrEqual(301);
  });

  it('keeps the same object while the labelled rooms stay the same', () => {
    const first = labelView(map, { rect: rectOf('site-1'), scale: 1, far: false });
    const moved = nextLabelView(first, map, { rect: { ...rectOf('site-1'), x: rectOf('site-1').x + 4 }, scale: 1.1, far: false });
    expect(moved).toBe(first);
  });

  it('empty slots in view get a "+ Add room" plaque', () => {
    const gap = buildOffice(classicRoomDtos().filter((room) => room.id !== 'ash'));
    const view = labelView(gap, { rect: { x: 0, y: 0, w: gap.width, h: gap.height }, scale: 1, far: false });
    expect(view.lots).toEqual(['lot-1']);
    expect(view.rooms).not.toContain('lot-1');
  });
});

describe('a counting spy sees renders, not frames', () => {
  it('re-rendering with the same snapshot still counts once per render', () => {
    const snapshot = snapshotOf();
    const counted = vi.mocked(roomCounts);
    counted.mockClear();
    const { rerender } = render(<RoomChips snapshot={snapshot} focus={{ kind: 'all' }} dispatch={() => undefined} />);
    act(() => rerender(<RoomChips snapshot={snapshot} focus={{ kind: 'all' }} dispatch={() => undefined} />));
    expect(counted).toHaveBeenCalledTimes(2);
  });
});
