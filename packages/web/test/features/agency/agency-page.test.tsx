import type { OverviewDTO } from '@luady/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import { LUADY_ACTOR_ID, type StageEvent } from '../../../src/features/agency/stage-types.js';
import { channelInfo } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { agent, askOf, fleetOverview } from './agency-fixtures.js';
import { resetStageSpy, stageProps, stageSpy } from './stage-mock.js';

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('./stage-mock.js'));

const original = { width: window.innerWidth, height: window.innerHeight, matchMedia: window.matchMedia };

function setViewport(width: number, height: number) {
  window.innerWidth = width;
  window.innerHeight = height;
}

const pageApi = () => fakeApi({
  luadyMessages: async () => ({ items: [], nextCursor: null }),
  transcript: async () => ({ items: [], nextCursor: null }),
});

async function openOffice(overview: OverviewDTO = fleetOverview()) {
  const harness = await renderPage(<AgencyPage />, { api: pageApi(), overview });
  await screen.findByTestId('agency-stage');
  return harness;
}

const fire = (event: StageEvent) => act(() => stageProps().onEvent(event));

beforeEach(() => {
  resetStageSpy();
  setViewport(1280, 800);
});

afterEach(() => {
  setViewport(original.width, original.height);
  window.matchMedia = original.matchMedia;
});

describe('AgencyPage: stage wiring', () => {
  it('feeds the stage the whole office, the free area and stable callbacks', async () => {
    await openOffice();
    const props = stageProps();
    expect(props.focus).toEqual({ kind: 'all' });
    expect(props.selectedId).toBeNull();
    expect(props.insets).toEqual({ top: 56, right: 0, bottom: 64, left: 0 });
    expect(props.reducedMotion).toBe(false);
    expect(Object.keys(props.snapshot.actors)).toHaveLength(5);
  });

  it('tells the stage each fresh load of the overview, so it seats instead of walking everyone in', async () => {
    const { ws } = await openOffice();
    const before = stageProps().settleKey;
    expect(before).toBeGreaterThan(0);
    ws.setStatus('open', 1);
    ws.setStatus('reconnecting', 1);
    ws.setStatus('open', 2);
    await waitFor(() => expect(stageProps().settleKey).toBe(before + 1));
  });

  it('selecting an agent opens its panel and gives the stage the selection and the dock inset', async () => {
    await openOffice();
    fire({ type: 'actor', id: 'birch:app-backend' });
    const panel = screen.getByRole('dialog', { name: 'app-backend' });
    expect(panel.className).toContain('agency-panel--dock');
    expect(within(panel).getByRole('toolbar', { name: 'Session controls' })).toBeTruthy();
    expect(stageProps().selectedId).toBe('birch:app-backend');
    expect(stageProps().focus).toEqual({ kind: 'actor', id: 'birch:app-backend' });
    expect(stageProps().insets).toEqual({ top: 56, right: 360, bottom: 64, left: 0 });
  });

  it('opens the room, rack and Luady panels from stage taps, and a tap outside closes them', async () => {
    await openOffice();
    fire({ type: 'room', room: 'cedar' });
    expect(screen.getByRole('dialog', { name: 'Meadow room' })).toBeTruthy();
    fire({ type: 'fixture', fixture: 'rack', id: 'rack-cedar', room: 'cedar' });
    expect(screen.getByRole('dialog', { name: 'Server cedar' })).toBeTruthy();
    fire({ type: 'actor', id: LUADY_ACTOR_ID });
    expect(screen.getByRole('dialog', { name: 'Luady' })).toBeTruthy();
    fire({ type: 'room', room: null });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stageProps().focus).toEqual({ kind: 'all' });
  });

  it('does not re-render the stage for unrelated store updates or hover', async () => {
    const { ws } = await openOffice();
    const renders = stageSpy.renders;
    const { insets, onEvent, onFrame, onFailed, snapshot } = stageProps();
    ws.emit({ type: 'channel.status', channel: channelInfo({ state: 'starting' }) });
    ws.setStatus('open', 1);
    fire({ type: 'hover', id: 'ash:harbor-web', fixture: null, x: 200, y: 120 });
    expect(screen.getByRole('tooltip').textContent).toContain('harbor-web');
    expect(stageSpy.renders).toBe(renders);
    expect(stageProps().insets).toBe(insets);
    expect(stageProps().snapshot).toBe(snapshot);
    expect([stageProps().onEvent, stageProps().onFrame, stageProps().onFailed]).toEqual([onEvent, onFrame, onFailed]);
  });

  it('moves name plates from onFrame without re-rendering', async () => {
    await openOffice();
    const renders = stageSpy.renders;
    act(() => stageProps().onFrame([{ kind: 'actor', id: 'ash:harbor-web', x: 300, y: 100, footY: 140, maxWidth: 120, visible: true, scale: 2 }]));
    const plate = screen.getByRole('button', { name: 'harbor-web, waiting for you' });
    expect(plate.style.transform).toMatch(/^translate3d\(300px, 140px/);
    expect(screen.queryByRole('button', { name: 'app-backend, working' })).toBeNull();
    expect(stageSpy.renders).toBe(renders);
  });

  it('respects reduced motion', async () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    await openOffice();
    expect(stageProps().reducedMotion).toBe(true);
  });

  it('opens the menu from a right-click and shows details from it', async () => {
    const { user } = await openOffice();
    fire({ type: 'menu', id: 'cedar:meadow-vat', x: 300, y: 200 });
    const menu = screen.getByRole('menu', { name: 'meadow-vat' });
    expect(stageProps().selectedId).toBe('cedar:meadow-vat');
    await user.click(within(menu).getByRole('menuitem', { name: 'Details' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'meadow-vat' })).toBeTruthy();
  });
});

