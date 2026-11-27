import type { BoardItemDTO } from '@luady/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { BoardModal } from '../../../../src/features/agency/drawers/board/BoardModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { overview } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { card } from './board-fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function setup(cards: readonly BoardItemDTO[], itemId?: number) {
  const api = fakeApi({
    activity: async () => ({ items: [] }), notices: async () => ({ items: [] }), said: async () => ({ items: [] }),
    presence: async () => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }),
    prefs: async () => { throw new ApiError(404, 'not_found', 'x'); },
    board: async () => ({ items: [...cards] }), missions: async () => ({ items: [] }),
    card: async (id) => ({ item: cards.find((c) => c.id === id) ?? card(id), events: [], mission: null }),
    projects: async () => [],
    updateCard: async (id, body) => ({ ...(cards.find((c) => c.id === id) ?? card(id)), ...body } as BoardItemDTO),
  });
  return renderPage(<GiveProvider stage={null}><BoardModal {...(itemId === undefined ? {} : { itemId })} onClose={vi.fn()} /></GiveProvider>, { api, overview: overview() })
    .then((page) => ({ ...page, api }));
}

describe('snooze and due on board cards', () => {
  it('"Remind me…" offers fixed times and sets snoozeUntil; a date and time works too', async () => {
    const { user, api } = await setup([card(1, { title: 'Pay the invoices' })], 1);
    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Remind me…' }));
    const menu = within(sheet).getByRole('menu', { name: 'Remind me' });
    expect(within(menu).getByRole('menuitem', { name: 'Tomorrow, 9:00 AM' })).toBeTruthy();
    await user.click(within(menu).getByRole('menuitem', { name: 'Tomorrow, 9:00 AM' }));
    const body = api.updateCard.mock.calls.at(-1)?.[1] as { snoozeUntil: string };
    const at = new Date(Date.parse(body.snoozeUntil) + 4 * HOUR);
    expect([at.getUTCHours(), at.getUTCMinutes()]).toEqual([9, 0]);
    expect(await within(sheet).findByText(/^Back Tomorrow, 9:00 AM$/)).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Bring back now' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { snoozeUntil: null });

    await user.click(await within(sheet).findByRole('button', { name: 'Remind me…' }));
    await user.click(within(sheet).getByRole('menuitem', { name: 'A date and time…' }));
    const pick = within(sheet).getByRole('group', { name: 'Remind me at' });
    const date = within(pick).getByLabelText('Date');
    await user.clear(date);
    await user.type(date, '2030-01-07');
    const time = within(pick).getByLabelText('Time (owner time)');
    await user.clear(time);
    await user.type(time, '18:45');
    await user.click(within(pick).getByRole('button', { name: 'Remind me then' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { snoozeUntil: '2030-01-07T18:45:00+04:00' });
  });

  it('sets, shows and clears a due date; a passed one is red on the card', async () => {
    const past = iso(Date.now() - 2 * HOUR);
    const { user, api } = await setup([card(1, { title: 'Late one', dueAt: past }), card(2, { title: 'No date' })], 2);
    const late = await screen.findByRole('article', { name: 'Late one' });
    const chip = within(late).getByText(/^Overdue · /);
    expect(chip.className).toContain('due-chip--past');

    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Set a due date' }));
    const pick = within(sheet).getByRole('group', { name: 'Due' });
    const date = within(pick).getByLabelText('Date');
    await user.clear(date);
    await user.type(date, '2030-01-08');
    const time = within(pick).getByLabelText('Time (owner time)');
    await user.clear(time);
    await user.type(time, '09:00');
    await user.click(within(pick).getByRole('button', { name: 'Set due date' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(2, { dueAt: '2030-01-08T09:00:00+04:00' });
    expect(await within(sheet).findByText(/^Due Jan 8, 2030, 9:00 AM$/)).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Clear' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(2, { dueAt: null });
  });

  it('keeps snoozed cards in the Later drawer with "Bring back now"', async () => {
    const back = iso(Date.now() + 20 * HOUR);
    const { user, api } = await setup([card(1, { title: 'Visible' }), card(2, { title: 'Hidden for now', snoozeUntil: back })]);
    await screen.findByRole('article', { name: 'Visible' });
    expect(screen.queryByRole('article', { name: 'Hidden for now' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Later: 1 card/ }));
    const later = screen.getByRole('list', { name: 'Cards for later' });
    expect(within(later).getByText('Hidden for now')).toBeTruthy();
    expect(within(later).getByText(/^Back /)).toBeTruthy();
    await user.click(within(later).getByRole('button', { name: 'Bring back now' }));
    expect(api.updateCard).toHaveBeenCalledWith(2, { snoozeUntil: null });
    expect(await screen.findByRole('article', { name: 'Hidden for now' })).toBeTruthy();
  });
});
