import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiveProvider, useGive, useOfficeNav } from '../../../../src/features/agency/give/GiveContext.js';
import { DRAGGING_ATTR } from '../../../../src/features/agency/give/useDrag.js';
import type { StageHandle, StageTarget } from '../../../../src/features/agency/stage-types.js';
import { overview, server, session } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { classicRoomDtos } from '../../../room-fixtures.js';

const WHAT = [{ kind: 'todo' as const, id: 12 }, { kind: 'todo' as const, id: 15 }];
const AGENT = session({ id: 'birch:web:0.0', host: 'birch', displayName: 'web', state: 'working' });

/** A pointer event jsdom can carry (it has no PointerEvent constructor everywhere). */
function pointer(type: string, x: number, y: number, pointerId = 1): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  return event;
}

function Giver() {
  const { startDrag, openPicker, dragging } = useGive();
  const nav = useOfficeNav();
  return (
    <div>
      <button type="button" onPointerDown={(event) => startDrag(WHAT, '2 cards', event)}>handle</button>
      <button type="button" onClick={() => openPicker(WHAT, '2 cards')}>Give to…</button>
      <button type="button" onClick={() => nav?.openAgent('birch:web:0.0')}>agent</button>
      <output data-testid="dragging">{dragging ? 'yes' : 'no'}</output>
    </div>
  );
}

function fakeStage(under: (x: number, y: number) => StageTarget | null) {
  return { pick: vi.fn(under), setDropHint: vi.fn<StageHandle['setDropHint']>() };
}

async function setup(stage: StageHandle | null, dispatch = vi.fn()) {
  const api = fakeApi({
    activity: async () => ({ items: [] }), notices: async () => ({ items: [] }), presence: async () => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }),
    board: async () => ({ items: [] }), missions: async () => ({ items: [] }), said: async () => ({ items: [] }),
    delegate: async () => ({ runId: 'r1', items: [], manager: 'sent' }),
  });
  const page = await renderPage(<GiveProvider stage={stage} dispatch={dispatch}><Giver /></GiveProvider>, {
    api, overview: overview({ rooms: classicRoomDtos(), servers: [server({ name: 'cedar' }), server({ name: 'birch' })], sessions: [AGENT] }),
  });
  return { ...page, dispatch };
}

const drag = async (path: ReadonlyArray<readonly [number, number]>) => {
  act(() => {
    fireEvent(screen.getByRole('button', { name: 'handle' }), pointer('pointerdown', 10, 10));
  });
  for (const [x, y] of path) act(() => { window.dispatchEvent(pointer('pointermove', x, y)); });
};

afterEach(() => {
  document.documentElement.removeAttribute(DRAGGING_ATTR);
});

