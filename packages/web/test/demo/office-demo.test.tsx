import type { WsServerMessage } from '@luady/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeDemo } from '../../demo/office/app.js';
import { createFakeHub, type FakeHub } from '../../demo/office/fake-hub.js';
import { resetStageSpy, stageProps } from '../features/agency/stage-mock.js';

vi.mock('../../src/features/agency/scene/AgencyStage.js', () => import('../features/agency/stage-mock.js'));

// These tests render the whole office page and drive it by hand: on a busy machine one of them can take longer than
// the default five seconds.
vi.setConfig({ testTimeout: 20_000 });

/**
 * The static office demo (demo/office.html, the project's live demo): the real office page against the pretend hub.
 * Every answer the hub gives is recorded, so a test sees each request that fell through to a 404.
 */
function openDemo() {
  const hub = createFakeHub(false, { latencyMs: 0 });
  const misses: string[] = [];
  const pushed: WsServerMessage[] = [];
  hub.onPush((message) => pushed.push(message));
  const watched: FakeHub = {
    ...hub,
    fetch: async (input, init) => {
      const res = await hub.fetch(input, init);
      if (res.status === 404) misses.push(`${init.method ?? 'GET'} ${new URL(input, window.location.origin).pathname}`);
      return res;
    },
  };
  const user = userEvent.setup();
  render(<OfficeDemo hub={watched} params={new URLSearchParams('script=0')} />);
  return { misses, pushed, user };
}

/** Lets every pending answer of the pretend hub land. */
const settle = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  resetStageSpy();
});

describe("the office demo's owner", () => {
  it("is the visitor: the pretend hub's settings report this browser's own zone", async () => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/Chicago' });
    const res = await createFakeHub(false, { latencyMs: 0 }).fetch('/api/settings', { method: 'GET' });
    expect(((await res.json()) as { owner_tz: string | null }).owner_tz).toBe('America/Chicago');
  });
});

describe('the office demo', () => {
  it('opens on the classic four rooms around HQ, and every request of the page has an answer', async () => {
    const { misses, user } = openDemo();
    await screen.findByTestId('agency-stage');
    await waitFor(() => expect(screen.getByTestId('rooms-menu-button').textContent).toBe('Rooms 4'));
    expect(stageProps().rooms?.map((room) => [room.id, room.position, room.name, room.kind])).toEqual([
      ['birch', 0, 'Orchard', 'server'], ['ash', 1, 'Harbor', 'server'], ['cedar', 2, 'Meadow', 'server'], ['local', 3, 'Private Projects', 'server'],
    ]);
    await user.click(screen.getByTestId('rooms-menu-button'));
    const names = within(screen.getByTestId('rooms-menu')).getAllByRole('option').map((row) => row.querySelector('b')?.textContent);
    expect(names).toEqual(expect.arrayContaining(['Orchard', 'Harbor', 'Meadow', 'Private Projects']));
    await settle();
    expect(misses).toEqual([]);
  });

  it('makes no request outside the pretend hub: the browser fetch is never used', async () => {
    const browser = vi.fn(async () => Promise.reject(new Error('the demo tried the network')));
    vi.stubGlobal('fetch', browser);
    const { misses, user } = openDemo();
    await waitFor(() => expect(screen.getByTestId('rooms-menu-button').textContent).toBe('Rooms 4'));
    await user.click(screen.getByTestId('rooms-menu-button'));
    await user.click(screen.getByRole('button', { name: 'Manage rooms' }));
    await screen.findByTestId('rooms-manager');
    await settle();
    expect(browser).not.toHaveBeenCalled();
    expect(misses).toEqual([]);
  });

  it('adds a room: the pretend hub keeps it, pushes rooms.changed, and the office shows five', async () => {
    const { misses, pushed, user } = openDemo();
    await waitFor(() => expect(screen.getByTestId('rooms-menu-button').textContent).toBe('Rooms 4'));
    await user.click(screen.getByTestId('rooms-menu-button'));
    await user.click(screen.getByRole('button', { name: '+ Add a room' }));
    const editor = await screen.findByTestId('room-editor');
    await user.type(within(editor).getByLabelText('Name'), 'Garden');
    await user.click(within(editor).getByRole('button', { name: 'Add a project' }));
    await user.type(within(editor).getByLabelText('Project name 1'), 'garden*');
    await user.click(within(editor).getByRole('button', { name: 'Add the room' }));
    await waitFor(() => expect(screen.getByTestId('rooms-menu-button').textContent).toBe('Rooms 5'));
    expect(screen.queryByText(/This room is gone/)).toBeNull();
    const garden = stageProps().rooms?.find((room) => room.name === 'Garden');
    expect(garden).toMatchObject({ id: 'garden', kind: 'project', position: 4, match: [{ by: 'name', glob: 'garden*' }] });
    const changed = pushed.filter((message) => message.type === 'rooms.changed');
    expect(changed.at(-1)).toMatchObject({ type: 'rooms.changed', rooms: expect.arrayContaining([expect.objectContaining({ id: 'garden' })]) });
    await settle();
    expect(misses).toEqual([]);
  });
});
