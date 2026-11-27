import type { OverviewDTO } from '@luady/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { ActorMenu } from '../../../../src/features/agency/hud/ActorMenu.js';
import { PAUSE_TOO_OLD } from '../../../../src/features/agency/model/usePause.js';
import type { ActorMenuAt } from '../../../../src/features/agency/model/ui-state.js';
import { LUADY_ACTOR_ID } from '../../../../src/features/agency/stage-types.js';
import { action, activityItem } from '../../../fixtures.js';
import { fakeApi, type FakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { fleet, fleetOverview, snapshotOf } from '../agency-fixtures.js';

async function openMenu(menu: ActorMenuAt, api: FakeApi = fakeApi(), overview: OverviewDTO = fleetOverview()) {
  const onClose = vi.fn();
  const onDetails = vi.fn();
  const onNote = vi.fn();
  const harness = await renderPage(
    <ActorMenu snapshot={snapshotOf()} menu={menu} onClose={onClose} onDetails={onDetails} onNote={onNote} />,
    { api, overview },
  );
  return { ...harness, onClose, onDetails, onNote, menu: screen.getByRole('menu') };
}

const kit2 = (): OverviewDTO => fleetOverview({ servers: fleet().map((s) => ({ ...s, kitVersion: '2.0.0' })) });

/** The menu as the page shows it: it closes (unmounts) when an item is chosen, and can be opened again. */
function Reopenable({ menu }: { menu: ActorMenuAt }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>reopen</button>
      {open ? <ActorMenu snapshot={snapshotOf()} menu={menu} onClose={() => setOpen(false)} onDetails={vi.fn()} onNote={vi.fn()} /> : null}
    </>
  );
}

const itemNames = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.textContent);

