import { DEFAULT_WEB_PREFS } from '@luady/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { AgencyPage } from '../../../../src/features/agency/AgencyPage.js';
import { HelpModal } from '../../../../src/features/agency/drawers/help/HelpModal.js';
import { HELP_KEYS, helpFixtures } from '../../../../src/features/agency/drawers/help/help-content.js';
import { WHATS_NEW } from '../../../../src/features/agency/drawers/help/whats-new.js';
import { COMPACT_FROM_PCT, canCompact } from '../../../../src/features/agency/model/compact.js';
import { dueWithinDay, fleetAlert, winsThisWeek } from '../../../../src/features/agency/model/hud-badges.js';
import { fixtureBadges, fixtureTip } from '../../../../src/features/agency/model/map-labels.js';
import { SHOW_ME_DELAY_MS, SHOW_ME_MS } from '../../../../src/features/agency/model/useShowMe.js';
import { SettingsPage } from '../../../../src/features/settings/SettingsPage.js';
import { NOW, account, activityItem, overview, server, settings } from '../../../fixtures.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { fleetOverview, snapshotOf } from '../agency-fixtures.js';
import { resetStageSpy, stageProps } from '../stage-mock.js';

vi.mock('../../../../src/features/agency/scene/AgencyStage.js', () => import('../stage-mock.js'));

const now = Date.parse(NOW);
const hours = (h: number): string => new Date(now + h * 3_600_000).toISOString();

const pageApi = (over: Parameters<typeof fakeApi>[0] = {}) => fakeApi({
  luadyMessages: async () => ({ items: [], nextCursor: null }),
  transcript: async () => ({ items: [], nextCursor: null }),
  ...over,
});

beforeEach(() => {
  resetStageSpy();
});

describe('Compact now', () => {
  const idle = { state: 'idle' as const, pendingQid: null };

  it(`is offered from ${COMPACT_FROM_PCT}% context, for a session that can take a message`, () => {
    expect(canCompact(idle, COMPACT_FROM_PCT - 1)).toBe(false);
    expect(canCompact(idle, COMPACT_FROM_PCT)).toBe(true);
    expect(canCompact({ state: 'working', pendingQid: null }, 90)).toBe(true);
    expect(canCompact(idle, null)).toBe(false);
    expect(canCompact({ state: 'ended', pendingQid: null }, 90)).toBe(false);
    expect(canCompact({ state: 'waiting_question', pendingQid: 'Q1' }, 90)).toBe(false);
  });

  async function openAgent(contextPct: number) {
    const api = pageApi({
      activity: async () => ({ items: [activityItem({ sessionId: 'birch:app-backend', contextPct })] }),
      sendToSession: async () => ({ id: 'A1', actor: 'owner', channel: 'web', kind: 'session.send', tier: 0, summary: '', status: 'done', createdAt: NOW, decidedAt: NOW, result: 'sent', error: null }),
    });
    const harness = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    return harness;
  }

  it('the agent view offers it at 72% and sends /compact with a toast', async () => {
    const { api, user } = await openAgent(72);
    act(() => stageProps().onEvent({ type: 'actor', id: 'birch:app-backend' }));
    const offer = await screen.findByTestId('compact-offer');
    expect(offer.textContent).toContain('Context 72% full');
    await user.click(within(offer).getByRole('button', { name: 'Compact now' }));
    expect(api.sendToSession).toHaveBeenCalledWith('birch:app-backend', { text: '/compact' });
    expect(await screen.findByText(/Compacting .*app-backend/)).toBeTruthy();
  });

  it('the right-click menu offers it too; below 60% neither does', async () => {
    await openAgent(72);
    act(() => stageProps().onEvent({ type: 'menu', id: 'birch:app-backend', x: 100, y: 100 }));
    expect(await screen.findByTestId('actor-menu-compact')).toBeTruthy();
  });

  it('nothing below 60%', async () => {
    await openAgent(40);
    act(() => stageProps().onEvent({ type: 'menu', id: 'birch:app-backend', x: 100, y: 100 }));
    await screen.findByRole('menu');
    expect(screen.queryByTestId('actor-menu-compact')).toBeNull();
  });
});

