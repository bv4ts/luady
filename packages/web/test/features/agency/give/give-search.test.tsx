import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GivePicker } from '../../../../src/features/agency/give/GivePicker.js';
import { GIVE_SEARCH_AFTER, filterGiveRooms, giveTargets } from '../../../../src/features/agency/give/targets.js';
import { server, session } from '../../../fixtures.js';
import { manyRooms } from '../../../room-fixtures.js';

const officeOf = (n: number) => {
  const rooms = manyRooms(n);
  const servers = rooms.map((room) => server({ name: room.host ?? room.id }));
  const sessions = [session({ id: 'site-3:cc-shop:0.0', host: 'site-3', displayName: 'shop checkout' })];
  return giveTargets(rooms, servers, sessions);
};

const picker = (n: number) => render(
  <GivePicker label="card #4" targets={officeOf(n)} busy={false} onChoose={vi.fn()} onClose={vi.fn()} />,
);

describe('"Give to…" with many servers: a search box', () => {
  it(`shows no search for ${GIVE_SEARCH_AFTER} servers, and one from ${GIVE_SEARCH_AFTER + 1} on`, () => {
    const few = picker(GIVE_SEARCH_AFTER);
    expect(screen.queryByTestId('give-search')).toBeNull();
    few.unmount();
    picker(GIVE_SEARCH_AFTER + 1);
    expect(screen.getByTestId('give-search')).toBeTruthy();
  });

  it('narrows the rooms by room, server or session name as the owner types', () => {
    picker(12);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByTestId('give-search'), { target: { value: 'Site 11' } });
    expect(within(dialog).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Site 11']);
    fireEvent.change(screen.getByTestId('give-search'), { target: { value: 'checkout' } });
    expect(within(dialog).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Site 3']);
    fireEvent.change(screen.getByTestId('give-search'), { target: { value: 'nothing like it' } });
    expect(within(dialog).queryAllByRole('region')).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('Nothing matches. Try another name.');
  });

  it('filters by server id too and keeps everything for an empty search', () => {
    const rooms = officeOf(10).rooms;
    expect(filterGiveRooms(rooms, '  ')).toBe(rooms);
    expect(filterGiveRooms(rooms, 'SITE-10').map((room) => room.server)).toEqual(['site-10']);
  });
});