describe('ActorMenu', () => {
  it('offers details, stop and terminal for a working agent, and focuses the first item', async () => {
    const { menu } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 });
    expect(menu.getAttribute('aria-label')).toBe('app-backend');
    expect(itemNames(menu)).toEqual(['Details', 'Pause', 'Send a note', 'Stop now', 'Open terminal']);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Details' }));
  });

  it('adds Restart only for an agent that failed', async () => {
    const { menu } = await openMenu({ id: 'cedar:meadow-vat', x: 40, y: 60 });
    expect(itemNames(menu)).toEqual(['Details', 'Pause', 'Send a note', 'Stop now', 'Open terminal', 'Restart']);
  });

  it('stops the session through the PIN flow', async () => {
    const api = fakeApi({ stopSession: async () => action({ kind: 'session.stop', status: 'done', result: 'stopped' }) });
    const { user, onClose } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 }, api);
    await user.click(screen.getByRole('menuitem', { name: 'Stop now' }));
    expect(onClose).toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Stop Orchard · app-backend' });
    expect(api.stopSession).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('PIN'), '246813');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(api.stopSession).toHaveBeenCalledWith('birch:app-backend', { pin: '246813', force: false });
    expect(await screen.findByText('#A7 done: stopped')).toBeTruthy();
  });

  it('restarts through the PIN flow and opens the terminal of the session', async () => {
    const api = fakeApi({ restartSession: async () => action({ kind: 'session.restart', status: 'done', result: 'restarted' }) });
    const { user } = await openMenu({ id: 'cedar:meadow-vat', x: 40, y: 60 }, api);
    await user.click(screen.getByRole('menuitem', { name: 'Restart' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart Meadow · meadow-vat' });
    await user.type(within(dialog).getByLabelText('PIN'), '246813');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(api.restartSession).toHaveBeenCalledWith('cedar:meadow-vat', { pin: '246813' });
  });

  it('opens the terminal page of the session', async () => {
    const { user } = await openMenu({ id: 'cedar:meadow-vat', x: 40, y: 60 });
    await user.click(screen.getByRole('menuitem', { name: 'Open terminal' }));
    expect(screen.getByTestId('location').textContent).toBe('/terminal/cedar?target=meadow-vat%3A0.0');
  });

  it('opens details, and for Luady offers details and the chat', async () => {
    const { user, onDetails } = await openMenu({ id: LUADY_ACTOR_ID, x: 40, y: 60 });
    expect(itemNames(screen.getByRole('menu'))).toEqual(['Details', 'Open chat']);
    await user.click(screen.getByRole('menuitem', { name: 'Details' }));
    expect(onDetails).toHaveBeenCalledWith(LUADY_ACTOR_ID);
  });

  it('closes on Escape, on a press outside, and moves with the arrow keys', async () => {
    const { user, onClose, menu } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 });
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Pause' }));
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Open terminal' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(within(menu).getByRole('menuitem', { name: 'Details' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows nothing for an agent that is no longer on the map', async () => {
    await renderPage(<ActorMenu snapshot={snapshotOf()} menu={{ id: 'gone', x: 0, y: 0 }} onClose={vi.fn()} onDetails={vi.fn()} onNote={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ActorMenu: pause, resume and notes', () => {
  it('offers Pause for a working agent and Resume for a paused one', async () => {
    const { ws, menu } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 }, fakeApi(), kit2());
    expect(within(menu).getByTestId('actor-menu-pause').textContent).toContain('Pause');
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: 'birch:app-backend', paused: true, tool: null })] });
    expect(within(menu).queryByTestId('actor-menu-pause')).toBeNull();
    expect(within(menu).getByTestId('actor-menu-resume').textContent).toContain('Resume');
  });

  it('pauses once and says so', async () => {
    const api = fakeApi({ pauseSession: async () => action({ kind: 'session.pause', tier: 0, status: 'done', result: 'paused' }) });
    const { user, onClose } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 }, api, kit2());
    await user.click(screen.getByTestId('actor-menu-pause'));
    expect(onClose).toHaveBeenCalled();
    expect(api.pauseSession).toHaveBeenCalledTimes(1);
    expect(api.pauseSession).toHaveBeenCalledWith('birch:app-backend');
    expect(await screen.findByText('Paused app-backend.')).toBeTruthy();
  });

  it('resumes and says when nothing needed to be typed (the pause had not stopped it, or it was idle)', async () => {
    const api = fakeApi({
      resumeSession: async () => action({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed; it was idle, nothing was sent' }),
    });
    const { user, ws } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 }, api, kit2());
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: 'birch:app-backend', paused: true, tool: null })] });
    await user.click(screen.getByTestId('actor-menu-resume'));
    expect(api.resumeSession).toHaveBeenCalledWith('birch:app-backend');
    expect(await screen.findByText('Resumed app-backend. Nothing needed to be sent.')).toBeTruthy();
  });

  it.each([
    [{ wasHit: true, sent: true }, 'Resumed app-backend.'],
    [{ wasHit: false, sent: false }, 'Pause lifted. The agent was still working.'],
    [{ wasHit: true, sent: false }, 'Pause lifted. The agent was idle.'],
  ])('says what the resume did from the hub\'s resume field %o', async (resume, words) => {
    const api = fakeApi({
      resumeSession: async () => ({ ...action({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed; it was idle, nothing was sent' }), resume }),
    });
    const { user, ws } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 }, api, kit2());
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: 'birch:app-backend', paused: true, tool: null })] });
    await user.click(screen.getByTestId('actor-menu-resume'));
    expect(await screen.findByText(words)).toBeTruthy();
  });

  it('a kit that is too old: a plain message, the menu closes, and Pause is gone for that server', async () => {
    const api = fakeApi({ pauseSession: async () => { throw new ApiError(409, 'kit_too_old', 'birch kit is older than 2.0.0'); } });
    const { user } = await renderPage(<Reopenable menu={{ id: 'birch:app-backend', x: 40, y: 60 }} />, { api, overview: kit2() });
    await user.click(screen.getByTestId('actor-menu-pause'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(await screen.findByText(PAUSE_TOO_OLD)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'reopen' }));
    expect(screen.queryByTestId('actor-menu-pause')).toBeNull();
    expect(screen.getByTestId('actor-menu-note')).toBeTruthy();
  });

  it('on a kit-1 server Pause is disabled and says why', async () => {
    const { user, api, menu } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 });
    const item = within(menu).getByTestId('actor-menu-pause');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(item.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Update the kit on birch to pause.');
    await user.click(item);
    expect(api.pauseSession).not.toHaveBeenCalled();
  });

  it('Send a note hands the menu point to the page', async () => {
    const { user, onNote, onClose } = await openMenu({ id: 'birch:app-backend', x: 40, y: 60 }, fakeApi(), kit2());
    await user.click(screen.getByTestId('actor-menu-note'));
    expect(onClose).toHaveBeenCalled();
    expect(onNote).toHaveBeenCalledWith({ id: 'birch:app-backend', x: 40, y: 60 });
  });
});
