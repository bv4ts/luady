import { DEFAULT_SETTINGS } from '@luady/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../../src/api/context.js';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import { OpenModal, showActions } from '../../../src/features/agency/OpenModal.js';
import { INITIAL_UI, reduceAgencyUi, type ModalState } from '../../../src/features/agency/model/ui-state.js';
import { isQuietAt, useAmbience } from '../../../src/features/agency/model/useAmbience.js';
import type { StageTarget } from '../../../src/features/agency/stage-types.js';
import { StoreProvider } from '../../../src/state/store.js';
import { overview } from '../../fixtures.js';
import { fakeApi, type FakeApi } from '../../helpers/fake-api.js';
import { createFakeWs } from '../../helpers/fake-ws.js';
import { renderPage } from '../../helpers/render.js';
import { fleetOverview } from './agency-fixtures.js';
import { resetStageSpy, stageProps } from './stage-mock.js';

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('./stage-mock.js'));
// The real pop-ups need the API, the store and their data; this file checks only the frame and the mapping.
vi.mock('../../../src/features/agency/drawers/fleet/FleetModal.js', () => ({ FleetModal: () => <p data-testid="fleet-modal">The fleet wall</p> }));
vi.mock('../../../src/features/agency/drawers/wins/WinsModal.js', () => ({ WinsModal: () => <p data-testid="wins-modal">The wins wall</p> }));
vi.mock('../../../src/features/agency/drawers/timeline/TimelineModal.js', () => ({ TimelineModal: () => <p data-testid="timeline-modal">The today strip</p> }));
vi.mock('../../../src/features/agency/drawers/schedule/ScheduleModal.js', () => ({ ScheduleModal: () => <p data-testid="schedule-modal">The schedule board</p> }));
vi.mock('../../../src/features/agency/drawers/links/LinksModal.js', () => ({
  LinksModal: ({ room }: { room: string }) => <p data-testid="links-modal">The links shelf of {room}</p>,
}));

/** Epoch ms of an owner wall-clock time in the test zone (UTC+4): 10 PM on 2026-11-15 is 18:00 UTC. */
const at = (ownerHour: number, minute = 0): number => Date.UTC(2026, 10, 15, ownerHour - 4, minute);

/** The page passes its first room (no fixed default room); the classic office's is Orchard on birch. */
function ModalHarness({ initial, onShow, firstRoom = 'birch' }: { initial: ModalState; onShow?: (target: StageTarget) => void; firstRoom?: string | null }) {
  const [ui, dispatch] = useReducer(reduceAgencyUi, { ...INITIAL_UI, modal: initial });
  return (
    <div>
      <output data-testid="ui">{`${ui.modal?.kind ?? 'closed'}|${ui.focus.kind === 'room' ? ui.focus.room : ui.focus.kind}`}</output>
      <OpenModal ui={ui} dispatch={dispatch} firstRoom={firstRoom} {...(onShow === undefined ? {} : { onShow })} />
    </div>
  );
}

beforeEach(() => {
  resetStageSpy();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the fleet, wins, today, schedule, links and help pop-ups', () => {
  it.each([
    [{ kind: 'fleet' }, 'Fleet', 'fleet-modal', 'fleet wall'],
    [{ kind: 'wins' }, 'Wins', 'wins-modal', 'wins wall'],
    [{ kind: 'timeline' }, 'Today', 'timeline-modal', 'today strip'],
    [{ kind: 'schedule' }, 'Schedule', 'schedule-modal', 'schedule board'],
    [{ kind: 'links', room: 'cedar' }, 'Links', 'links-modal', 'cedar'],
    [{ kind: 'links' }, 'Links', 'links-modal', 'birch'],
    [{ kind: 'help' }, 'Help', 'help-modal', 'Help'],
  ] as const)('%j loads its placeholder in a labelled dialog', async (modal, label, testId, text) => {
    // Help reads the rooms, so the pop-ups open inside the store.
    await renderPage(<ModalHarness initial={modal} />);
    expect(screen.getByRole('dialog', { name: label })).toBeTruthy();
    expect((await screen.findByTestId(testId)).textContent).toContain(text);
  });

  it('the links shelf of an office with no rooms offers to add one', async () => {
    render(<ModalHarness initial={{ kind: 'links' }} firstRoom={null} />);
    const add = await screen.findByRole('button', { name: 'Add a room' });
    expect(screen.queryByTestId('links-modal')).toBeNull();
    fireEvent.click(add);
    expect(screen.getByTestId('ui').textContent).toBe('rooms|all');
  });
});

