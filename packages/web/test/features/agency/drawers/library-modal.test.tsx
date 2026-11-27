import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { LibraryModal } from '../../../../src/features/agency/drawers/library/LibraryModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { LIBRARY_NOT_READY } from '../../../../src/features/agency/drawers/library/library-error.js';
import { KIT_TOO_OLD } from '../../../../src/features/agency/drawers/library/SkillsTab.js';
import { overview, session } from '../../../fixtures.js';
import { fakeApi, type FakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { AT, PAGES, QUIET_STORE, fullPage, library } from './library-jira-fixtures.js';

function api(over: Partial<Parameters<typeof fakeApi>[0]> = {}): FakeApi {
  return fakeApi({
    ...QUIET_STORE,
    library: async () => library(),
    kbPages: async () => ({ items: [...PAGES], syncedAt: { birch: AT, cedar: null } }),
    kbPage: async (id) => fullPage({ id }),
    memoryFiles: async () => ({ files: [] }),
    ...over,
  });
}

async function open(fake: FakeApi = api(), dispatch?: (action: unknown) => void) {
  const sessions = [session({ id: 'birch:web:0.0', host: 'birch', cwd: '/home/dev/projects/orchard-web', displayName: 'checkout', state: 'working' })];
  const modal = <LibraryModal onClose={() => undefined} />;
  const page = dispatch === undefined ? modal : <GiveProvider stage={null} dispatch={dispatch}>{modal}</GiveProvider>;
  return renderPage(page, { api: fake, overview: { ...overview(), rooms: classicRoomDtos(), sessions } });
}

// Each test walks a whole flow (several requests and a PIN prompt); a busy machine needs more than 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

describe('LibraryModal', () => {
  it('opens on Projects, grouped by office in reading order', async () => {
    await open();
    const offices = await screen.findAllByRole('region', { name: /^(Orchard|Meadow)$/ });
    expect(offices.map((region) => region.getAttribute('aria-label'))).toEqual(['Orchard', 'Meadow']);
    const birch = within(offices[0] as HTMLElement);
    expect(birch.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Open orchard-api', 'Open orchard-web']);
    expect(birch.getByText('2 sessions now · 3 open cards · 1 page')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Projects' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows skills per office grouped by source, Luady first, and the kit line when an office has none listed', async () => {
    const { user } = await open();
    await screen.findAllByRole('region', { name: 'Orchard' });
    await user.click(screen.getByRole('tab', { name: 'Skills' }));
    const birch = within(screen.getByTestId('skills-birch'));
    expect(birch.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Yours 1', 'In a project 1', 'From plug-ins 1']);
    expect(within(screen.getByTestId('skills-cedar')).getByText(KIT_TOO_OLD)).toBeTruthy();
    expect(within(screen.getByTestId('skills-manager')).getByText('board')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Find a skill' }), 'distinctive');
    expect(birch.queryByText('cc-prompt')).toBeNull();
    expect(birch.getByText('frontend-design')).toBeTruthy();
  });

  it('puts pages on shelves and shows when the servers got their copy', async () => {
    const { user, api: fake } = await open();
    await user.click(screen.getByRole('tab', { name: 'Knowledge' }));
    await screen.findByTestId('shelf-global');
    expect(screen.getAllByRole('region').filter((r) => r.dataset.testid?.startsWith('shelf-')).map((r) => r.getAttribute('aria-label')))
      .toEqual(['Everyone', 'Orchard', 'Orchard · orchard-web', 'Meadow']);
    expect(screen.getByText('Meadow · not yet')).toBeTruthy();
    fake.syncKb.mockResolvedValue({ ok: true });
    await user.click(screen.getByRole('button', { name: /Sync now/ }));
    expect(fake.syncKb).toHaveBeenCalledWith();
  });

  it('creates a project page with the scope it needs', async () => {
    const fake = api({
      createKbPage: async (body) => fullPage({ id: 9, title: body.title, body: body.body }),
      kbPage: async (id) => fullPage(id === 9 ? { id, title: 'Checkout rules' } : { id }),
    });
    const { user } = await open(fake);
    await user.click(screen.getByRole('tab', { name: 'Knowledge' }));
    await user.click(await screen.findByRole('button', { name: /New page/ }));
    await user.click(screen.getByRole('button', { name: 'Save page' }));
    expect(screen.getByText('Give the page a title.')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Checkout rules');
    await user.click(screen.getByRole('radio', { name: 'One project' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Office' }), 'birch');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'orchard-web');
    await user.type(screen.getByRole('textbox', { name: /Tags/ }), 'web, money');
    await user.type(screen.getByRole('textbox', { name: 'Page text (Markdown)' }), 'Totals include **fees**.');
    expect(within(screen.getByLabelText('Preview')).getByText('fees').tagName).toBe('STRONG');
    await user.click(screen.getByRole('button', { name: 'Save page' }));
    expect(fake.createKbPage).toHaveBeenCalledWith({
      scope: 'project', server: 'birch', project: 'orchard-web', title: 'Checkout rules', body: 'Totals include **fees**.', tags: ['web', 'money'],
    });
    expect(await screen.findByRole('article', { name: 'Checkout rules' })).toBeTruthy();
  });

  it('reads, edits, pins and deletes a page', async () => {
    const fake = api({
      updateKbPage: async (id, body) => fullPage({ id, ...(body.body === undefined ? {} : { body: body.body }), pinned: body.pinned ?? false }),
      deleteKbPage: async () => ({ ok: true }),
    });
    const { user } = await open(fake);
    await user.click(screen.getByRole('tab', { name: 'Knowledge' }));
    await user.click(await screen.findByRole('button', { name: /^House rules/ }));
    const reader = await screen.findByRole('article', { name: 'House rules' });
    expect(within(reader).getByText('Always run the tests.')).toBeTruthy();
    expect(within(reader).getByText(/^Changed by you/)).toBeTruthy();

    await user.click(within(reader).getByRole('button', { name: 'Pin' }));
    expect(fake.updateKbPage).toHaveBeenLastCalledWith(1, { pinned: true });

    await user.click(await screen.findByRole('button', { name: /Edit/ }));
    const body = screen.getByRole('textbox', { name: 'Page text (Markdown)' });
    await user.clear(body);
    await user.type(body, 'New rules.');
    await user.click(screen.getByRole('button', { name: 'Save page' }));
    expect(fake.updateKbPage).toHaveBeenLastCalledWith(1, { title: 'House rules', body: 'New rules.', tags: ['rules'] });

    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Delete page' }));
    expect(fake.deleteKbPage).toHaveBeenCalledWith(1);
    await waitFor(() => expect(screen.queryByRole('article', { name: 'House rules' })).toBeNull());
  });

  it('a session listed under a project opens its agent view through the office page', async () => {
    const dispatch = vi.fn();
    const { user } = await open(api(), dispatch);
    await user.click(await screen.findByRole('button', { name: 'Open orchard-web' }));
    await user.click(screen.getByRole('button', { name: /Open checkout/ }));
    expect(dispatch.mock.calls).toEqual([[{ type: 'modal.close' }], [{ type: 'select', id: 'birch:web:0.0' }]]);
  });

  it('opens a project to its pages and sessions, starts a session there and adds a card', async () => {
    const fake = api({
      createSession: async () => ({ id: 'A1', actor: 'owner', channel: 'web', kind: 'session.start', tier: 0, summary: 's', status: 'done', createdAt: AT, decidedAt: AT, result: null, error: null }),
      createCard: async (body) => ({
        id: 31, title: body.title, details: '', project: body.project ?? null, server: body.server ?? null, source: 'web', sourceRef: null, state: 'open',
        today: false, priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: AT, updatedAt: AT, doneAt: null, dueAt: null, snoozeUntil: null,
      }),
    });
    const { user } = await open(fake);
    await user.click(await screen.findByRole('button', { name: 'Open orchard-web' }));
    expect(fake.kbPages).toHaveBeenLastCalledWith({ scope: 'project', server: 'birch', project: 'orchard-web' });
    expect(screen.getByText('checkout')).toBeTruthy();
    expect(screen.getByText('working')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /New session here/ }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'fees');
    await user.type(screen.getByRole('textbox', { name: /First prompt/ }), 'Fix the totals');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(fake.createSession).toHaveBeenCalledWith({ server: 'birch', cwd: '/home/dev/projects/orchard-web', name: 'fees', prompt: 'Fix the totals' });

    await user.click(screen.getByRole('button', { name: /Add a card/ }));
    await user.type(screen.getByRole('textbox', { name: 'What needs doing' }), 'Check the fee rounding');
    await user.click(screen.getByRole('button', { name: 'Add to board' }));
    expect(fake.createCard).toHaveBeenCalledWith({ title: 'Check the fee rounding', project: 'orchard-web', server: 'birch' });
    expect(await screen.findByText('Added #31 to the board.')).toBeTruthy();
  });

  it('says so when the hub has no library yet', async () => {
    await open(api({ library: async () => { throw new ApiError(501, 'not_built_yet', 'x'); } }));
    expect(await screen.findByText(LIBRARY_NOT_READY)).toBeTruthy();
  });
});