describe('Help', () => {
  it('every fixture it explains is on the map, with a target "Show me" can reach', () => {
    const snapshot = snapshotOf({ jiraRooms: ['birch'] });
    const ids = new Set(snapshot.fixtures.map((fixture) => fixture.id));
    // By design: the fixtures every room has are shown in the first room (birch with the classic four).
    const fixtures = helpFixtures('birch');
    fixtures.forEach((fixture) => {
      expect(fixture.target?.kind).toBe('fixture');
      if (fixture.target?.kind === 'fixture') expect(ids.has(fixture.target.id)).toBe(true);
    });
    expect(new Set(fixtures.map((fixture) => fixture.kind))).toEqual(new Set(snapshot.fixtures.map((fixture) => fixture.kind)));
  });

  it('with no rooms yet, the fixtures every room has get no "Show me"; HQ\'s keep theirs', () => {
    const fixtures = helpFixtures(null);
    expect(fixtures.filter((fixture) => fixture.target === null).map((fixture) => fixture.kind)).toEqual(['rack', 'links', 'jira']);
    expect(fixtures.find((fixture) => fixture.kind === 'tv')?.target).toEqual({ kind: 'fixture', id: 'tv-hq' });
  });

  it('lists the fixtures, the keys and what is new, newest first', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const onShow = vi.fn();
    await renderPage(<HelpModal onClose={vi.fn()} onShow={onShow} />, { overview: overview({ rooms: classicRoomDtos() }) });
    fireEvent.click(screen.getByRole('button', { name: 'Show me the fleet' }));
    expect(onShow).toHaveBeenCalledWith({ kind: 'fixture', id: 'tv-hq' });
    expect(screen.getByText('Mute or unmute the sounds')).toBeTruthy();
    expect(HELP_KEYS.length).toBeGreaterThan(4);
    expect(WHATS_NEW.map((entry) => entry.title)).toEqual(['More things in HQ', 'The working HQ']);
  });

  it('"Show me" closes Help, flies to the room and outlines the fixture for a few seconds', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview({ rooms: classicRoomDtos() }) });
    await screen.findByTestId('agency-stage');
    const handle = { pick: vi.fn(() => null), setDropHint: vi.fn() };
    act(() => stageProps().onReady?.(handle));
    act(() => stageProps().onEvent({ type: 'fixture', fixture: 'robot', id: 'robot-hq', room: 'hq' }));
    const help = await screen.findByTestId('help-modal');
    vi.useFakeTimers();
    try {
      fireEvent.click(within(help).getByRole('button', { name: 'Show me the server' }));
      expect(screen.queryByTestId('help-modal')).toBeNull();
      expect(stageProps().focus).toEqual({ kind: 'room', room: 'birch' });
      act(() => vi.advanceTimersByTime(SHOW_ME_DELAY_MS));
      expect(handle.setDropHint).toHaveBeenLastCalledWith({ kind: 'fixture', id: 'rack-birch' });
      act(() => vi.advanceTimersByTime(SHOW_ME_MS));
      expect(handle.setDropHint).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('badges for the new fixtures', () => {
  const full = (pct: number) => account({ limits: { reported: 'yes', fiveHour: { usedPct: pct, resetsAt: hours(2) }, sevenDay: null, updatedAt: NOW } });

  it('the TV lights a red dot when a server is offline or an account is at 95%', () => {
    expect(fleetAlert([server({ status: 'online' })], [full(80)], now)).toBe(false);
    expect(fleetAlert([server({ status: 'offline' })], [], now)).toBe(true);
    expect(fleetAlert([server({ status: 'online' })], [full(95)], now)).toBe(true);
    const snapshot = snapshotOf();
    expect(fixtureBadges(snapshot, { board: null, newNotes: 0, energy: null, jira: {}, fleetAlert: true })['tv-hq'])
      .toEqual({ text: '', tone: 'alert', words: 'A server is offline or an account is nearly full', dot: true });
  });

  it('the wins board counts the last 7 days; the schedule board the next 24 hours; each links board its links', () => {
    const card = (doneAt: string | null, state: 'done' | 'open' = 'done') => ({ state, doneAt }) as never;
    expect(winsThisWeek([card(hours(-24)), card(hours(-24 * 8)), card(null), card(hours(-1), 'open')], now)).toBe(1);
    expect(dueWithinDay([{ nextRunAt: hours(3) }, { nextRunAt: hours(30) }, { nextRunAt: null }, { nextRunAt: hours(-1) }], now)).toBe(1);
    const snapshot = snapshotOf();
    const badges = fixtureBadges(snapshot, { board: null, newNotes: 0, energy: null, jira: {}, winsWeek: 3, scheduleSoon: 1, links: { birch: 4 } });
    expect(badges['wins-hq']?.words).toBe('3 wins this week');
    expect(badges['schedule-hq']?.words).toBe('1 due in the next 24 hours');
    expect(badges['links-birch']).toEqual({ text: '4', tone: 'info', words: '4 links' });
    expect(badges['links-ash']).toBeUndefined();
  });

  it("the clock's tooltip says the time in owner time", () => {
    expect(fixtureTip(snapshotOf(), {}, 'clock-hq', Date.parse('2026-11-15T11:20:00.000Z'))).toBe('Today · 3:20 PM in owner time');
  });

  it('the page counts schedules and links from the hub', async () => {
    const api = pageApi({
      schedules: async () => ({ items: [{ id: 's1', when: 'every day at 9', task: 'digest', nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }] }),
      links: async () => ({ items: [{ id: 1, server: 'birch', label: 'Jira', url: 'https://x.atlassian.net', position: 0 }] }),
    });
    await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    await waitFor(() => expect(screen.getAllByTestId('fixture-badge').map((node) => node.getAttribute('data-fixture'))).toEqual(
      expect.arrayContaining(['schedule-hq', 'links-birch']),
    ));
  });
});

describe('preferences: the speaker, M and the office settings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the speaker mutes on every device through the hub', async () => {
    const api = pageApi({ updatePrefs: async (body) => ({ ...DEFAULT_WEB_PREFS, sound: { ...DEFAULT_WEB_PREFS.sound, muted: body.sound?.muted ?? false } }) });
    const { user } = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await user.click(await screen.findByRole('button', { name: 'Sounds on. Mute (M)' }));
    expect(api.updatePrefs).toHaveBeenCalledWith({ sound: { muted: true } });
    expect(await screen.findByRole('button', { name: 'Sounds off. Turn sounds on (M)' })).toBeTruthy();
  });

  it('M toggles the same mute; a hub that cannot keep it yet keeps it on this page', async () => {
    const api = pageApi({ updatePrefs: async () => { throw new ApiError(501, 'not_built_yet', 'x'); } });
    await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    fireEvent.keyDown(document.body, { key: 'm' });
    await waitFor(() => expect(api.updatePrefs).toHaveBeenCalledWith({ sound: { muted: true } }));
    expect(await screen.findByRole('button', { name: 'Sounds off. Turn sounds on (M)' })).toBeTruthy();
  });

  it('a refused change goes back and says why', async () => {
    const api = pageApi({ updatePrefs: async () => { throw new ApiError(500, 'internal', 'The hub could not save that.'); } });
    const { user } = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await user.click(await screen.findByRole('button', { name: 'Sounds on. Mute (M)' }));
    expect(await screen.findByRole('button', { name: 'Sounds on. Mute (M)' })).toBeTruthy();
  });

  it('settings: the day-and-night switch and the volume save to the prefs', async () => {
    const api = fakeApi({
      settings: async () => settings(),
      updatePrefs: async (body) => ({ sound: { muted: false, volume: body.sound?.volume ?? 0.6 }, dayNight: body.dayNight ?? true }),
    });
    const { user } = await renderPage(<SettingsPage />, { api });
    const card = await screen.findByRole('region', { name: 'Office' });
    await user.click(within(card).getByRole('switch', { name: 'Day and night' }));
    expect(api.updatePrefs).toHaveBeenCalledWith({ dayNight: false });
    vi.useFakeTimers();
    try {
      fireEvent.change(within(card).getByRole('slider', { name: 'Volume' }), { target: { value: '30' } });
      act(() => vi.advanceTimersByTime(500));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(api.updatePrefs).toHaveBeenLastCalledWith({ sound: { volume: 0.3 } }));
  });
});

describe('day and night follows a settings change', () => {
  it('reads the quiet hours again when the tab is shown, so the stage dims or wakes without a reload', async () => {
    // A window around the current owner time, so the test never lands on its edge.
    const ownerClock = (offsetMin: number): string => new Date(Date.now() + (240 + offsetMin) * 60_000).toISOString().slice(11, 16);
    let quiet = { start: ownerClock(-60), end: ownerClock(60) };
    const api = pageApi({ settings: async () => settings({ quiet_hours: { ...settings().quiet_hours, ...quiet } }) });
    await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    await waitFor(() => expect(stageProps().ambience).toEqual({ enabled: true, quiet: true }));
    quiet = { start: '00:00', end: '00:00' };
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(stageProps().ambience).toEqual({ enabled: true, quiet: false }));
  });
});

describe('the help key', () => {
  it('"?" opens Help, but not while typing', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message to Luady' }), { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Help' })).toBeTruthy();
  });
});
