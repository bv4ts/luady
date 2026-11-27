import type { ReactElement } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { FleetModal } from '../../../../src/features/agency/drawers/fleet/FleetModal.js';
import { LinksModal } from '../../../../src/features/agency/drawers/links/LinksModal.js';
import { ownerMs } from '../../../../src/features/agency/drawers/schedule/owner-time.js';
import { ScheduleModal } from '../../../../src/features/agency/drawers/schedule/ScheduleModal.js';
import { TimelineModal } from '../../../../src/features/agency/drawers/timeline/TimelineModal.js';
import { WinsModal } from '../../../../src/features/agency/drawers/wins/WinsModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { overview, question, server, session } from '../../../fixtures.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { fakeApi, type FakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { QUIET_STORE } from './library-jira-fixtures.js';
import { NOW, account, iso, link, win } from './wave2-fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

function api(over: FakeApiOverrides = {}): FakeApi {
  const live = account({ limits: { reported: 'yes', updatedAt: iso(Date.now()), fiveHour: { usedPct: 62, resetsAt: iso(Date.now() + 7_200_000) }, sevenDay: null } });
  return fakeApi({ ...QUIET_STORE, prefs: async () => { throw new ApiError(404, 'not_found', 'x'); }, accounts: async () => ({ accounts: [live], connections: [] }), ...over });
}

async function open(ui: ReactElement, fake: FakeApi) {
  const dispatch = vi.fn();
  const servers = [server({ name: 'birch' }), server({ name: 'cedar', status: 'offline', lastSeenAt: iso(ownerMs(2026, 11, 15, 9)) })];
  const sessions = [session({ id: 'birch:web:0.0', host: 'birch', displayName: 'checkout' })];
  const harness = await renderPage(<GiveProvider stage={null} dispatch={dispatch}>{ui}</GiveProvider>,
    { api: fake, overview: { ...overview(), rooms: classicRoomDtos(), servers, sessions, questions: [question({ sessionId: 'birch:web:0.0' })] } });
  return { ...harness, dispatch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FleetModal', () => {
  it('shows every server and account with graphs, opens a rack, and reloads once a minute', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const now = Math.floor(Date.now() / 1000);
    const fake = api({
      fleetHistory: async () => ({
        servers: [{ name: 'birch', points: [[now - 3600, 0.5, 40, 61], [now - 60, 1.5, 55, 62]] }, { name: 'cedar', points: [[now - 60, 0.2, 30, null]] }],
        accounts: [{ id: 'claude:org-1', label: 'Owner', points: [[now - 600, 50, null], [now - 60, 62, null]] }],
      }),
    });
    const { user, dispatch } = await open(<FleetModal onClose={() => undefined} />, fake);
    const servers = await screen.findByRole('region', { name: 'Servers' });
    expect(within(servers).getByText('Orchard')).toBeTruthy();
    expect(within(servers).getByText(/^Offline since/)).toBeTruthy();
    expect((await within(servers).findAllByRole('img', { name: /^load 0\.42/ })).length).toBe(2);
    expect(within(servers).getByText('no disk history on this kit')).toBeTruthy();
    const accounts = screen.getByRole('region', { name: 'Accounts' });
    expect(await within(accounts).findByText(/^5-hour: 62% · resets/)).toBeTruthy();
    expect(screen.getByText(/needs a look/)).toBeTruthy();

    await user.click(within(servers).getByRole('button', { name: 'Orchard: open the rack' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'modal.close' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'stage', event: { type: 'fixture', fixture: 'rack', id: 'rack-birch', room: 'birch' } });

    expect(fake.fleetHistory).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await waitFor(() => expect(fake.fleetHistory).toHaveBeenCalledTimes(2));
  });

  it('keeps the live numbers when the hub has no history yet', async () => {
    await open(<FleetModal onClose={() => undefined} />, api({ fleetHistory: async () => { throw new ApiError(501, 'not_built_yet', 'x'); } }));
    expect(await screen.findByText(/graphs need the next hub update/)).toBeTruthy();
    expect(screen.getByText('Orchard')).toBeTruthy();
  });
});

describe('WinsModal', () => {
  it('pins the week up by day with the office counts, and a photo opens its card', async () => {
    const fake = api({
      wins: async () => ({
        items: [win(4, Date.now() - 1, { links: ['https://github.com/o/r/pull/42'], result: 'Totals include fees.' }), win(5, Date.now() - 3 * 86_400_000, { server: 'cedar', project: 'meadow-vat' })],
        byServer: { birch: 1, cedar: 1 },
      }),
    });
    const { user, dispatch } = await open(<WinsModal onClose={() => undefined} />, fake);
    expect(await screen.findByText('2 shipped this week')).toBeTruthy();
    expect(fake.wins).toHaveBeenCalledWith(7);
    expect(screen.getByRole('list', { name: 'This week per office' }).textContent).toContain('Harbor · 0');
    expect(screen.getByRole('region', { name: 'Today' })).toBeTruthy();
    const pr = screen.getByRole('link', { name: 'Pull request #42' });
    expect(pr.getAttribute('rel')).toBe('noopener noreferrer');
    expect(pr.getAttribute('target')).toBe('_blank');
    await user.click(screen.getByRole('button', { name: /Win 4/ }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'modal', modal: { kind: 'board', itemId: 4 } });
  });

  it('an empty week says what to do', async () => {
    await open(<WinsModal onClose={() => undefined} />, api({ wins: async () => ({ items: [], byServer: {} }) }));
    expect(await screen.findByText('The wall is empty')).toBeTruthy();
  });
});

describe('TimelineModal', () => {
  it('draws today with marks and a list that open their things, and switches to yesterday', async () => {
    const at = (hour: number) => iso(Date.now() - hour * 3_600_000);
    const fake = api({
      timeline: async (day) => ({
        day: day ?? '2026-11-15',
        items: day === undefined || day.length === 0 ? [] : [
          { at: at(3), kind: 'started', label: 'checkout', server: 'birch', ref: { kind: 'session', id: 'birch:web:0.0' } },
          { at: at(2), kind: 'asked', label: 'Which coupon?', server: 'birch', ref: { kind: 'question', id: 'ABCDEFGH' } },
          { at: at(1), kind: 'done', label: 'Fix totals', server: 'birch', ref: { kind: 'todo', id: '12' } },
          { at: at(0.5), kind: 'alert', label: 'cedar went offline', server: 'cedar', ref: null },
        ],
      }),
    });
    const { user, dispatch } = await open(<TimelineModal onClose={() => undefined} />, fake);
    const mark = await screen.findByRole('button', { name: /Finished · Fix totals/ });
    await user.click(mark);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'modal', modal: { kind: 'board', itemId: 12 } });
    const row = screen.getByText('Fix totals').closest('button');
    expect(row).not.toBeNull();
    await user.click(row as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({ type: 'modal', modal: { kind: 'board', itemId: 12 } });
    await user.click(screen.getAllByRole('button', { name: /Asked you · Which coupon\?/ })[0] as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({ type: 'select', id: 'birch:web:0.0' });
    expect(screen.queryByRole('button', { name: /cedar went offline/ })).toBeNull();
    expect(screen.getAllByText(/cedar went offline/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Yesterday' }));
    const yesterday = fake.timeline.mock.calls.at(-1)?.[0];
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yesterday).not.toBe(fake.timeline.mock.calls[0]?.[0]);
  });
});

describe('ScheduleModal', () => {
  it('lists the next runs in words, adds a repeating reminder said back first, and cancels after a confirm', async () => {
    const fake = api({
      schedules: async () => ({ items: [{ id: 's1', when: '0 9 * * 1-5', task: 'Check the deploys', nextRunAt: iso(ownerMs(2030, 1, 7, 9)) }] }),
      addSchedule: async (body) => ({ id: 's2', when: body.when, task: body.task, nextRunAt: null }),
      cancelSchedule: async () => ({ ok: true }),
    });
    const { user } = await open(<ScheduleModal onClose={() => undefined} />, fake);
    const entry = await screen.findByRole('article', { name: 'Check the deploys' });
    expect(within(entry).getByText('Every weekday (Monday to Friday) at 9:00 AM')).toBeTruthy();
    expect(within(entry).getByText('Next: Jan 7, 2030, 9:00 AM')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '+ Add a reminder' }));
    const form = screen.getByRole('form', { name: 'A new reminder' });
    await user.type(within(form).getByLabelText('What should Luady do?'), 'Send the invoices');
    await user.click(within(form).getByRole('radio', { name: 'Every week' }));
    await user.selectOptions(within(form).getByLabelText('Day'), '4');
    const time = within(form).getByLabelText('Time (owner time)');
    await user.clear(time);
    await user.type(time, '17:30');
    expect(within(form).getByText('Every Thursday at 5:30 PM')).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Add to the calendar' }));
    expect(fake.addSchedule).toHaveBeenCalledWith({ when: '30 17 * * 4', task: 'Send the invoices' });

    await user.click(within(entry).getByRole('button', { name: 'Cancel…' }));
    expect(fake.cancelSchedule).not.toHaveBeenCalled();
    await user.click(within(entry).getByRole('button', { name: 'Cancel it' }));
    expect(fake.cancelSchedule).toHaveBeenCalledWith('s1');
  });

  it('refuses a task that is too short and a time that has passed', async () => {
    const fake = api({ schedules: async () => ({ items: [] }) });
    const { user } = await open(<ScheduleModal onClose={() => undefined} />, fake);
    expect(await screen.findByText('Nothing on the calendar')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '+ Add a reminder' }));
    const form = screen.getByRole('form', { name: 'A new reminder' });
    await user.click(within(form).getByRole('button', { name: 'Add to the calendar' }));
    expect(within(form).getByText(/Say what Luady should do/)).toBeTruthy();
    expect(fake.addSchedule).not.toHaveBeenCalled();
    void NOW;
  });
});

