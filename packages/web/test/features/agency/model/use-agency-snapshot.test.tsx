import { buildSnapshot, type AgencySnapshot } from '@luady/office';
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEATS_KEY } from '../../../../src/features/agency/model/seat-store.js';
import { useAgencySnapshot } from '../../../../src/features/agency/model/useAgencySnapshot.js';
import { useStore } from '../../../../src/state/store.js';
import { NOW } from '../../../fixtures.js';
import { renderPage } from '../../../helpers/render.js';
import { agent, fleetOverview } from '../agency-fixtures.js';

// Pass-through spy: lets a test read the previousSeats each build received.
vi.mock('@luady/office', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@luady/office')>();
  return { ...actual, buildSnapshot: vi.fn(actual.buildSnapshot) };
});

function Probe({ seen }: { seen: AgencySnapshot[] }) {
  const snapshot = useAgencySnapshot();
  const { toast } = useStore();
  seen.push(snapshot);
  return <button type="button" onClick={() => toast('info', 'unrelated')}>poke</button>;
}

async function open(overview = fleetOverview()) {
  const seen: AgencySnapshot[] = [];
  const harness = await renderPage(<Probe seen={seen} />, { overview });
  return { ...harness, seen, last: () => seen.at(-1) as AgencySnapshot };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAgencySnapshot', () => {
  it('builds the office from the store', async () => {
    const { last } = await open();
    expect(Object.keys(last().actors).toSorted()).toEqual(['ash:harbor-web', 'birch:app-backend', 'birch:jira-1105', 'cedar:meadow-vat', 'local:client-preferences']);
    expect(last().needs).toEqual(['ash:harbor-web']);
    expect(last().luady.state).toBe('running');
  });

  it('returns the same object while nothing changed', async () => {
    const { user, ws, last } = await open();
    const before = last();
    await user.click(screen.getByRole('button', { name: 'poke' }));
    expect(last()).toBe(before);
    ws.emit({ type: 'session.updated', session: agent('birch', 'app-backend') });
    expect(last()).toBe(before);
    ws.emit({ type: 'session.updated', session: agent('birch', 'app-backend', { state: 'idle' }) });
    expect(last()).not.toBe(before);
    expect(last().actors['birch:app-backend']?.state).toBe('idle');
  });

  it('keeps desks across re-renders and saves them', async () => {
    const { ws, last } = await open(fleetOverview({ sessions: [agent('birch', 'b'), agent('birch', 'c')], questions: [] }));
    expect(last().seats).toEqual({ 'birch:b': 0, 'birch:c': 1 });
    ws.emit({ type: 'session.updated', session: agent('birch', 'a') });
    expect(last().seats).toEqual({ 'birch:a': 2, 'birch:b': 0, 'birch:c': 1 });
    expect(JSON.parse(localStorage.getItem(SEATS_KEY) ?? '{}')).toEqual({ 'birch:a': 2, 'birch:b': 0, 'birch:c': 1 });
  });

  it('starts from the desks saved on this device', async () => {
    localStorage.setItem(SEATS_KEY, JSON.stringify({ 'birch:app-backend': 5 }));
    const { last } = await open();
    expect(last().actors['birch:app-backend']?.seat).toBe(5);
  });

  it('neither feeds back nor saves seats before the store has loaded', async () => {
    const stored = { 'birch:app-backend': 5 };
    localStorage.setItem(SEATS_KEY, JSON.stringify(stored));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { last } = await open();
    const builds = vi.mocked(buildSnapshot).mock.calls.map(([input]) => input);
    const unloaded = builds.filter((input) => input.servers.length === 0);
    expect(unloaded.length).toBeGreaterThan(0);
    expect(unloaded.every((input) => input.previousSeats['birch:app-backend'] === 5)).toBe(true);
    expect(builds.at(-1)?.previousSeats['birch:app-backend']).toBe(5);
    expect(last().actors['birch:app-backend']?.seat).toBe(5);
    expect(setItem.mock.calls.every(([, value]) => JSON.parse(value)['birch:app-backend'] === 5)).toBe(true);
    expect(JSON.parse(localStorage.getItem(SEATS_KEY) ?? '{}')).toEqual({
      'birch:app-backend': 5, 'birch:jira-1105': 0, 'ash:harbor-web': 0, 'cedar:meadow-vat': 0, 'local:client-preferences': 0,
    });
  });

  it('survives corrupt or blocked localStorage', async () => {
    localStorage.setItem(SEATS_KEY, '{oops');
    const first = await open();
    expect(Object.keys(first.last().actors)).toHaveLength(5);
    first.unmount();

    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
    const second = await open();
    expect(Object.keys(second.last().actors)).toHaveLength(5);
  });

  it('refreshes the clock every 30 seconds so idle agents doze off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse(NOW) + 4.8 * 60_000);
    const { last } = await open(fleetOverview({ sessions: [agent('cedar', 'quiet', { state: 'idle', lastEventAt: NOW })], questions: [] }));
    expect(last().actors['cedar:quiet']?.visual.pose).toBe('sit');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(last().actors['cedar:quiet']?.visual.pose).toBe('sleep');
  });
});
