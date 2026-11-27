import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClock } from '../../../../src/features/agency/hud/Clock.js';
import { NeedsBell } from '../../../../src/features/agency/hud/NeedsBell.js';
import { RoomChips } from '../../../../src/features/agency/hud/RoomChips.js';
import { TopBar } from '../../../../src/features/agency/hud/TopBar.js';
import { INITIAL_UI } from '../../../../src/features/agency/model/ui-state.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { agent, askOf, fleet, snapshotOf } from '../agency-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomChips', () => {
  it('shows one chip per occupied corner and HQ, with agent counts and waiting dots', () => {
    const snapshot = snapshotOf();
    render(<RoomChips snapshot={snapshot} focus={INITIAL_UI.focus} dispatch={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Rooms' });
    // The Rooms menu button comes first; the chips follow it.
    expect(within(group).getByTestId('rooms-menu-button').textContent).toContain('Rooms');
    const names = within(group).getAllByRole('button').filter((button) => button.dataset.testid !== 'rooms-menu-button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual([
      'Whole office',
      'Orchard, 2 sessions',
      'Harbor, 1 session, 1 waiting for you',
      'Luady HQ',
      'Meadow, 1 session',
      'Private Projects, 1 session',
    ]);
    const harbor = within(group).getByRole('button', { name: /^Harbor/ });
    expect(harbor.textContent).toBe('Harbor11');
    expect(harbor.querySelector('.agency-chip__need')?.textContent).toBe('1');
    expect(within(group).getByRole('button', { name: 'Whole office' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says in words when the server of a room is offline or connecting', () => {
    const servers = fleet().map((s) => (s.name === 'birch' ? { ...s, status: 'offline' as const } : s.name === 'cedar' ? { ...s, status: 'connecting' as const } : s));
    render(<RoomChips snapshot={snapshotOf({ servers })} focus={INITIAL_UI.focus} dispatch={vi.fn()} />);
    const birch = screen.getByRole('button', { name: 'Orchard, offline, 2 sessions' });
    expect(birch.querySelector('.agency-chip__link')?.textContent).toBe('offline');
    expect(birch.classList.contains('agency-chip--down')).toBe(true);
    expect(screen.getByRole('button', { name: /^Meadow, connecting/ }).querySelector('.agency-chip__link')?.textContent).toBe('connecting');
    expect(screen.getByRole('button', { name: /^Harbor/ }).querySelector('.agency-chip__link')).toBeNull();
  });

  it('skips empty slots', () => {
    // A missing room is an empty slot (a lot) of the rooms list.
    const snapshot = snapshotOf({ rooms: classicRoomDtos().filter((room) => room.id !== 'ash') });
    render(<RoomChips snapshot={snapshot} focus={INITIAL_UI.focus} dispatch={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Harbor|Vacant/ })).toBeNull();
  });

  it('presses the focused room and focuses a room or the whole office on click', async () => {
    const dispatch = vi.fn();
    const user = userEvent.setup();
    render(<RoomChips snapshot={snapshotOf()} focus={{ kind: 'room', room: 'cedar' }} dispatch={dispatch} />);
    expect(screen.getByRole('button', { name: /^Meadow/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Whole office' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: /^Orchard/ }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'focus', focus: { kind: 'room', room: 'birch' } });
    await user.click(screen.getByRole('button', { name: 'Whole office' }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'focus', focus: { kind: 'all' } });
  });

  it('presses the room of a focused agent', () => {
    render(<RoomChips snapshot={snapshotOf()} focus={{ kind: 'actor', id: 'cedar:meadow-vat' }} dispatch={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Meadow/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('NeedsBell', () => {
  it('is hidden when nobody waits', () => {
    const { container } = render(<NeedsBell needs={[]} dispatch={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('says "1 needs you" and "3 need you"', () => {
    const { rerender } = render(<NeedsBell needs={['a']} dispatch={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toBe('1 needs you');
    rerender(<NeedsBell needs={['a', 'b', 'c']} dispatch={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toBe('3 need you');
  });

  it('dispatches next-need with the snapshot needs when clicked', async () => {
    const sessions = ['one', 'two', 'three'].map((name, i) => agent('birch', name, { state: 'waiting_question', pendingQid: `QNEED00${i}` }));
    const snapshot = snapshotOf({ sessions, questions: sessions.map((s, i) => askOf(s.id, `QNEED00${i}`, i)) });
    const dispatch = vi.fn();
    render(<NeedsBell needs={snapshot.needs} dispatch={dispatch} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '3 need you' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'next-need', needs: snapshot.needs });
    expect(snapshot.needs).toEqual(['birch:one', 'birch:two', 'birch:three']);
  });
});

describe('Clock', () => {
  it('formats owner time as "3:20 PM"', () => {
    expect(formatClock(Date.parse('2026-11-14T11:20:00Z'))).toBe('3:20 PM');
    expect(formatClock(Date.parse('2026-11-14T20:05:00Z'))).toBe('12:05 AM');
  });

  it('shows the time in the top bar and moves on each minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.parse('2026-11-14T11:20:30Z'));
    render(<MemoryRouter><TopBar snapshot={snapshotOf()} ui={INITIAL_UI} dispatch={vi.fn()} live /></MemoryRouter>);
    expect(screen.getByText('3:20 PM')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByText('3:21 PM')).toBeTruthy();
  });
});

describe('TopBar', () => {
  it('carries the brand, the rooms, the bell and the classic view link', () => {
    render(<MemoryRouter><TopBar snapshot={snapshotOf()} ui={INITIAL_UI} dispatch={vi.fn()} live={false} /></MemoryRouter>);
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('group', { name: 'Rooms' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '1 needs you' })).toBeTruthy();
    expect(within(bar).getByTestId('agency-classic-link').getAttribute('href')).toBe('/inbox');
    expect(within(bar).getByRole('img', { name: 'Not connected' })).toBeTruthy();
  });
});
