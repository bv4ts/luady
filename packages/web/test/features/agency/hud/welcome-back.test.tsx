import type { RecapDTO, RecapLine } from '@luady/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../../src/features/agency/AgencyPage.js';
import { RECAP_LINES_SHOWN, sinceWords } from '../../../../src/features/agency/hud/WelcomeBack.js';
import {
  AWAY_MS, LAST_HERE_KEY, readLastHere, recapCounts, recapSections, recapSince, writeLastHere,
} from '../../../../src/features/agency/model/last-here.js';
import { ApiError } from '../../../../src/api/errors.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { fleetOverview } from '../agency-fixtures.js';
import { resetStageSpy } from '../stage-mock.js';

vi.mock('../../../../src/features/agency/scene/AgencyStage.js', () => import('../stage-mock.js'));

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const line = (text: string, ref: RecapLine['ref'] = null, server: RecapLine['server'] = 'birch'): RecapLine => ({ at: iso(60_000), text, ref, server });

function recap(over: Partial<RecapDTO> = {}): RecapDTO {
  return {
    since: iso(2 * 60 * 60_000), until: iso(0), finished: [], failed: [], waiting: [], meetings: [],
    cards: { added: 0, done: 0 }, sessions: { started: 0, ended: 0 }, ...over,
  };
}

describe('last here', () => {
  it('asks for a recap only after 30 minutes or more away, and never on a first visit', () => {
    const now = 10_000_000;
    expect(recapSince(null, now)).toBeNull();
    expect(recapSince(now - AWAY_MS + 1, now)).toBeNull();
    expect(recapSince(now - AWAY_MS, now)).toBe(now - AWAY_MS);
  });

  it('reads and writes the device value, and survives storage that refuses', () => {
    const store = new Map<string, string>();
    const fake = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(readLastHere(fake)).toBeNull();
    writeLastHere(fake, 1234);
    expect(store.get(LAST_HERE_KEY)).toBe('1234');
    expect(readLastHere(fake)).toBe(1234);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readLastHere(broken)).toBeNull();
    expect(() => writeLastHere(broken, 1)).not.toThrow();
  });

  it('orders the card: waiting, went wrong, finished, meetings; empty parts left out', () => {
    const sections = recapSections(recap({ finished: [line('a')], waiting: [line('b')], meetings: [line('c')] }));
    expect(sections.map((section) => section.title)).toEqual(['Waiting for you', 'Finished', 'New meeting notes']);
  });

  it('counts only what is not zero', () => {
    expect(recapCounts(recap({ cards: { added: 3, done: 5 }, sessions: { started: 2, ended: 1 } }))).toBe('3 cards added, 5 done · 2 sessions started, 1 ended');
    expect(recapCounts(recap({ cards: { added: 0, done: 1 } }))).toBe('1 card done');
    expect(recapCounts(recap({ sessions: { started: 0, ended: 2 } }))).toBe('2 sessions ended');
    expect(recapCounts(recap())).toBe('');
  });

  it('says since when in owner time', () => {
    const now = Date.parse('2026-11-15T10:00:00.000Z');
    expect(sinceWords('2026-11-15T08:10:00.000Z', now)).toBe('12:10 PM');
    expect(sinceWords('2026-11-14T14:40:00.000Z', now)).toBe('Yesterday, 6:40 PM');
    expect(sinceWords('2026-11-12T14:40:00.000Z', now)).toBe('Nov 12, 6:40 PM');
  });
});

