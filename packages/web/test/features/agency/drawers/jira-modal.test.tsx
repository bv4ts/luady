import type { JiraIssueDetailDTO } from '@luady/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { JiraModal } from '../../../../src/features/agency/drawers/jira/JiraModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { overview, server, session } from '../../../fixtures.js';
import { fakeApi, type FakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { AT, QUIET_STORE, board, detail, site } from './library-jira-fixtures.js';

const REFUSED = 'Jira refused the sign-in. The token may have expired.';

function api(over: FakeApiOverrides = {}): FakeApi {
  return fakeApi({
    ...QUIET_STORE,
    jiraSites: async () => ({ sites: [site()] }),
    jiraBoard: async (_server, view) => board({ view: view ?? 'sprint' }),
    jiraIssue: async () => detail(),
    ...over,
  });
}

async function open(fake: FakeApi = api(), issueKey?: string) {
  const sessions = [session({ id: 'birch:web:0.0', host: 'birch', displayName: 'checkout', state: 'idle' })];
  return renderPage(
    <GiveProvider stage={null}><JiraModal room="birch" {...(issueKey === undefined ? {} : { issueKey })} onClose={() => undefined} /></GiveProvider>,
    { api: fake, overview: { ...overview(), rooms: classicRoomDtos(), servers: [server(), server({ name: 'birch' }), server({ name: 'ash' })], sessions } },
  );
}

async function pin(user: Awaited<ReturnType<typeof open>>['user'], title: string) {
  const dialog = await screen.findByRole('dialog', { name: title }, { timeout: 5000 });
  await user.type(within(dialog).getByLabelText('PIN'), '246813');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
}

// Each test walks a whole flow (several requests and a PIN prompt); a busy machine needs more than 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

describe('JiraModal: connecting', () => {
  it('shows the connect form when the office is not connected, checks it, and sends the token only in the PIN-confirmed body', async () => {
    const fake = api({ jiraSites: async () => ({ sites: [] }), connectJira: async () => site() });
    const { user } = await open(fake);
    const form = await screen.findByRole('form', { name: 'Connect Jira to Orchard' });
    expect(within(form).getByRole('link', { name: "Atlassian's API token page" }).getAttribute('href')).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
    const token = screen.getByTestId('jira-token') as HTMLInputElement;
    expect(token.type).toBe('password');

    await user.click(within(form).getByRole('button', { name: 'Connect' }));
    expect(within(form).getByText(/Type your Jira address/)).toBeTruthy();
    expect(within(form).getByText('Paste the API token.')).toBeTruthy();
    expect(fake.connectJira).not.toHaveBeenCalled();

    await user.type(within(form).getByLabelText('Jira address'), 'orchard-demo.atlassian.net');
    await user.type(within(form).getByLabelText('E-mail you sign in with'), 'owner@example.com');
    await user.type(token, 'test-token-secret-1234');
    await user.click(within(form).getByRole('button', { name: 'Connect' }));
    await pin(user, 'Connect Jira to Orchard');
    expect(fake.connectJira).toHaveBeenCalledWith('birch', {
      baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', token: 'test-token-secret-1234', pin: '246813',
    });
    expect(await screen.findByRole('tab', { name: 'My sprint' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('test-token-secret-1234');
  });

  it('shows the hub refusing the sign-in in plain words and empties the token field', async () => {
    const fake = api({ jiraSites: async () => ({ sites: [] }), connectJira: async () => { throw new ApiError(400, 'jira_auth_failed', REFUSED); } });
    const { user } = await open(fake);
    const form = await screen.findByRole('form', { name: 'Connect Jira to Orchard' });
    await user.type(within(form).getByLabelText('Jira address'), 'https://orchard-demo.atlassian.net');
    await user.type(within(form).getByLabelText('E-mail you sign in with'), 'owner@example.com');
    await user.type(screen.getByTestId('jira-token'), 'test-token-secret-1234');
    await user.click(within(form).getByRole('button', { name: 'Connect' }));
    await pin(user, 'Connect Jira to Orchard');
    expect(await within(form).findByText(REFUSED)).toBeTruthy();
    expect((screen.getByTestId('jira-token') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain('test-token-secret-1234');
  });

  it('a connection whose sign-in Jira refused says so and offers to sign in again with the site filled in', async () => {
    const { user } = await open(api({ jiraSites: async () => ({ sites: [site({ lastError: REFUSED })] }) }));
    const banner = (await screen.findAllByRole('alert')).find((node) => node.textContent?.includes(REFUSED));
    expect(banner).toBeTruthy();
    await user.click(within(banner as HTMLElement).getByRole('button', { name: 'Sign in again' }));
    const form = await screen.findByRole('form', { name: 'Connect Jira to Orchard' });
    expect((within(form).getByLabelText('Jira address') as HTMLInputElement).value).toBe('https://orchard-demo.atlassian.net');
    expect((within(form).getByLabelText('E-mail you sign in with') as HTMLInputElement).value).toBe('owner@example.com');
  });

  it('a board that answers jira_not_connected turns into the connect form', async () => {
    await open(api({ jiraBoard: async () => { throw new ApiError(409, 'jira_not_connected', 'x'); } }));
    expect(await screen.findByRole('form', { name: 'Connect Jira to Orchard' })).toBeTruthy();
  });

  it('disconnects behind the menu, a question and the PIN', async () => {
    const fake = api({ disconnectJira: async () => ({ ok: true }) });
    const { user } = await open(fake);
    await screen.findByRole('tab', { name: 'My sprint' });
    await user.click(screen.getByRole('button', { name: 'Jira connection' }));
    await user.click(screen.getByRole('menuitem', { name: 'Disconnect…' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await pin(user, 'Disconnect Jira from Orchard');
    expect(fake.disconnectJira).toHaveBeenCalledWith('birch', '246813');
    expect(await screen.findByRole('form', { name: 'Connect Jira to Orchard' })).toBeTruthy();
  });
});

describe('JiraModal: the board', () => {
  it('lays the tickets out in status columns and switches views', async () => {
    const fake = api();
    const { user } = await open(fake);
    const columns = await screen.findByLabelText('Status columns');
    const sections = within(columns).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['To Do', 'In Progress', 'Done']);
    expect(within(sections[1] as HTMLElement).getByText('New changes')).toBeTruthy();
    expect(screen.getByText('Sprint 42')).toBeTruthy();
    expect(fake.jiraBoard).toHaveBeenLastCalledWith('birch', 'sprint');

    await user.click(screen.getByRole('tab', { name: 'Needs attention' }));
    expect(fake.jiraBoard).toHaveBeenLastCalledWith('birch', 'attention');
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(fake.jiraBoard).toHaveBeenLastCalledWith('birch', 'attention', true);
  });

  it('says when My sprint fell back to all open tickets, and when nothing is there', async () => {
    const { user } = await open(api({ jiraBoard: async (_s, view) => (view === 'sprint' ? board({ view: 'mine', sprint: null }) : board({ view: view ?? 'mine', issues: [], columns: [] })) }));
    expect(await screen.findByText(/Nothing of yours in an open sprint/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Needs attention' }));
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeTruthy();
  });
});

describe('JiraModal: a ticket opened', () => {
  const moved = (over: Partial<JiraIssueDetailDTO> = {}) => async () => detail(over);

  it('shows the ticket with its Markdown made safe', async () => {
    await open(api(), 'ORC-101');
    const ticket = await screen.findByRole('complementary', { name: 'Ticket ORC-101' });
    expect(within(ticket).getByText('total').tagName).toBe('STRONG');
    expect(ticket.querySelector('script')).toBeNull();
    expect(within(ticket).getByText('iOS').tagName).toBe('EM');
    expect(within(ticket).getByRole('link', { name: /Open in Jira/ }).getAttribute('href')).toBe('https://orchard-demo.atlassian.net/browse/ORC-101');
    expect(within(ticket).getByText('ORC-110')).toBeTruthy();
    expect(within(ticket).getByText('Nov 20, 2026')).toBeTruthy();
  });

  it('moves, comments, edits and assigns, each showing the fresh ticket', async () => {
    const fake = api({
      transitionJira: moved({ status: { name: 'In Progress', category: 'doing' } }),
      commentJira: moved({ comments: [{ id: 'c2', author: 'Owner', at: AT, bodyMd: 'On it.' }] }),
      editJira: async (_s, _k, body) => detail({ ...(body.summary === undefined ? {} : { summary: body.summary }), ...(body.priority === undefined ? {} : { priority: body.priority }), ...(body.labels === undefined ? {} : { labels: body.labels }), ...(body.description === undefined ? {} : { descriptionMd: body.description }) }),
      assignJira: async (_s, _k, me) => detail({ assignee: me ? 'Owner' : null }),
    });
    const { user } = await open(fake, 'ORC-101');
    const ticket = await screen.findByRole('complementary', { name: 'Ticket ORC-101' });
    const t = within(ticket);

    await user.selectOptions(t.getByLabelText('Move to'), '21');
    await user.click(t.getByRole('button', { name: 'Move' }));
    expect(fake.transitionJira).toHaveBeenCalledWith('birch', 'ORC-101', '21');
    expect(await t.findByText('In Progress')).toBeTruthy();

    await user.type(t.getByLabelText('Add a comment'), 'On it.');
    await user.click(t.getByRole('button', { name: 'Comment' }));
    expect(fake.commentJira).toHaveBeenCalledWith('birch', 'ORC-101', 'On it.');
    expect(await t.findByText('On it.')).toBeTruthy();
    expect((t.getByLabelText('Add a comment') as HTMLTextAreaElement).value).toBe('');

    await user.click(t.getByRole('button', { name: 'Edit summary' }));
    const summary = t.getByLabelText('Summary');
    await user.clear(summary);
    await user.type(summary, 'Checkout total skips fees');
    await user.click(t.getByRole('button', { name: 'Save summary' }));
    expect(fake.editJira).toHaveBeenLastCalledWith('birch', 'ORC-101', { summary: 'Checkout total skips fees' });
    expect(await t.findByRole('heading', { name: 'Checkout total skips fees' })).toBeTruthy();

    await user.click(t.getByRole('button', { name: 'Edit description' }));
    const description = t.getByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.type(description, 'Fees are left out.');
    await user.click(t.getByRole('button', { name: 'Save description' }));
    expect(fake.editJira).toHaveBeenLastCalledWith('birch', 'ORC-101', { description: 'Fees are left out.' });

    await user.selectOptions(t.getByLabelText('Priority'), 'Low');
    expect(fake.editJira).toHaveBeenLastCalledWith('birch', 'ORC-101', { priority: 'Low' });

    await user.click(t.getByRole('button', { name: 'Edit labels' }));
    const labels = t.getByLabelText('Labels, separated by spaces');
    await user.clear(labels);
    await user.type(labels, 'web checkout');
    await user.click(t.getByRole('button', { name: 'Save labels' }));
    expect(fake.editJira).toHaveBeenLastCalledWith('birch', 'ORC-101', { labels: ['web', 'checkout'] });

    await user.click(await t.findByRole('button', { name: 'Unassign' }));
    expect(fake.assignJira).toHaveBeenLastCalledWith('birch', 'ORC-101', false);
    expect(await t.findByText('Nobody')).toBeTruthy();
    await user.click(t.getByRole('button', { name: 'Assign to me' }));
    expect(fake.assignJira).toHaveBeenLastCalledWith('birch', 'ORC-101', true);
  });

  it('shows an action the hub cannot do yet in plain words', async () => {
    const { user } = await open(api({ assignJira: async () => { throw new ApiError(501, 'not_built_yet', 'x'); } }), 'ORC-101');
    const ticket = await screen.findByRole('complementary', { name: 'Ticket ORC-101' });
    await user.click(within(ticket).getByRole('button', { name: 'Assign to me' }));
    expect(await within(ticket).findByText(/needs the next update/)).toBeTruthy();
  });

  it('starts building, gives to a target, adds to the board and starts a drag', async () => {
    const result = { runId: 'r1', items: [], manager: 'sent' as const };
    const fake = api({
      delegate: async () => result,
      createCard: async (body) => ({
        id: 44, title: body.title, details: body.details ?? '', project: null, server: body.server ?? null, source: 'jira', sourceRef: body.sourceRef ?? null,
        state: 'open', today: false, priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: AT, updatedAt: AT, doneAt: null, dueAt: null, snoozeUntil: null,
      }),
    });
    const { user } = await open(fake, 'ORC-101');
    const ticket = await screen.findByRole('complementary', { name: 'Ticket ORC-101' });
    const t = within(ticket);

    await user.click(t.getByRole('button', { name: 'Start building' }));
    expect(fake.delegate).toHaveBeenLastCalledWith({ what: [{ kind: 'jira', server: 'birch', key: 'ORC-101' }], to: { kind: 'auto' } });

    // Give to… opens the give provider's one picker (the same as the board's), not a menu of its own.
    await user.click(t.getByRole('button', { name: 'Give to…' }));
    let picker = await screen.findByRole('dialog', { name: 'Give ORC-101 to…' });
    expect(t.queryByRole('menu')).toBeNull();
    await user.click(within(picker).getByRole('button', { name: /A new session in Harbor/ }));
    expect(fake.delegate).toHaveBeenLastCalledWith({ what: [{ kind: 'jira', server: 'birch', key: 'ORC-101' }], to: { kind: 'server', server: 'ash' } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Give ORC-101 to…' })).toBeNull());
    await user.click(t.getByRole('button', { name: 'Give to…' }));
    picker = await screen.findByRole('dialog', { name: 'Give ORC-101 to…' });
    await user.click(within(picker).getByRole('button', { name: /checkout/ }));
    expect(fake.delegate).toHaveBeenLastCalledWith({ what: [{ kind: 'jira', server: 'birch', key: 'ORC-101' }], to: { kind: 'session', id: 'birch:web:0.0' } });
    await waitFor(() => expect(screen.getAllByText('Luady is on it: ORC-101.').length).toBeGreaterThan(0));

    await user.click(t.getByRole('button', { name: 'Add to board' }));
    expect(fake.createCard).toHaveBeenCalledWith({
      title: 'ORC-101 Checkout total is wrong', details: detail().descriptionMd, server: 'birch', source: 'jira', sourceRef: 'birch:ORC-101',
    });
    expect(await screen.findByText('ORC-101 is on the board as #44.')).toBeTruthy();
  });

  it('a ticket card hands its drag to the give provider', async () => {
    const giveModule = await import('../../../../src/features/agency/give/GiveContext.js');
    const startDrag = vi.fn();
    vi.spyOn(giveModule, 'useGive').mockReturnValue({ give: vi.fn(), giveTo: vi.fn(), startDrag, openPicker: vi.fn(), dragging: false });
    const { user } = await open();
    const handle = await screen.findByRole('button', { name: 'Drag ORC-102 to a session or a room' });
    await user.pointer({ keys: '[MouseLeft>]', target: handle });
    expect(startDrag).toHaveBeenCalledWith([{ kind: 'jira', server: 'birch', key: 'ORC-102' }], 'ORC-102', expect.anything());
  });
});

describe('JiraModal: Jira refuses the stored sign-in', () => {
  const refused = async (): Promise<never> => { throw new ApiError(409, 'jira_auth', REFUSED); };

  it('a board Jira refused offers to sign in again', async () => {
    const { user } = await open(api({ jiraBoard: refused }));
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByRole('form', { name: 'Connect Jira to Orchard' })).toBeTruthy();
  });

  it('a ticket change Jira refused says so and offers to sign in again', async () => {
    const { user } = await open(api({ commentJira: refused }), 'ORC-101');
    const ticket = await screen.findByRole('complementary', { name: 'Ticket ORC-101' });
    await user.type(within(ticket).getByLabelText('Add a comment'), 'On it.');
    await user.click(within(ticket).getByRole('button', { name: 'Comment' }));
    expect(await within(ticket).findByText(REFUSED)).toBeTruthy();
    await user.click(within(ticket).getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByRole('form', { name: 'Connect Jira to Orchard' })).toBeTruthy();
  });
});