describe('LinksModal', () => {
  const items = [link(1, 'cedar', 0, { label: 'Jira', url: 'https://meadow-demo.atlassian.net/' }), link(2, 'cedar', 1, { label: 'Staging' }), link(3, 'birch', 0)];

  it("opens the office's links in a new tab, and edits: add, rename, reorder, remove", async () => {
    const fake = api({
      links: async () => ({ items }),
      createLink: async (body) => ({ id: 9, position: 2, ...body }),
      updateLink: async (id, body) => ({ ...(items.find((l) => l.id === id) ?? link(id, 'cedar', 0)), ...body }),
      deleteLink: async () => ({ ok: true }),
    });
    const { user } = await open(<LinksModal room="cedar" onClose={() => undefined} />, fake);
    const jira = await screen.findByRole('link', { name: /Jira/ });
    expect(jira.getAttribute('href')).toBe('https://meadow-demo.atlassian.net/');
    expect(jira.getAttribute('target')).toBe('_blank');
    expect(jira.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Link 3/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Add a link' });
    await user.type(within(form).getByLabelText('Name'), 'Figma');
    await user.type(within(form).getByLabelText('Address'), 'http://figma.com/file/x');
    await user.click(within(form).getByRole('button', { name: 'Pin it' }));
    expect(within(form).getByText('Only https:// links can go on the shelf.')).toBeTruthy();
    const address = within(form).getByLabelText('Address');
    await user.clear(address);
    await user.type(address, 'figma.com/file/x');
    await user.click(within(form).getByRole('button', { name: 'Pin it' }));
    expect(fake.createLink).toHaveBeenCalledWith({ server: 'cedar', label: 'Figma', url: 'https://figma.com/file/x' });

    await user.click(screen.getByRole('button', { name: 'Move Staging up' }));
    expect(fake.updateLink).toHaveBeenCalledWith(2, { position: 0 });
    expect(fake.updateLink).toHaveBeenCalledWith(1, { position: 1 });

    const card = screen.getByRole('group', { name: 'Edit Jira' });
    const name = within(card).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Jira board');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(fake.updateLink).toHaveBeenLastCalledWith(1, { label: 'Jira board' });

    await user.click(within(card).getByRole('button', { name: 'Remove Jira' }));
    await user.click(within(card).getByRole('button', { name: 'Remove' }));
    expect(fake.deleteLink).toHaveBeenCalledWith(1);
  });

  it('a room that is not an office shows Orchard, and an empty shelf invites the first link', async () => {
    await open(<LinksModal room="hq" onClose={() => undefined} />, api({ links: async () => ({ items: [] }) }));
    expect(await screen.findByText('No links yet')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Orchard links' })).toBeTruthy();
  });
});