describe("Help's Show me", () => {
  it('closes the pop-up and focuses the room of a fixture, a room, or opens a character', () => {
    expect(showActions({ kind: 'fixture', id: 'links-cedar' })).toEqual([{ type: 'modal.close' }, { type: 'focus', focus: { kind: 'room', room: 'cedar' } }]);
    expect(showActions({ kind: 'fixture', id: 'tv-hq' })).toEqual([{ type: 'modal.close' }, { type: 'focus', focus: { kind: 'room', room: 'hq' } }]);
    expect(showActions({ kind: 'room', room: 'ash' })).toEqual([{ type: 'modal.close' }, { type: 'focus', focus: { kind: 'room', room: 'ash' } }]);
    expect(showActions({ kind: 'actor', id: 'birch:a' })).toEqual([{ type: 'modal.close' }, { type: 'select', id: 'birch:a' }]);
    expect(showActions({ kind: 'fixture', id: 'odd' })).toEqual([{ type: 'modal.close' }]);
  });

  it('the page may pass its own handler instead', async () => {
    const onShow = vi.fn();
    await renderPage(<ModalHarness initial={{ kind: 'help' }} onShow={onShow} />);
    expect(await screen.findByTestId('help-modal')).toBeTruthy();
    expect(onShow).not.toHaveBeenCalled();
  });
});

describe('isQuietAt (owner time, like the hub)', () => {
  it('handles a window across midnight, its edges, a same-day window and an empty one', () => {
    const night = { start: '00:00', end: '08:00' };
    expect(isQuietAt(at(3), night)).toBe(true);
    expect(isQuietAt(at(8), night)).toBe(false);
    expect(isQuietAt(at(23, 59), night)).toBe(false);
    const late = { start: '22:00', end: '07:00' };
    expect(isQuietAt(at(22), late)).toBe(true);
    expect(isQuietAt(at(6, 59), late)).toBe(true);
    expect(isQuietAt(at(7), late)).toBe(false);
    expect(isQuietAt(at(13), { start: '12:00', end: '14:00' })).toBe(true);
    expect(isQuietAt(at(13), { start: '09:00', end: '09:00' })).toBe(false);
  });
});

describe('useAmbience', () => {
  function Probe() {
    const ambience = useAmbience();
    return <output data-testid="ambience">{`${String(ambience.enabled)}:${String(ambience.quiet)}`}</output>;
  }

  function mount(api: FakeApi) {
    const ws = createFakeWs();
    render(<ApiProvider api={api}><StoreProvider createWs={ws.factory} onAuthLost={vi.fn()}><Probe /></StoreProvider></ApiProvider>);
    return ws;
  }

  it('follows dayNight from the prefs and the quiet hours from the settings', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: at(23) });
    try {
      const api = fakeApi({
        overview: async () => overview(), prefs: async () => ({ sound: { muted: false, volume: 0.6 }, dayNight: false }),
        settings: async () => ({ ...DEFAULT_SETTINGS, quiet_hours: { start: '23:00', end: '07:00', tz: 'Etc/GMT-4' } }),
      });
      mount(api);
      await vi.waitFor(() => expect(screen.getByTestId('ambience').textContent).toBe('false:true'));
      await act(async () => {
        vi.setSystemTime(at(7, 1));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByTestId('ambience').textContent).toBe('false:false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an older hub leaves day and night on and never quiet', async () => {
    mount(fakeApi({ overview: async () => overview() }));
    await waitFor(() => expect(screen.getByTestId('ambience').textContent).toBe('true:false'));
  });
});

describe('AgencyPage with the fleet, wins, today, schedule, links and help pop-ups', () => {
  const pageApi = () => fakeApi({
    luadyMessages: async () => ({ items: [], nextCursor: null }),
    jiraSites: async () => ({ sites: [] }),
    prefs: async () => ({ sound: { muted: false, volume: 0.6 }, dayNight: false }),
    // Quiet hours that never start, so the test does not depend on the time of day it runs at.
    settings: async () => ({ ...DEFAULT_SETTINGS, quiet_hours: { ...DEFAULT_SETTINGS.quiet_hours, start: '00:00', end: '00:00' } }),
  });

  it.each([
    ['tv', 'hq', 'Fleet', 'fleet-modal'],
    ['clock', 'hq', 'Today', 'timeline-modal'],
    ['schedule', 'hq', 'Schedule', 'schedule-modal'],
    ['wins', 'hq', 'Wins', 'wins-modal'],
    ['robot', 'hq', 'Help', 'help-modal'],
    ['links', 'ash', 'Links', 'links-modal'],
  ] as const)('the %s fixture opens %s', async (fixture, room, label, testId) => {
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    act(() => stageProps().onEvent({ type: 'fixture', fixture, id: `${fixture}-${room}`, room }));
    expect(screen.getByRole('dialog', { name: label })).toBeTruthy();
    expect(await screen.findByTestId(testId)).toBeTruthy();
  });

  it('passes the ambience to the stage: day and night from the prefs', async () => {
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    await waitFor(() => expect(stageProps().ambience).toEqual({ enabled: false, quiet: false }));
  });

  it('Esc closes the wins wall', async () => {
    const user = userEvent.setup();
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    act(() => stageProps().onEvent({ type: 'fixture', fixture: 'wins', id: 'wins-hq', room: 'hq' }));
    await screen.findByTestId('wins-modal');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Wins' })).toBeNull();
  });
});
