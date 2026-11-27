import { screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EnergyBar } from '../../../../src/features/agency/hud/EnergyBar.js';
import { UpdatesPill } from '../../../../src/features/agency/hud/UpdatesPill.js';
import { RoomPanel } from '../../../../src/features/agency/panels/RoomPanel.js';
import { useStore } from '../../../../src/state/store.js';
import { account, accountHost, accounts, overview, presence } from '../../../fixtures.js';
import { channelDto } from '../../../room-fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { fleetOverview, snapshotOf } from '../agency-fixtures.js';

const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe('EnergyBar', () => {
  it('renders nothing without a reading', async () => {
    await renderPage(<EnergyBar energy={null} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('energy-bar')).toBeNull();
  });

  it('shows the account, how full it is, its tone, and opens the accounts drawer', async () => {
    const onOpen = vi.fn();
    const { user } = await renderPage(
      <EnergyBar energy={{ accountId: 'claude:cedar', label: 'cedar', usedPct: 96, tone: 'red', resetsAt: soon(1) }} onOpen={onOpen} />,
    );
    const bar = screen.getByTestId('energy-bar');
    expect(bar.textContent).toContain('cedar');
    expect(bar.textContent).toContain('96%');
    expect(bar.className).toContain('agency-energy--red');
    expect(bar.getAttribute('title')).toMatch(/^5-hour limit resets /);
    await user.click(bar);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('UpdatesPill', () => {
  it('renders nothing while the hub has not said where updates go (an older hub)', async () => {
    await renderPage(<UpdatesPill />);
    expect(screen.queryByTestId('updates-pill')).toBeNull();
  });

  it('follows presence.updated and switches both ways', async () => {
    const forced = presence({ mode: 'chat', forcedUntil: soon(1) });
    const api = fakeApi({ setPresence: async (body) => (body.chat ? forced : presence()) });
    const { ws, user } = await renderPage(<UpdatesPill />, { api });
    ws.emit({ type: 'presence.updated', presence: presence() });
    const pill = screen.getByTestId('updates-pill');
    expect(pill.textContent).toBe('Updates: here');
    // By design: the chat channel by its own name, never a fixed chat app.
    expect(pill.getAttribute('title')).toBe('Send updates to your chat channel for the next hour');
    await user.click(pill);
    expect(api.setPresence).toHaveBeenLastCalledWith({ chat: true });
    expect(screen.getByTestId('updates-pill').textContent).toMatch(/^Updates: your chat channel until /);
    expect(screen.getByTestId('updates-pill').getAttribute('title')).toBe('Back to showing updates here');
    await user.click(screen.getByTestId('updates-pill'));
    expect(api.setPresence).toHaveBeenLastCalledWith({ chat: false });
    expect(screen.getByTestId('updates-pill').textContent).toBe('Updates: here');
  });

  it('names the primary chat channel the hub declared', async () => {
    const { ws } = await renderPage(<UpdatesPill />, { overview: overview({ channels: [channelDto({ name: 'Chat app' })] }) });
    ws.emit({ type: 'presence.updated', presence: presence({ mode: 'chat' }) });
    expect(screen.getByTestId('updates-pill').textContent).toBe('Updates: Chat app');
  });
});

function WithAccounts({ children, limits }: { children: ReactNode; limits: 'yes' | 'no' }) {
  const { dispatch } = useStore();
  useEffect(() => {
    const reading = limits === 'yes'
      ? { reported: 'yes' as const, fiveHour: { usedPct: 62, resetsAt: soon(2) }, sevenDay: { usedPct: 41, resetsAt: soon(40) }, updatedAt: soon(0) }
      : { reported: 'no' as const, fiveHour: null, sevenDay: null, updatedAt: soon(0) };
    dispatch({ type: 'accounts.loaded', accounts: accounts({ accounts: [account({ hosts: [accountHost({ host: 'cedar' })], limits: reading })] }) });
  }, [dispatch, limits]);
  return <>{children}</>;
}

describe('RoomPanel account line', () => {
  it('shows the room’s limits and opens the accounts drawer', async () => {
    const dispatch = vi.fn();
    const { user } = await renderPage(<WithAccounts limits="yes"><RoomPanel snapshot={snapshotOf()} roomId="cedar" dispatch={dispatch} /></WithAccounts>,
      { overview: fleetOverview() });
    await user.click(screen.getByRole('button', { name: /5h 62% · week 41%/ }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'open', panel: 'accounts' });
  });

  it('says when the plan does not report limits', async () => {
    await renderPage(<WithAccounts limits="no"><RoomPanel snapshot={snapshotOf()} roomId="cedar" dispatch={vi.fn()} /></WithAccounts>,
      { overview: fleetOverview() });
    expect(screen.getByRole('button', { name: /This plan does not report limits/ })).toBeTruthy();
  });

  it('shows no account line without accounts (an older hub)', async () => {
    await renderPage(<RoomPanel snapshot={snapshotOf()} roomId="cedar" dispatch={vi.fn()} />, { overview: fleetOverview() });
    expect(screen.queryByRole('button', { name: /Account/ })).toBeNull();
  });
});