describe('dragging work onto the map', () => {
  it('lights the target under the pointer and drops on a character: that session gets the work', async () => {
    const stage = fakeStage((x) => (x > 200 ? { kind: 'actor', id: 'birch:web:0.0' } : null));
    const { api } = await setup(stage);
    await drag([[12, 11], [80, 80]]);
    expect(stage.pick).toHaveBeenCalledWith(80, 80);
    expect(screen.getByTestId('dragging').textContent).toBe('yes');
    expect(document.documentElement.hasAttribute(DRAGGING_ATTR)).toBe(true);
    expect(screen.getByTestId('give-chip').textContent).toContain('Drop on a character or a room');
    // Near the window's top-left corner the chip has no room above-left: it flips (the pointer stays uncovered).
    expect(screen.getByTestId('give-chip').getAttribute('data-side')).toBe('right below');
    await drag([]);
    act(() => { window.dispatchEvent(pointer('pointermove', 300, 90)); });
    expect(stage.setDropHint).toHaveBeenLastCalledWith({ kind: 'actor', id: 'birch:web:0.0' });
    expect(screen.getByTestId('give-chip').textContent).toContain('Drop to give it to web');
    act(() => { window.dispatchEvent(pointer('pointerup', 300, 90)); });
    expect(stage.setDropHint).toHaveBeenLastCalledWith(null);
    expect(api.delegate).toHaveBeenCalledWith({ what: WHAT, to: { kind: 'session', id: 'birch:web:0.0' } });
    expect(await screen.findByText('Luady is on it: 2 cards to web.')).toBeTruthy();
    expect(screen.getByTestId('dragging').textContent).toBe('no');
    expect(document.documentElement.hasAttribute(DRAGGING_ATTR)).toBe(false);
  });

  it('drops on a room: a new session in that office', async () => {
    const stage = fakeStage(() => ({ kind: 'room', room: 'cedar' }));
    const { api } = await setup(stage);
    await drag([[60, 60]]);
    expect(stage.setDropHint).toHaveBeenLastCalledWith({ kind: 'room', room: 'cedar' });
    act(() => { window.dispatchEvent(pointer('pointerup', 60, 60)); });
    expect(api.delegate).toHaveBeenCalledWith({ what: WHAT, to: { kind: 'server', server: 'cedar' } });
    expect(await screen.findByText('Luady is on it: 2 cards to Meadow.')).toBeTruthy();
  });

  it('drops on nothing: nothing is sent and the pop-up comes back', async () => {
    const stage = fakeStage(() => null);
    const { api } = await setup(stage);
    await drag([[60, 60]]);
    act(() => { window.dispatchEvent(pointer('pointerup', 60, 60)); });
    expect(api.delegate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('give-chip')).toBeNull();
  });

  it('Esc cancels a drag without sending, and the Esc does not reach anything else', async () => {
    const stage = fakeStage(() => ({ kind: 'room', room: 'birch' }));
    const { api } = await setup(stage);
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    await drag([[60, 60]]);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    window.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByTestId('dragging').textContent).toBe('no');
    act(() => { window.dispatchEvent(pointer('pointerup', 60, 60)); });
    expect(api.delegate).not.toHaveBeenCalled();
    expect(stage.setDropHint).toHaveBeenLastCalledWith(null);
  });

  it('a press without a move is a tap; another pointer is ignored; no stage means nothing lights', async () => {
    const { api } = await setup(null);
    act(() => { fireEvent(screen.getByRole('button', { name: 'handle' }), pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 80, 80, 2)); });
    expect(screen.getByTestId('dragging').textContent).toBe('no');
    act(() => { window.dispatchEvent(pointer('pointerup', 10, 10)); });
    expect(api.delegate).not.toHaveBeenCalled();
    await drag([[90, 90]]);
    expect(screen.getByTestId('dragging').textContent).toBe('yes');
    act(() => { window.dispatchEvent(pointer('pointercancel', 90, 90)); });
    expect(screen.getByTestId('dragging').textContent).toBe('no');
  });
});

describe('the Give to… picker', () => {
  it('lists the targets and sends to the one pressed, with the optional note', async () => {
    const { api, user } = await setup(null);
    await user.click(screen.getByRole('button', { name: 'Give to…' }));
    const picker = screen.getByRole('dialog', { name: 'Give 2 cards to…' });
    expect(within(picker).getByRole('button', { name: /Let Luady decide/ })).toBeTruthy();
    expect(within(picker).getByRole('button', { name: /A new session in Meadow/ })).toBeTruthy();
    expect(within(picker).getByRole('button', { name: /^web\s*working/ })).toBeTruthy();
    await user.type(within(picker).getByLabelText('Note for Luady (optional)'), 'Coupons first');
    await user.click(within(picker).getByRole('button', { name: /A new session in Orchard/ }));
    expect(api.delegate).toHaveBeenCalledWith({ what: WHAT, to: { kind: 'server', server: 'birch' }, note: 'Coupons first' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Give 2 cards to…' })).toBeNull());
    expect(await screen.findByText('Luady is on it: 2 cards to Orchard.')).toBeTruthy();
  });

  it('Let Luady decide sends target auto; Esc and Cancel close without sending; a failure keeps it open', async () => {
    const { api, user } = await setup(null);
    await user.click(screen.getByRole('button', { name: 'Give to…' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('give-picker')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Give to…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.delegate).not.toHaveBeenCalled();
    api.delegate.mockRejectedValueOnce(new Error('boom'));
    await user.click(screen.getByRole('button', { name: 'Give to…' }));
    await user.click(screen.getByRole('button', { name: /Let Luady decide/ }));
    expect(api.delegate).toHaveBeenLastCalledWith({ what: WHAT, to: { kind: 'auto' } });
    expect(screen.getByTestId('give-picker')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Let Luady decide/ }));
    await waitFor(() => expect(screen.queryByTestId('give-picker')).toBeNull());
  });

  it('opens the agent view through the page', async () => {
    const { dispatch, user } = await setup(null);
    await user.click(screen.getByRole('button', { name: 'agent' }));
    expect(dispatch.mock.calls).toEqual([[{ type: 'modal.close' }], [{ type: 'select', id: 'birch:web:0.0' }]]);
  });
});