describe('AgencyPage: the owner’s flow', () => {
  it('the bell cycles through three waiting agents', async () => {
    const sessions = ['one', 'two', 'three'].map((name) => agent('ash', name, { state: 'waiting_question', pendingQid: `QBELL${name.toUpperCase().padEnd(3, 'X')}` }));
    const questions = sessions.map((s, i) => askOf(s.id, s.pendingQid ?? '', i));
    const { user } = await openOffice(fleetOverview({ sessions, questions }));
    const bell = screen.getByRole('button', { name: '3 need you' });
    const seen: Array<string | null> = [];
    for (let i = 0; i < 4; i += 1) {
      await user.click(bell);
      seen.push(stageProps().selectedId);
    }
    expect(seen).toEqual(['ash:one', 'ash:two', 'ash:three', 'ash:one']);
    expect(screen.getByRole('dialog', { name: 'one' })).toBeTruthy();
  });

  it('ending the selected session closes its panel', async () => {
    const { ws } = await openOffice();
    fire({ type: 'actor', id: 'birch:app-backend' });
    expect(screen.getByRole('dialog', { name: 'app-backend' })).toBeTruthy();
    ws.emit({ type: 'session.updated', session: agent('birch', 'app-backend', { state: 'ended' }) });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stageProps().selectedId).toBeNull();
    expect(stageProps().focus).toEqual({ kind: 'all' });
  });

  it('keyboard: 1-5 jump to rooms, 0 shows everything, Esc closes, / goes to the chat', async () => {
    const { user } = await openOffice();
    await user.keyboard('2');
    expect(stageProps().focus).toEqual({ kind: 'room', room: 'ash' });
    expect(screen.getByRole('dialog', { name: 'Harbor room' })).toBeTruthy();
    await user.keyboard('4');
    expect(stageProps().focus).toEqual({ kind: 'room', room: 'cedar' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stageProps().focus).toEqual({ kind: 'room', room: 'cedar' });
    await user.keyboard('{Escape}');
    expect(stageProps().focus).toEqual({ kind: 'all' });
    await user.keyboard('3');
    expect(stageProps().focus).toEqual({ kind: 'room', room: 'hq' });
    await user.keyboard('0');
    expect(stageProps().focus).toEqual({ kind: 'all' });
    await user.keyboard('/');
    const input = screen.getByRole('textbox', { name: 'Message to Luady' }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('');
    await user.keyboard('1');
    expect(input.value).toBe('1');
    expect(stageProps().focus).toEqual({ kind: 'all' });
  });
});

describe('AgencyPage: a failed stage and the phone layout', () => {
  it('when the stage cannot start, the owner lands on the classic Inbox with the reason', async () => {
    await openOffice();
    act(() => stageProps().onFailed('webgl-unavailable'));
    expect(screen.getByTestId('location').textContent).toBe('/inbox');
  });

  it('on a phone the sheet keeps the agent in view and a press on the sheet never reaches the map', async () => {
    setViewport(390, 844);
    await openOffice();
    fire({ type: 'actor', id: 'cedar:meadow-vat' });
    const sheet = screen.getByRole('dialog', { name: 'meadow-vat' });
    expect(sheet.className).toContain('agency-panel--sheet');
    expect(stageProps().insets).toEqual({ top: 100, right: 0, bottom: 473, left: 0 });
    expect(stageProps().focus).toEqual({ kind: 'actor', id: 'cedar:meadow-vat' });

    const stage = screen.getByTestId('agency-stage');
    expect(stage.contains(sheet)).toBe(false);
    const behind = vi.fn();
    document.addEventListener('pointerdown', behind);
    try {
      const target = within(sheet).getByRole('heading', { name: 'meadow-vat' });
      fireEvent.pointerDown(target);
      fireEvent.pointerUp(target);
      fireEvent.click(target);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('pointerdown', behind);
    }
    expect(screen.getByRole('dialog', { name: 'meadow-vat' })).toBeTruthy();
    expect(stageProps().selectedId).toBe('cedar:meadow-vat');

    fireEvent.pointerDown(stage);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AgencyPage: notes and pause', () => {
  it('Send a note opens the box at the menu point; the agent ending closes it and nothing stays selected', async () => {
    const { user, ws } = await openOffice();
    fire({ type: 'menu', id: 'birch:app-backend', x: 300, y: 200 });
    await user.click(screen.getByTestId('actor-menu-note'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Note to app-backend' })).toBeTruthy();
    ws.emit({ type: 'session.updated', session: agent('birch', 'app-backend', { state: 'ended' }) });
    expect(screen.queryByRole('dialog', { name: 'Note to app-backend' })).toBeNull();
    expect(stageProps().selectedId).toBeNull();
  });

  it('a session that ends while its menu is open closes the menu', async () => {
    const { ws } = await openOffice();
    fire({ type: 'menu', id: 'birch:app-backend', x: 300, y: 200 });
    expect(screen.getByRole('menu', { name: 'app-backend' })).toBeTruthy();
    ws.emit({ type: 'session.updated', session: agent('birch', 'app-backend', { state: 'ended' }) });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(stageProps().selectedId).toBeNull();
  });
});
