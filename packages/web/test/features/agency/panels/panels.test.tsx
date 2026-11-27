import type { OverviewDTO } from '@luady/shared';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '../../../../src/features/agency/panels/AgentPanel.js';
import { LuadyPanel } from '../../../../src/features/agency/panels/LuadyPanel.js';
import { RackPanel } from '../../../../src/features/agency/panels/RackPanel.js';
import { RoomPanel } from '../../../../src/features/agency/panels/RoomPanel.js';
import { item, luadyStatus, permission, server } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { agent, askOf, fleet, fleetOverview, snapshotOf } from '../agency-fixtures.js';

const crowd = Array.from({ length: 21 }, (_, i) => agent('birch', `a${String(i + 1).padStart(2, '0')}`, { state: i === 2 ? 'waiting_question' : 'working', pendingQid: i === 2 ? 'QCROWD01' : null }));

describe('RoomPanel', () => {
  it('lists the agents with their state in words, marks the one waiting, and selects on click', async () => {
    const dispatch = vi.fn();
    const { user } = await renderPage(<RoomPanel snapshot={snapshotOf()} roomId="ash" dispatch={dispatch} />, { overview: fleetOverview() });
    expect(screen.getByRole('heading', { name: 'Harbor' })).toBeTruthy();
    expect(screen.getByText('Server ash is online')).toBeTruthy();
    const row = screen.getByRole('button', { name: /harbor-web/ });
    expect(row.textContent).toContain('waiting for you');
    expect(within(row).getByText('Needs you')).toBeTruthy();
    await user.click(row);
    expect(dispatch).toHaveBeenCalledWith({ type: 'select', id: 'ash:harbor-web' });
  });

  it('lists who did not fit and links to all sessions', async () => {
    const overview: OverviewDTO = fleetOverview({ sessions: crowd, questions: [askOf('birch:a03', 'QCROWD01')] });
    const snapshot = snapshotOf({ sessions: crowd, questions: overview.questions });
    await renderPage(<RoomPanel snapshot={snapshot} roomId="birch" dispatch={vi.fn()} />, { overview });
    expect(screen.getAllByRole('listitem').filter((li) => li.querySelector('.agency-row'))).toHaveLength(20);
    expect(screen.getByText('+1 more: a21')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all sessions' }).getAttribute('href')).toBe('/sessions');
  });

  it('says in words when the server is offline or connecting', async () => {
    const servers = fleet().map((s) => (s.name === 'cedar' ? { ...s, status: 'offline' as const } : s.name === 'ash' ? { ...s, status: 'connecting' as const } : s));
    const overview = fleetOverview({ servers });
    const snapshot = snapshotOf({ servers });
    const { unmount } = await renderPage(<RoomPanel snapshot={snapshot} roomId="cedar" dispatch={vi.fn()} />, { overview });
    expect(screen.getByText('Server cedar is offline')).toBeTruthy();
    expect(screen.getByText('This server is offline. What you see here may be out of date.').getAttribute('role')).toBe('status');
    unmount();
    await renderPage(<RoomPanel snapshot={snapshot} roomId="ash" dispatch={vi.fn()} />, { overview });
    expect(screen.getByText('Server ash is connecting')).toBeTruthy();
    expect(screen.getByText('Luady is reconnecting to this server. What you see here may be out of date.').getAttribute('role')).toBe('status');
  });

  it('opens the rack panel from the Server button', async () => {
    const dispatch = vi.fn();
    const { user } = await renderPage(<RoomPanel snapshot={snapshotOf()} roomId="cedar" dispatch={dispatch} />, { overview: fleetOverview() });
    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'stage', event: { type: 'fixture', fixture: 'rack', id: 'rack-cedar', room: 'cedar' } });
  });

  it('says when a spot has no room, and offers one there', async () => {
    // An empty slot is a lot of the rooms list; its panel offers a new room for that spot.
    const snapshot = snapshotOf({ rooms: classicRoomDtos().filter((room) => room.id !== 'ash') });
    const dispatch = vi.fn();
    const { user } = await renderPage(<RoomPanel snapshot={snapshot} roomId="lot-1" dispatch={dispatch} />);
    expect(screen.getByText('No room here yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a room here' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'modal', modal: { kind: 'rooms', position: 1 } });
    expect(screen.queryByRole('button', { name: 'Server' })).toBeNull();
  });
});

