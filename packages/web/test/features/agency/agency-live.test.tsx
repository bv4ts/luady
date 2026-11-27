import type { AccountsDTO } from '@luady/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import type { StageEvent } from '../../../src/features/agency/stage-types.js';
import { account, accountHost, accounts, notice, presence } from '../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { fleet, fleetOverview } from './agency-fixtures.js';
import { resetStageSpy, stageProps } from './stage-mock.js';

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('./stage-mock.js'));

const original = { width: window.innerWidth, height: window.innerHeight };
const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function setViewport(width: number, height: number) {
  window.innerWidth = width;
  window.innerHeight = height;
}

const liveAccounts = (): AccountsDTO => accounts({
  accounts: [account({
    hosts: [accountHost({ host: 'cedar' })],
    limits: { reported: 'yes', fiveHour: { usedPct: 96, resetsAt: soon(1) }, sevenDay: { usedPct: 40, resetsAt: soon(50) }, updatedAt: soon(0) },
  })],
});

function liveApi(over: FakeApiOverrides = {}) {
  return fakeApi({
    luadyMessages: async () => ({ items: [], nextCursor: null }),
    transcript: async () => ({ items: [], nextCursor: null }),
    activity: async () => ({ items: [] }),
    notices: async () => ({ items: [notice({ id: 'old', text: 'Earlier today' })] }),
    presence: async () => presence(),
    accounts: async () => liveAccounts(),
    sessionActivity: async () => { throw new ApiError(404, 'not_found', 'not found'); },
    ...over,
  });
}

async function openOffice(api = liveApi()) {
  const kit2 = fleet().map((s) => ({ ...s, kitVersion: '2.0.0' }));
  const harness = await renderPage(<AgencyPage />, { api, overview: fleetOverview({ servers: kit2 }) });
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
});

describe('AgencyPage with live activity data', () => {
  it.each([[1280, 800], [390, 844]])('the top bar carries the bell, notices, energy bar and pill together at %i px', async (width, height) => {
    setViewport(width, height);
    await openOffice();
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('button', { name: '1 needs you' })).toBeTruthy();
    expect(within(bar).getByTestId('notices-button')).toBeTruthy();
    expect(within(bar).getByTestId('energy-bar').textContent).toContain('96%');
    expect(within(bar).getByTestId('updates-pill').textContent).toBe('Updates: here');
    expect(bar.className).toBe('agency-top');
  });

  it('opening the accounts drawer from the energy bar gives the stage the dock inset; Esc goes back to the panel under it', async () => {
    const { user } = await openOffice();
    fire({ type: 'actor', id: 'birch:app-backend' });
    expect(stageProps().insets.right).toBe(360);
    await user.click(screen.getByTestId('energy-bar'));
    expect(screen.getByRole('dialog', { name: 'Accounts and limits' })).toBeTruthy();
    expect(stageProps().insets).toEqual({ top: 56, right: 360, bottom: 64, left: 0 });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'app-backend' })).toBeTruthy();
    expect(stageProps().selectedId).toBe('birch:app-backend');
  });

  it('Esc closes the note box, then the drawer, then the panel', async () => {
    const { user } = await openOffice();
    fire({ type: 'actor', id: 'birch:app-backend' });
    await user.click(screen.getByTestId('notices-button'));
    expect(screen.getByRole('dialog', { name: 'Notices' })).toBeTruthy();
    fire({ type: 'menu', id: 'birch:app-backend', x: 200, y: 200 });
    await user.click(screen.getByTestId('actor-menu-note'));
    expect(screen.getByRole('dialog', { name: 'Note to app-backend' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Note to app-backend' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Notices' })).toBeTruthy();
    act(() => {
      document.body.focus();
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Notices' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'app-backend' })).toBeTruthy();
    act(() => {
      document.body.focus();
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a press on an open drawer never reaches the map', async () => {
    const { user } = await openOffice();
    await user.click(screen.getByTestId('notices-button'));
    const drawer = screen.getByRole('dialog', { name: 'Notices' });
    expect(screen.getByTestId('agency-stage').contains(drawer)).toBe(false);
    const behind = vi.fn();
    document.addEventListener('pointerdown', behind);
    try {
      fireEvent.pointerDown(within(drawer).getByTestId('notices-list'));
      fireEvent.click(within(drawer).getByTestId('notices-list'));
    } finally {
      document.removeEventListener('pointerdown', behind);
    }
    expect(behind).not.toHaveBeenCalled();
    expect(stageProps().focus).toEqual({ kind: 'all' });
    expect(screen.getByRole('dialog', { name: 'Notices' })).toBeTruthy();
  });

  it('an older hub (every live-activity route 404) still shows the map, the bell and the chat line, and no bar or pill', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = async () => { throw new ApiError(404, 'not_found', 'Route not found'); };
    await openOffice(liveApi({ activity: missing, notices: missing, presence: missing, accounts: missing, sessionActivity: missing }));
    expect(screen.getByTestId('agency-stage')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 needs you' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message to Luady' })).toBeTruthy();
    expect(screen.queryByTestId('energy-bar')).toBeNull();
    expect(screen.queryByTestId('updates-pill')).toBeNull();
    expect(screen.queryByTestId('notices-button')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    fire({ type: 'actor', id: 'birch:app-backend' });
    expect(screen.getByTestId('current-step').textContent).toContain('Thinking');
    warn.mockRestore();
  });

  it('Settings can open the office with Accounts and limits showing', async () => {
    const kit2 = fleet().map((s) => ({ ...s, kitVersion: '2.0.0' }));
    await renderPage(<AgencyPage />, {
      api: liveApi(), overview: fleetOverview({ servers: kit2 }), route: '/?open=accounts',
    });
    expect(await screen.findByRole('dialog', { name: 'Accounts and limits' })).toBeTruthy();
  });
});