describe('the welcome-back card on the office', () => {
  beforeEach(() => {
    resetStageSpy();
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  async function open(found: RecapDTO | Error, lastHere: number | null) {
    if (lastHere !== null) window.localStorage.setItem(LAST_HERE_KEY, String(lastHere));
    const api = fakeApi({
      luadyMessages: async () => ({ items: [], nextCursor: null }),
      recap: async () => {
        if (found instanceof Error) throw found;
        return found;
      },
    });
    const harness = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    return harness;
  }

  it('after an hour away Luady hands over the card, and "Got it" closes it', async () => {
    const away = Date.now() - 60 * 60_000;
    const { api, user } = await open(recap({
      waiting: [line('harbor-web asks which logo to use', { kind: 'question', id: 'QFIRST01' }, 'ash')],
      finished: [line('Payroll export uses ISO dates', { kind: 'todo', id: '12' })],
      cards: { added: 2, done: 1 },
    }), away);
    expect(api.recap).toHaveBeenCalledWith(new Date(away).toISOString());
    const card = await screen.findByRole('region', { name: 'Welcome back' });
    expect(within(card).getByText('Waiting for you')).toBeTruthy();
    expect(within(card).getByText('2 cards added, 1 done')).toBeTruthy();
    // It never takes the focus from the chat line.
    expect(card.contains(document.activeElement)).toBe(false);
    await user.click(within(card).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('region', { name: 'Welcome back' })).toBeNull();
    // Coming in now updated "last here".
    expect(Number(window.localStorage.getItem(LAST_HERE_KEY))).toBeGreaterThan(away);
  });

  it('a line opens its thing: a card opens the board on it; the card hides while a pop-up is open', async () => {
    const { user } = await open(recap({ finished: [line('Payroll export uses ISO dates', { kind: 'todo', id: '12' })] }), Date.now() - AWAY_MS);
    const card = await screen.findByRole('region', { name: 'Welcome back' });
    await user.click(within(card).getByRole('button', { name: /Payroll export/ }));
    expect(await screen.findByRole('dialog', { name: 'Board' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Welcome back' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Board' }), { key: 'Escape' });
    expect(await screen.findByRole('region', { name: 'Welcome back' })).toBeTruthy();
  });

  it('a question opens the agent it waits on', async () => {
    const { user } = await open(recap({ waiting: [line('harbor-web asks', { kind: 'question', id: 'QFIRST01' }, 'ash')] }), Date.now() - AWAY_MS);
    await user.click(await screen.findByRole('button', { name: /harbor-web asks/ }));
    expect(await screen.findByRole('dialog', { name: 'harbor-web' })).toBeTruthy();
  });

  it('long sections show four lines and the rest on request', async () => {
    const lines = Array.from({ length: 7 }, (_, i) => line(`Done ${i}`));
    const { user } = await open(recap({ finished: lines }), Date.now() - AWAY_MS);
    const card = await screen.findByRole('region', { name: 'Welcome back' });
    expect(within(card).getAllByText(/^Done \d$/)).toHaveLength(RECAP_LINES_SHOWN);
    await user.click(within(card).getByRole('button', { name: 'Show 3 more' }));
    expect(within(card).getAllByText(/^Done \d$/)).toHaveLength(7);
  });

  it('nothing when the recap is empty', async () => {
    const { api } = await open(recap(), Date.now() - 2 * AWAY_MS);
    await waitFor(() => expect(api.recap).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Welcome back' })).toBeNull();
  });

  it('nothing when the owner was here a minute ago', async () => {
    const { api } = await open(recap({ finished: [line('x')] }), Date.now() - 60_000);
    expect(api.recap).not.toHaveBeenCalled();
  });

  it('nothing on a first visit to this device', async () => {
    const { api } = await open(recap({ finished: [line('x')] }), null);
    expect(api.recap).not.toHaveBeenCalled();
  });

  it('a hub without recaps stays quiet', async () => {
    const { api } = await open(new ApiError(501, 'not_built_yet', 'x'), Date.now() - 2 * AWAY_MS);
    await waitFor(() => expect(api.recap).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Welcome back' })).toBeNull();
  });

  it('coming back to the tab after half an hour asks again', async () => {
    const { api } = await open(recap({ finished: [line('Shipped')] }), null);
    expect(api.recap).not.toHaveBeenCalled();
    window.localStorage.setItem(LAST_HERE_KEY, String(Date.now() - 45 * 60_000));
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(api.recap).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('region', { name: 'Welcome back' })).toBeTruthy();
  });
});
