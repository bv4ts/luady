import type { RoomCreateBody, RoomDTO, RoomWriteDTO } from '@luady/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { DeleteRoomDialog } from '../../../src/features/rooms/DeleteRoomDialog.js';
import { RoomEditor } from '../../../src/features/rooms/RoomEditor.js';
import { RoomsManager } from '../../../src/features/rooms/RoomsManager.js';
import { overview, server, session } from '../../fixtures.js';
import { fakeApi, type FakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { classicRoomDtos, manyRooms, roomDto } from '../../room-fixtures.js';

vi.mock('../../../src/features/rooms/creature-preview.js', () => ({ CREATURE_PX: 24, drawCreature: vi.fn(async () => false) }));

const MARS = server({ name: 'mars', projectsRoot: '/srv/work' });
const COMPUTER = server({ name: 'computer', kind: 'local', projectsRoot: '/home/me/projects', terminal: false });
const written = (room: RoomDTO): RoomWriteDTO => ({ room, adjusted: { colour: false, accent: false }, warnings: [] });

function api(): FakeApi {
  return fakeApi({
    createRoom: async (body) => written(roomDto({ id: 'mars', name: body.name, host: body.host ?? null, kind: body.kind, position: 4 })),
    previewRoom: async () => ({ sessions: ['mars:web:0.0'], projects: ['mars/web-app'], overlaps: [{ room: 'ash', projects: ['mars/web-app'] }] }),
  });
}

async function open(ui: React.ReactElement, rooms: RoomDTO[] = classicRoomDtos(), fake: FakeApi = api()) {
  const harness = await renderPage(ui, {
    api: fake, overview: overview({ servers: [server({ name: 'birch' }), server({ name: 'ash' }), MARS, COMPUTER], rooms, sessions: [session({ id: 'mars:web:0.0', host: 'mars', displayName: 'web' })] }),
  });
  return harness;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('adding a room takes a host and a name, and it is ready as it opens', () => {
  it('opens on the first free server, named after it; Add puts it on the map', async () => {
    const onDone = vi.fn();
    const h = await open(<RoomEditor onDone={onDone} onCancel={() => undefined} />);
    expect((screen.getByRole('radio', { name: /A server/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Server') as HTMLSelectElement).value).toBe('mars');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mars');
    await h.user.click(screen.getByRole('button', { name: 'Add the room' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const body = h.api.createRoom.mock.calls[0]?.[0] as RoomCreateBody;
    expect(body).toMatchObject({ name: 'Mars', kind: 'server', host: 'mars', species: 'cat' });
    expect(body.colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(await screen.findByText('Mars is on the map.')).toBeTruthy();
  });

  it('a plaque\'s spot is sent with the room', async () => {
    const h = await open(<RoomEditor position={6} onDone={() => undefined} onCancel={() => undefined} />);
    await h.user.click(screen.getByRole('button', { name: 'Add the room' }));
    await waitFor(() => expect(h.api.createRoom).toHaveBeenCalledWith(expect.objectContaining({ position: 6 })));
  });

  it('this computer is a kind of its own; a project room needs a match and shows what it would hold', async () => {
    const h = await open(<RoomEditor onDone={() => undefined} onCancel={() => undefined} />);
    await h.user.click(screen.getByRole('radio', { name: /This computer/ }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('This computer');
    await h.user.click(screen.getByRole('radio', { name: /A project/ }));
    await h.user.clear(screen.getByLabelText('Name'));
    await h.user.type(screen.getByLabelText('Name'), 'Web');
    await h.user.click(screen.getByRole('button', { name: 'Add the room' }));
    expect(screen.getByText('A project room needs at least one project name or folder.')).toBeTruthy();
    expect(h.api.createRoom).not.toHaveBeenCalled();
    await h.user.click(screen.getAllByRole('button', { name: 'Add a project' })[0] as HTMLElement);
    await h.user.type(screen.getByLabelText('Project name 1'), 'web-*');
    const preview = await screen.findByTestId('room-preview', {}, { timeout: 2000 });
    expect(preview.textContent).toContain('1 live session would sit here: web.');
    // The room is on any server: a project names its server (mars has no room of its own yet, so its id).
    expect(preview.textContent).toContain('Projects it holds: web-app (mars).');
    expect(preview.textContent).toContain('Harbor also matches web-app (mars). The more exact match wins.');
  });
});

describe('a shown form stays as it is while the store moves', () => {
  const at = '2026-11-21T09:00:00.000Z';

  it('a server update that changes nothing relevant leaves the form alone', async () => {
    const h = await open(<RoomEditor onDone={() => undefined} onCancel={() => undefined} />);
    expect((screen.getByLabelText('Server') as HTMLSelectElement).value).toBe('mars');
    act(() => h.ws.emit({ type: 'server.updated', server: { ...MARS, status: 'connecting', lastSeenAt: at } }));
    act(() => h.ws.emit({ type: 'server.updated', server: server({ name: 'venus' }) }));
    expect((screen.getByLabelText('Server') as HTMLSelectElement).value).toBe('mars');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mars');
  });

  it('a room made elsewhere for the shown host does not swap the form under the owner; Add sends what is on screen', async () => {
    const fake = api();
    fake.createRoom.mockRejectedValueOnce(new ApiError(409, 'home_room_exists', 'mars already has its room'));
    const h = await open(<RoomEditor onDone={() => undefined} onCancel={() => undefined} />, classicRoomDtos(), fake);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mars');
    act(() => h.ws.emit({ type: 'rooms.changed', rooms: [...classicRoomDtos(), roomDto({ id: 'red', name: 'Red planet', host: 'mars', position: 4 })], at }));
    expect((screen.getByRole('radio', { name: /A server/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Server') as HTMLSelectElement).value).toBe('mars');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mars');
    await h.user.click(screen.getByRole('button', { name: 'Add the room' }));
    await waitFor(() => expect(fake.createRoom).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mars', kind: 'server', host: 'mars' })));
    expect(await screen.findByText('This server already has its own room. Pick another server, or make a project room for it instead.')).toBeTruthy();
  });

  it('a form opened before any host was known takes the first one that arrives, then keeps it', async () => {
    const fake = api();
    const h = await renderPage(<RoomEditor onDone={() => undefined} onCancel={() => undefined} />, {
      api: fake, overview: overview({ servers: [], rooms: [], sessions: [] }),
    });
    expect((screen.getByRole('radio', { name: /A project/ }) as HTMLInputElement).checked).toBe(true);
    act(() => h.ws.emit({ type: 'server.updated', server: MARS }));
    expect((screen.getByLabelText('Server') as HTMLSelectElement).value).toBe('mars');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mars');
    act(() => h.ws.emit({ type: 'rooms.changed', rooms: [roomDto({ id: 'mars', host: 'mars' })], at }));
    act(() => h.ws.emit({ type: 'server.updated', server: server({ name: 'venus' }) }));
    expect((screen.getByLabelText('Server') as HTMLSelectElement).value).toBe('mars');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mars');
  });
});

describe('two editors on one page', () => {
  it('keep their own kind: one editor\'s radios never uncheck the other\'s', async () => {
    const h = await open(<div><RoomEditor onDone={() => undefined} onCancel={() => undefined} /><RoomEditor onDone={() => undefined} onCancel={() => undefined} /></div>);
    const servers = screen.getAllByRole('radio', { name: /A server/ }) as HTMLInputElement[];
    const projects = screen.getAllByRole('radio', { name: /A project/ }) as HTMLInputElement[];
    expect(servers.map((radio) => radio.checked)).toEqual([true, true]);
    await h.user.click(projects[0] as HTMLInputElement);
    expect(projects.map((radio) => radio.checked)).toEqual([true, false]);
    expect(servers.map((radio) => radio.checked)).toEqual([false, true]);
    expect(servers[0]?.name).not.toBe(servers[1]?.name);
  });
});

describe('validation, the colour clamp and warnings', () => {
  it('says what to fix and sends nothing', async () => {
    const h = await open(<RoomEditor onDone={() => undefined} onCancel={() => undefined} />);
    await h.user.clear(screen.getByLabelText('Name'));
    await h.user.click(screen.getByRole('button', { name: 'Add the room' }));
    expect(screen.getByText('Give the room a name.')).toBeTruthy();
    await h.user.type(screen.getByLabelText('Name'), 'harbor');
    expect(screen.getByText('Another room is already called “Harbor”. Pick a different name.')).toBeTruthy();
    expect(h.api.createRoom).not.toHaveBeenCalled();
  });

  it('shows the colour the room will really get, and warns near a reserved or another room\'s colour', async () => {
    const h = await open(<RoomEditor onDone={() => undefined} onCancel={() => undefined} />);
    const custom = screen.getByLabelText('Your own colour, like #3d7bff');
    fireEvent.change(custom, { target: { value: '#000010' } });
    expect(screen.getByText(/made a little lighter or darker/)).toBeTruthy();
    fireEvent.change(custom, { target: { value: '#3cc3b0' } });
    expect(screen.getByText(/It looks like HQ’s teal\./)).toBeTruthy();
    await h.user.click(screen.getByRole('radio', { name: 'Rose' }));
    expect(screen.getByText(/It looks like Orchard’s colour\./)).toBeTruthy();
    fireEvent.change(custom, { target: { value: 'not a colour' } });
    expect(screen.getByText('Type a colour like #3d7bff.')).toBeTruthy();
  });
});

describe('editing, and a stale edit', () => {
  it('a 409 on a stale updatedAt says to load the newest version, which refills the form', async () => {
    const fake = api();
    fake.updateRoom.mockRejectedValueOnce(new ApiError(409, 'room_conflict', 'Harbor was changed elsewhere; load it again'));
    const harbor = classicRoomDtos()[1] as RoomDTO;
    const newer = { ...harbor, name: 'Harbour', updatedAt: '2026-11-21T09:00:00.000Z' };
    fake.rooms.mockResolvedValue({ items: [...classicRoomDtos().filter((room) => room.id !== 'ash'), newer], grid: { slotCount: 4, K: 1, R: 1, capacity: 4 } });
    const h = await open(<RoomEditor room={harbor} onDone={() => undefined} onCancel={() => undefined} />, classicRoomDtos(), fake);
    await h.user.clear(screen.getByLabelText('Name'));
    await h.user.type(screen.getByLabelText('Name'), 'Docks');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(fake.updateRoom).toHaveBeenCalledWith('ash', expect.objectContaining({ name: 'Docks', expectUpdatedAt: harbor.updatedAt }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('This room was changed on another screen.');
    expect(banner.textContent).not.toContain('room_conflict');
    await h.user.click(within(banner).getByRole('button', { name: 'Load the newest version' }));
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Harbour'));
    fake.updateRoom.mockResolvedValueOnce(written(newer));
    await h.user.clear(screen.getByLabelText('Name'));
    await h.user.type(screen.getByLabelText('Name'), 'Docks');
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.updateRoom).toHaveBeenLastCalledWith('ash', expect.objectContaining({ expectUpdatedAt: newer.updatedAt })));
  });

  it('a kept room of a removed server stays editable and says so', async () => {
    const kept = roomDto({ id: 'venus', name: 'Venus', host: 'venus', hostState: 'removed', position: 5 });
    await open(<RoomEditor room={kept} onDone={() => undefined} onCancel={() => undefined} />, [...classicRoomDtos(), kept]);
    expect(screen.getByText(/Its server was removed\. You can still rename this room/)).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('removing a room', () => {
  const project = roomDto({ id: 'web', name: 'Web', kind: 'project', host: 'ash', match: [{ by: 'name', glob: 'web*' }], position: 4 });

  it('moves links and Jira to the server\'s own room by default', async () => {
    const fake = api();
    fake.deleteRoom.mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    const h = await open(<DeleteRoomDialog room={project} onDone={onDone} onCancel={() => undefined} />, [...classicRoomDtos(), project], fake);
    expect((screen.getByLabelText('Move them to') as HTMLSelectElement).value).toBe('ash');
    await h.user.click(screen.getByRole('button', { name: 'Remove the room' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fake.deleteRoom).toHaveBeenCalledWith('web', { links: 'move', jira: 'move', to: 'ash' });
  });

  it('disconnecting Jira asks for the PIN when the hub wants it', async () => {
    const fake = api();
    fake.deleteRoom.mockRejectedValueOnce(new ApiError(428, 'pin_required', 'PIN required')).mockResolvedValueOnce({ ok: true });
    const onDone = vi.fn();
    const h = await open(<DeleteRoomDialog room={project} onDone={onDone} onCancel={() => undefined} />, [...classicRoomDtos(), project], fake);
    await h.user.click(screen.getByRole('radio', { name: 'Delete them' }));
    await h.user.click(screen.getByRole('radio', { name: 'Disconnect it (asks for your PIN)' }));
    await h.user.click(screen.getByRole('button', { name: 'Remove the room' }));
    const pin = await screen.findByLabelText('PIN');
    await h.user.type(pin, '123456');
    await h.user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fake.deleteRoom).toHaveBeenLastCalledWith('web', { links: 'delete', jira: 'disconnect', pin: '123456' });
  });

  it('the shown target stays while the rooms change elsewhere', async () => {
    const fake = api();
    fake.deleteRoom.mockResolvedValue({ ok: true });
    const h = await open(<DeleteRoomDialog room={project} onDone={() => undefined} onCancel={() => undefined} />, [...classicRoomDtos(), project], fake);
    expect((screen.getByLabelText('Move them to') as HTMLSelectElement).value).toBe('ash');
    const without = [...classicRoomDtos().filter((room) => room.id !== 'ash'), roomDto({ id: 'docks', name: 'Docks', host: 'ash', position: 1 }), project];
    act(() => h.ws.emit({ type: 'rooms.changed', rooms: without, at: '2026-11-21T09:00:00.000Z' }));
    // Harbor is gone: the choice is not swapped silently; the owner is asked to pick again, and Remove waits for it.
    expect((screen.getByLabelText('Move them to') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Remove the room' }) as HTMLButtonElement).disabled).toBe(true);
    await h.user.selectOptions(screen.getByLabelText('Move them to'), 'docks');
    await h.user.click(screen.getByRole('button', { name: 'Remove the room' }));
    await waitFor(() => expect(fake.deleteRoom).toHaveBeenCalledWith('web', { links: 'move', jira: 'move', to: 'docks' }));
  });

  it('a Jira board the target already has: plain words, nothing removed', async () => {
    const fake = api();
    fake.deleteRoom.mockRejectedValue(new ApiError(409, 'jira_exists', 'Harbor already has a Jira site'));
    const onDone = vi.fn();
    const h = await open(<DeleteRoomDialog room={project} onDone={onDone} onCancel={() => undefined} />, [...classicRoomDtos(), project], fake);
    await h.user.click(screen.getByRole('button', { name: 'Remove the room' }));
    expect(await screen.findByText('The room you picked already has a Jira board. Pick another room for it, or disconnect this one.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('the rooms list', () => {
  it('makes a room for each server that has none, one after another', async () => {
    const fake = api();
    const h = await open(<RoomsManager />, [classicRoomDtos()[0] as RoomDTO], fake);
    await h.user.click(screen.getByRole('button', { name: 'Create a room for each server' }));
    await waitFor(() => expect(fake.createRoom).toHaveBeenCalledTimes(3));
    expect(fake.createRoom.mock.calls.map(([body]) => [body.name, body.kind, body.host])).toEqual([
      ['Ash', 'server', 'ash'], ['Mars', 'server', 'mars'], ['This computer', 'local', 'computer'],
    ]);
  });

  it('moves a room to a free spot, closes gaps, and says a refusal in words', async () => {
    const fake = api();
    const rooms = [roomDto({ id: 'birch', name: 'Orchard', position: 0 }), roomDto({ id: 'ash', name: 'Harbor', host: 'ash', position: 3 })];
    fake.moveRoom.mockRejectedValueOnce(new ApiError(409, 'position_taken', 'Slot 2 is taken'));
    fake.orderRooms.mockResolvedValue({ items: rooms.map((room, i) => ({ ...room, position: i })), grid: { slotCount: 2, K: 1, R: 1, capacity: 4 } });
    const h = await open(<RoomsManager />, rooms, fake);
    await h.user.click(screen.getByRole('button', { name: 'Move Harbor to another spot' }));
    await h.user.selectOptions(screen.getByLabelText('Move Harbor to'), '2');
    await h.user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(fake.moveRoom).toHaveBeenCalledWith('ash', 2));
    expect(await screen.findByText('That spot on the map was just taken. Pick another free spot, or let the office choose one.')).toBeTruthy();
    await h.user.click(screen.getByRole('button', { name: 'Close gaps' }));
    await waitFor(() => expect(fake.orderRooms).toHaveBeenCalledWith(['birch', 'ash']));
  });

  it('draws only the rows in view above 50 rooms, and the search finds any', async () => {
    const h = await open(<RoomsManager />, manyRooms(120));
    expect(screen.getAllByTestId('room-row').length).toBeLessThan(30);
    await h.user.type(screen.getByLabelText('Find a room'), 'site 117');
    expect(screen.getAllByTestId('room-row').map((row) => row.dataset.room)).toEqual(['site-117']);
  });

  it('a drag onto another row reorders (the hub numbers them 0..n-1)', async () => {
    const fake = api();
    fake.orderRooms.mockResolvedValue({ items: classicRoomDtos(), grid: { slotCount: 4, K: 1, R: 1, capacity: 4 } });
    await open(<RoomsManager />, classicRoomDtos(), fake);
    const rows = await screen.findAllByTestId('room-row');
    const data = { effectAllowed: '', setData: vi.fn() };
    act(() => {
      fireEvent.dragStart(rows[3] as HTMLElement, { dataTransfer: data });
    });
    act(() => {
      fireEvent.dragOver(rows[0] as HTMLElement, { dataTransfer: data });
      fireEvent.drop(rows[0] as HTMLElement, { dataTransfer: data });
    });
    await waitFor(() => expect(fake.orderRooms).toHaveBeenCalledWith(['local', 'birch', 'ash', 'cedar']));
  });
});
