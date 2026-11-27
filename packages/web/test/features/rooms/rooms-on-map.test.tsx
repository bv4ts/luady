import type { RoomDTO } from '@luady/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import { fakeApi, type FakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { classicRoomDtos, roomDto } from '../../room-fixtures.js';
import { fleetOverview } from '../agency/agency-fixtures.js';
import { resetStageSpy, stageProps } from '../agency/stage-mock.js';

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('../agency/stage-mock.js'));
vi.mock('../../../src/features/rooms/creature-preview.js', () => ({ CREATURE_PX: 24, drawCreature: vi.fn(async () => false) }));

const GRID = { slotCount: 4, K: 1, R: 1, capacity: 4 };
const written = (room: RoomDTO) => ({ room, adjusted: { colour: false, accent: false }, warnings: [] });

function pageApi(): FakeApi {
  return fakeApi({
    luadyMessages: async () => ({ items: [], nextCursor: null }),
    transcript: async () => ({ items: [], nextCursor: null }),
    previewRoom: async () => ({ sessions: [], projects: [], overlaps: [] }),
  });
}

/** What the map (the stage's snapshot) shows for a room key: its name, colour and slot; undefined when it is not there. */
function onMap(key: string) {
  const def = stageProps().snapshot.map.rooms[key];
  return def === undefined ? undefined : { name: def.name, colour: def.palette.base, slot: def.slot?.index ?? null, kind: def.kind };
}

async function openOffice(rooms: RoomDTO[] = classicRoomDtos()) {
  const api = pageApi();
  const h = await renderPage(<AgencyPage />, { api, overview: fleetOverview({ rooms }) });
  await screen.findByTestId('agency-stage');
  return h;
}