describe('AgentPanel', () => {
  const transcriptApi = () => fakeApi({
    transcript: async () => ({ items: [item({ uuid: 'u1', text: 'Working on the payroll export.' })], nextCursor: null }),
  });

  it('shows the header, the pending question card, the controls and the transcript', async () => {
    const { ws } = await renderPage(<AgentPanel snapshot={snapshotOf()} actorId="ash:harbor-web" />, { api: transcriptApi(), overview: fleetOverview() });
    expect(screen.getByRole('heading', { name: 'harbor-web' })).toBeTruthy();
    expect(screen.getByText('waiting for you')).toBeTruthy();
    expect(screen.getByTestId('question-card').getAttribute('data-qid')).toBe('QFIRST01');
    expect(screen.getByRole('toolbar', { name: 'Session controls' })).toBeTruthy();
    expect(await screen.findByText('Working on the payroll export.')).toBeTruthy();
    expect(screen.getByTestId('session-send-input')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open full page' }).getAttribute('href')).toBe(`/sessions/${encodeURIComponent('ash:harbor-web')}`);
    expect(ws.subscriptions.get('ash:harbor-web')).toBe(1);
  });

  it('shows a permission card for a permission request', async () => {
    const sessions = [agent('cedar', 'deployer', { state: 'waiting_permission', pendingQid: 'QPERM777' })];
    const questions = [permission({ qid: 'QPERM777', sessionId: 'cedar:deployer' })];
    await renderPage(<AgentPanel snapshot={snapshotOf({ sessions, questions })} actorId="cedar:deployer" />,
      { api: transcriptApi(), overview: fleetOverview({ sessions, questions }) });
    expect(screen.getByRole('article', { name: 'Permission request #QPERM777' })).toBeTruthy();
  });

  it('subscribes to the transcript only while the panel is open', async () => {
    function Toggle() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>close it</button>
          {open ? <AgentPanel snapshot={snapshotOf()} actorId="birch:app-backend" /> : null}
        </>
      );
    }
    const { ws, user, api } = await renderPage(<Toggle />, { api: transcriptApi(), overview: fleetOverview() });
    expect(ws.subscriptions.get('birch:app-backend')).toBe(1);
    expect(api.transcript).toHaveBeenCalledWith('birch:app-backend', null, 50);
    await user.click(screen.getByRole('button', { name: 'close it' }));
    expect(ws.subscriptions.has('birch:app-backend')).toBe(false);
  });

  it('says the agent left when it is no longer on the map', async () => {
    await renderPage(<AgentPanel snapshot={snapshotOf()} actorId="birch:gone" />, { api: transcriptApi(), overview: fleetOverview() });
    expect(screen.getByText('This agent has left the office.')).toBeTruthy();
  });
});

describe('RackPanel', () => {
  it('shows the server numbers with memory and disk in GB', async () => {
    await renderPage(<RackPanel snapshot={snapshotOf()} roomId="cedar" />, { overview: fleetOverview() });
    expect(screen.getByRole('heading', { name: 'Server cedar' })).toBeTruthy();
    const facts = screen.getByLabelText('Server numbers');
    expect(within(facts).getByText('online')).toBeTruthy();
    expect(within(facts).getByText('0.42 over 1 min, 0.31 over 5 min')).toBeTruthy();
    expect(within(facts).getByText('3.8 GB free of 7.6 GB')).toBeTruthy();
    expect(within(facts).getByText('20.0 GB')).toBeTruthy();
    expect(within(facts).getByText('10d 0h')).toBeTruthy();
    expect(within(facts).getByText('2.1.295')).toBeTruthy();
    expect(within(facts).getByText('1.0.0')).toBeTruthy();
    expect(within(facts).getByText('Oct 9, 4:00 PM')).toBeTruthy();
    expect(screen.queryByText('low')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open server page' }).getAttribute('href')).toBe('/servers/cedar');
  });

  it('marks tight memory in amber and a nearly full disk in red, like the rack lights', async () => {
    const tight = server({ name: 'cedar', sysinfo: { load1: 3, load5: 2, mem_total_kb: 8_000_000, mem_avail_kb: 1_000_000, disk_free_kb: 5_242_880, uptime_s: 3_600 } });
    const servers = [...fleet().filter((s) => s.name !== 'cedar'), tight];
    await renderPage(<RackPanel snapshot={snapshotOf({ servers })} roomId="cedar" />, { overview: fleetOverview({ servers }) });
    expect(screen.getByText('1.0 GB free of 7.6 GB').closest('dd')?.querySelector('.agency-warn--amber')?.textContent).toBe('low');
    expect(screen.getByText('5.0 GB').closest('dd')?.querySelector('.agency-warn--red')?.textContent).toBe('almost full');
  });

  it('says when the hub has no numbers yet', async () => {
    const servers = [...fleet().filter((s) => s.name !== 'birch'), server({ name: 'birch', sysinfo: null, status: 'connecting' })];
    await renderPage(<RackPanel snapshot={snapshotOf({ servers })} roomId="birch" />, { overview: fleetOverview({ servers }) });
    expect(screen.getByText('No numbers from this server yet.')).toBeTruthy();
    expect(screen.getByText('connecting')).toBeTruthy();
  });
});

describe('LuadyPanel', () => {
  it('shows his status in words, the queue and a link to the chat', async () => {
    const snapshot = snapshotOf({ luady: luadyStatus({ state: 'busy', queued: 2 }) });
    await renderPage(<LuadyPanel snapshot={snapshot} />);
    expect(screen.getByRole('heading', { name: 'Luady' })).toBeTruthy();
    expect(screen.getByText('thinking')).toBeTruthy();
    expect(screen.getByText('2 messages waiting')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open chat' }).getAttribute('href')).toBe('/manager');
  });
});
