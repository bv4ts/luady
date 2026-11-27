import { TILE } from '@luady/office';
import type { OverviewDTO } from '@luady/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../../src/features/agency/AgencyPage.js';
import { luadyStatus, overview, server } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { classicRoomDtos, manyRooms } from '../../../room-fixtures.js';
import { fleetOverview } from '../agency-fixtures.js';
import { resetStageSpy, stageProps } from '../stage-mock.js';
import { plateList } from '../../../../src/features/agency/hud/plate-list.js';
import { luadyWords } from '../../../../src/features/agency/model/words.js';
import { LUADY_ACTOR_ID } from '../../../../src/features/agency/stage-types.js';

vi.mock('../../../../src/features/agency/scene/AgencyStage.js', () => import('../stage-mock.js'));
vi.mock('../../../../src/features/rooms/creature-preview.js', () => ({ CREATURE_PX: 24, drawCreature: vi.fn(async () => false) }));

const pageApi = () => fakeApi({
  luadyMessages: async () => ({ items: [], nextCursor: null }),
  transcript: async () => ({ items: [], nextCursor: null }),
});

async function openOffice(over: OverviewDTO) {
  const harness = await renderPage(<AgencyPage />, { api: pageApi(), overview: over });
  await screen.findByTestId('agency-stage');
  return harness;
}

/** A view of one room of the stage's snapshot (its rectangle, in map pixels). */
function viewOf(room: string, far = false) {
  const r = stageProps().snapshot.map.rooms[room]?.rect;
  if (r === undefined) throw new Error(`no room ${room}`);
  return { rect: { x: r.x * TILE + 8, y: r.y * TILE + 8, w: 96, h: 96 }, scale: 1, far };
}

beforeEach(() => resetStageSpy());

describe('labels follow the view', () => {
  it('the stage gets the rooms and reports its view; plaques are drawn only for rooms meeting it', async () => {
    await openOffice(overview({ servers: manyRooms(24).map((room) => server({ name: room.host ?? '' })), rooms: manyRooms(24) }));
    expect(stageProps().rooms?.map((room) => room.id)).toHaveLength(24);
    expect(screen.getAllByTestId('room-plaque').length).toBeGreaterThan(20);
    act(() => stageProps().onView?.(viewOf('site-7')));
    await waitFor(() => expect(screen.getAllByTestId('room-plaque').map((node) => node.dataset.room)).toEqual(['site-7']));
  });

  it('in far mode each room in reach gets a badge (colour, name, agents, needs you), and no plaque', async () => {
    await openOffice(fleetOverview());
    const map = stageProps().snapshot.map;
    act(() => stageProps().onView?.({ rect: { x: 0, y: 0, w: map.width, h: map.height }, scale: 0.3, far: true }));
    const badges = await screen.findAllByTestId('room-badge');
    expect(badges.map((badge) => badge.dataset.room)).toEqual(['birch', 'ash', 'hq', 'cedar', 'local']);
    expect(screen.queryAllByTestId('room-plaque')).toHaveLength(0);
    const harbor = badges.find((badge) => badge.dataset.room === 'ash');
    expect(harbor?.getAttribute('title')).toBe('Harbor, 1 agent, 1 needs you');
    // In far mode the scene draws no characters: no name plates either.
    expect(document.querySelectorAll('.agency-plate')).toHaveLength(0);
  });

  it('name plates appear only for agents in rooms the view shows', async () => {
    await openOffice(fleetOverview());
    const plates = () => [...document.querySelectorAll<HTMLElement>('.agency-plate')].map((node) => node.dataset.plate);
    // Harbor's agent needs the owner, so it has a plate while Harbor is in view.
    expect(plates()).toContain('agent');
    act(() => stageProps().onView?.(viewOf('birch')));
    await waitFor(() => expect(plates()).toEqual([]));
    act(() => stageProps().onView?.(viewOf('ash')));
    await waitFor(() => expect(plates()).toEqual(['agent']));
  });

  it('an empty slot in view has a "+ Add room" plaque that opens a new room for that spot', async () => {
    const h = await openOffice(fleetOverview({ rooms: classicRoomDtos().filter((room) => room.id !== 'cedar') }));
    const map = stageProps().snapshot.map;
    act(() => stageProps().onView?.({ rect: { x: 0, y: 0, w: map.width, h: map.height }, scale: 1, far: false }));
    // The plaque shows once the stage says where the slot is.
    act(() => stageProps().onFrame([{ kind: 'room', id: 'lot-2', x: 40, y: 300, footY: 300, maxWidth: 380, visible: true, scale: 1 }]));
    const plaque = await screen.findByRole('button', { name: 'Add a room in spot 3' });
    await h.user.click(plaque);
    const dialog = await screen.findByRole('dialog', { name: 'Rooms' });
    expect(await within(dialog).findByTestId('room-editor')).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByLabelText('Server') as HTMLSelectElement).value).toBe('cedar'));
  });
});

describe('the empty office and the manager switched off', () => {
  it('HQ\'s panel offers a room for each server when there are none', async () => {
    const h = await openOffice(fleetOverview({ rooms: [], sessions: [] }));
    act(() => stageProps().onEvent({ type: 'room', room: 'hq' }));
    const empty = await screen.findByTestId('office-empty');
    expect(empty.textContent).toContain('Your office is empty.');
    h.api.createRoom.mockImplementation(async (body) => ({
      room: { ...classicRoomDtos()[0]!, id: body.host ?? 'x', name: body.name, host: body.host ?? null }, adjusted: { colour: false, accent: false }, warnings: [],
    }));
    await h.user.click(within(empty).getByRole('button', { name: 'Create a room for each server' }));
    await waitFor(() => expect(h.api.createRoom).toHaveBeenCalledTimes(4));
    expect(h.api.createRoom.mock.calls.map(([body]) => body.host)).toEqual(['birch', 'ash', 'cedar', 'local']);
  });

  it('a switched-off manager is a calm state: HQ says so and links to the switch', async () => {
    await openOffice(fleetOverview({ manager: luadyStatus({ state: 'off' }) }));
    act(() => stageProps().onEvent({ type: 'room', room: 'hq' }));
    const hint = await screen.findByTestId('manager-off-hint');
    expect(hint.textContent).toContain('The manager is switched off');
    expect(within(hint).getByRole('link', { name: 'Turn it on in Settings' }).getAttribute('href')).toBe('/settings');
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  it('the stage gets the manager as off (not down): his plate says switched off, never offline', async () => {
    await openOffice(fleetOverview({ manager: luadyStatus({ state: 'off' }) }));
    await waitFor(() => expect(stageProps().snapshot.luady.state).toBe('off'));
    expect(plateList(stageProps().snapshot, { kind: 'all' }, null).find((p) => p.id === LUADY_ACTOR_ID)?.words).toBe('switched off');
    expect(luadyWords('down')).toBe('offline');
  });
});