async function editRoom(h: Awaited<ReturnType<typeof openOffice>>, room: string) {
  act(() => stageProps().onEvent({ type: 'room', room }));
  await h.user.click(await screen.findByRole('button', { name: 'Edit room' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rooms' });
  await within(dialog).findByTestId('room-editor');
  return dialog;
}

beforeEach(() => resetStageSpy());

describe('the open editor survives what the store does meanwhile', () => {
  it('server updates, rooms.changed (even a room in its own spot), an overview reload and other pushes neither close nor remount it', async () => {
    const h = await openOffice(classicRoomDtos().filter((room) => room.id !== 'cedar'));
    act(() => stageProps().onEvent({ type: 'room', room: 'lot-2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rooms' });
    const editor = await within(dialog).findByTestId('room-editor');
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    await h.user.clear(name);
    await h.user.type(name, 'Meadow office');
    const at = '2026-11-21T09:00:00.000Z';
    const others = classicRoomDtos().filter((room) => room.id !== 'cedar');
    act(() => h.ws.emit({ type: 'server.updated', server: { ...fleetOverview().servers[2]!, status: 'connecting', lastSeenAt: at } }));
    act(() => h.ws.emit({ type: 'rooms.changed', rooms: [...others, roomDto({ id: 'venus', name: 'Venus', host: null, kind: 'project', match: [{ by: 'name', glob: 'v*' }], position: 5 })], at }));
    act(() => h.ws.emit({ type: 'rooms.changed', rooms: [...others, roomDto({ id: 'cedar', name: 'Meadow', host: 'cedar', position: 2 })], at }));
    act(() => h.ws.emit({ type: 'prefs.changed', at }));
    act(() => h.ws.emit({ type: 'links.changed', at }));
    h.ws.setStatus('reconnecting', 1);
    h.ws.setStatus('open', 2);
    await waitFor(() => expect(h.api.overview).toHaveBeenCalledTimes(2));
    act(() => stageProps().onView?.({ rect: { x: 0, y: 0, w: 400, h: 300 }, scale: 1, far: false }));
    act(() => stageProps().onFrame([]));
    expect(screen.getByRole('dialog', { name: 'Rooms' })).toBe(dialog);
    expect(within(dialog).getByTestId('room-editor')).toBe(editor);
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Meadow office');
  });
});

describe('room changes reach the map at once', () => {
  it('add: a room made from a "+ Add room" plaque appears in its spot, and the camera goes there', async () => {
    const h = await openOffice(classicRoomDtos().filter((room) => room.id !== 'cedar'));
    expect(onMap('lot-2')?.kind).toBe('lot');
    h.api.createRoom.mockImplementation(async (body) => written(roomDto({
      id: 'cedar', name: body.name, host: body.host ?? null, position: body.position ?? 9, colour: body.colour ?? '#3d7bff', species: body.species ?? 'bun',
    })));
    act(() => stageProps().onEvent({ type: 'room', room: 'lot-2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rooms' });
    await waitFor(() => expect((within(dialog).getByLabelText('Server') as HTMLSelectElement).value).toBe('cedar'));
    await h.user.click(within(dialog).getByRole('button', { name: 'Add the room' }));
    await waitFor(() => expect(onMap('cedar')).toMatchObject({ name: 'Cedar', slot: 2, kind: 'server' }));
    expect(h.api.createRoom).toHaveBeenCalledWith(expect.objectContaining({ host: 'cedar', position: 2 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rooms' })).toBeNull());
    expect(stageProps().focus).toEqual({ kind: 'room', room: 'cedar' });
  });

  it('rename and recolour: the plaque and the room take the new name and colour', async () => {
    const h = await openOffice();
    const dialog = await editRoom(h, 'ash');
    h.api.updateRoom.mockImplementation(async (id, body) => {
      const before = classicRoomDtos().find((room) => room.id === id) as RoomDTO;
      return written({ ...before, name: body.name ?? before.name, short: body.name ?? before.short, colour: body.colour ?? before.colour, accent: body.accent ?? before.accent, updatedAt: '2026-11-21T09:00:00.000Z' });
    });
    const name = within(dialog).getByLabelText('Name');
    await h.user.clear(name);
    await h.user.type(name, 'Docks');
    await h.user.click(within(dialog).getByRole('radio', { name: 'Azure' }));
    await h.user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onMap('ash')).toMatchObject({ name: 'Docks', colour: '#3d7bff', slot: 1 }));
    expect(h.api.updateRoom).toHaveBeenCalledWith('ash', expect.objectContaining({ name: 'Docks', colour: '#3d7bff' }));
    await waitFor(() => expect(screen.queryAllByTestId('room-plaque').some((plaque) => plaque.textContent?.includes('Docks'))).toBe(true));
  });

  it('reorder: moving a room to another spot moves it on the map', async () => {
    const h = await openOffice();
    const moved = classicRoomDtos().map((room) => (room.id === 'local' ? { ...room, position: 0 } : room.id === 'birch' ? { ...room, position: 3 } : room));
    h.api.moveRoom.mockResolvedValue({ items: moved, grid: GRID });
    act(() => stageProps().onEvent({ type: 'room', room: 'hq' }));
    await h.user.click(await screen.findByTestId('rooms-menu-button'));
    await h.user.click(screen.getByRole('button', { name: 'Manage rooms' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rooms' });
    await h.user.click(await within(dialog).findByRole('button', { name: 'Move Private Projects to another spot' }));
    await h.user.selectOptions(within(dialog).getByLabelText('Move Private Projects to'), '0');
    await h.user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onMap('local')?.slot).toBe(0));
    expect(onMap('birch')?.slot).toBe(3);
    expect(h.api.moveRoom).toHaveBeenCalledWith('local', 0);
  });

  it('remove: the room leaves the map, its spot becomes free, its sessions are not on the map any more', async () => {
    const h = await openOffice();
    h.api.deleteRoom.mockResolvedValue({ ok: true });
    const dialog = await editRoom(h, 'cedar');
    await h.user.click(within(dialog).getByRole('button', { name: 'Remove…' }));
    await h.user.click(within(dialog).getByRole('button', { name: 'Remove the room' }));
    await waitFor(() => expect(onMap('cedar')).toBeUndefined());
    expect(onMap('lot-2')?.kind).toBe('lot');
    expect(h.api.deleteRoom).toHaveBeenCalledWith('cedar', { links: 'move', jira: 'move', to: 'birch' });
    expect(stageProps().snapshot.unplaced).toContain('cedar:meadow-vat');
  });
});
