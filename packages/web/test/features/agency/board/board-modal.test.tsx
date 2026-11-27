import type { BoardItemDTO } from '@luady/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { BoardModal } from '../../../../src/features/agency/drawers/board/BoardModal.js';
import { BOARD_MISSING } from '../../../../src/features/agency/drawers/board/useBoard.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { overview, project, question, server, session } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { boardEvent, card, mission } from './board-fixtures.js';

const RUN = 'birch:web:0.0';
const ASK = 'birch:ask:0.0';
const CARDS: readonly BoardItemDTO[] = [
  card(1, { title: 'Plain to do' }),
  card(2, { title: 'Today job', today: true, server: 'birch', project: 'web' }),
  card(3, { title: 'Running job', state: 'running', sessionId: RUN, server: 'birch' }),
  card(4, { title: 'Asking job', state: 'running', sessionId: ASK }),
  card(5, { title: 'Blocked job', state: 'review', result: 'Blocked: no login.' }),
  card(6, { title: 'Finished job', state: 'done', doneAt: new Date().toISOString(), result: 'Shipped it.' }),
  card(7, { title: 'Queued job', state: 'queued' }),
];
const SESSIONS = [
  session({ id: RUN, host: 'birch', displayName: 'web', state: 'working', origin: 'manager' }),
  session({ id: ASK, host: 'birch', displayName: 'ask', state: 'waiting_question', pendingQid: 'QASK0001', origin: 'manager' }),
  session({ id: 'cedar:own:0.0', host: 'cedar', displayName: 'own', state: 'working', origin: 'owner' }),
];

function setup(over: FakeApiOverrides = {}, itemId?: number) {
  const dispatch = vi.fn();
  const api = fakeApi({
    activity: async () => ({ items: [] }), notices: async () => ({ items: [] }), said: async () => ({ items: [] }),
    presence: async () => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }),
    board: async () => ({ items: [...CARDS] }), missions: async () => ({ items: [mission(RUN)] }),
    card: async (id) => ({ item: CARDS.find((c) => c.id === id) ?? card(id), events: [boardEvent(1, id, 'created', 'Added.'), boardEvent(2, id, 'report', 'Half way.')], mission: id === 3 ? mission(RUN) : null }),
    updateCard: async (id, body) => ({ ...(CARDS.find((c) => c.id === id) ?? card(id)), ...body } as BoardItemDTO),
    deleteCard: async () => ({ ok: true }),
    createCard: async (body) => card(40, { title: body.title }),
    delegate: async (body) => ({ runId: 'r1', items: [], manager: 'sent' as const, ...(body.to.kind === 'auto' ? {} : {}) }),
    sendToLuady: async () => ({ ok: true, held: false }),
    projects: async (name) => (name === 'birch' ? [project({ server: 'birch', name: 'web', path: '/home/dev/projects/web' }), project({ server: 'birch', name: 'api', path: '/home/dev/projects/api' })] : []),
    ...over,
  });
  return renderPage(
    <GiveProvider stage={null} dispatch={dispatch}><BoardModal {...(itemId === undefined ? {} : { itemId })} onClose={vi.fn()} /></GiveProvider>,
    { api, overview: overview({ rooms: classicRoomDtos(), servers: [server({ name: 'cedar' }), server({ name: 'birch' })], sessions: SESSIONS, questions: [question({ qid: 'QASK0001', sessionId: ASK })] }) },
  ).then((page) => ({ ...page, dispatch }));
}

const lane = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-lane="${id}"].board-lane`);
  if (node === null) throw new Error(`no lane ${id}`);
  return node;
};
const titles = (id: string): string[] => within(lane(id)).queryAllByRole('article').map((node) => node.getAttribute('aria-label') ?? '');

describe('the Board pop-up', () => {
  it('places every card in its lane; a running card whose session asks is in Needs you with Answer', async () => {
    await setup();
    await screen.findByText('Plain to do');
    expect(titles('todo')).toEqual(['Today job', 'Plain to do']);
    expect(titles('running')).toEqual(expect.arrayContaining(['Running job', 'Queued job']));
    expect(titles('running')).toHaveLength(2);
    expect(titles('needs')).toEqual(expect.arrayContaining(['Asking job', 'Blocked job']));
    expect(titles('done')).toEqual(['Finished job']);
    expect(within(lane('needs')).getByText('Waiting for your answer')).toBeTruthy();
    expect(within(lane('needs')).getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(within(lane('running')).getByText('Waiting for Luady')).toBeTruthy();
    expect(within(lane('running')).getByText('Change the date format.')).toBeTruthy();
    expect(within(lane('done')).getByText(/Shipped it\./)).toBeTruthy();
  });

  it('"Also running" counts the owner\'s own sessions and opens the Activity pop-up', async () => {
    const { dispatch, user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'Also running: 1 session you started yourself' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'modal', modal: { kind: 'activity' } });
  });

  it('adds a card from "+ Add"', async () => {
    const { api, user } = await setup();
    await user.click(await screen.findByRole('button', { name: '+ Add' }));
    await user.type(screen.getByLabelText('Title'), 'Buy milk');
    await user.click(screen.getByLabelText('Today'));
    await user.click(screen.getByRole('button', { name: 'Add card' }));
    expect(api.createCard).toHaveBeenCalledWith({ title: 'Buy milk', source: 'web', today: true });
    expect(await within(lane('todo')).findByText('Buy milk')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New card' })).toBeNull();
  });

  it('follows board.updated and board.removed live', async () => {
    const { ws } = await setup();
    await screen.findByText('Plain to do');
    ws.emit({ type: 'board.updated', items: [card(1, { title: 'Plain to do', state: 'queued' })] });
    await waitFor(() => expect(titles('running')).toContain('Plain to do'));
    ws.emit({ type: 'board.removed', ids: [1] });
    await waitFor(() => expect(screen.queryByText('Plain to do')).toBeNull());
  });

  it('an older hub says the board needs an update', async () => {
    await setup({ board: async () => { throw new ApiError(404, 'not_found', 'x'); } });
    expect(await screen.findByText(BOARD_MISSING)).toBeTruthy();
  });
});

describe('picking cards and Run', () => {
  it('ticks two cards and runs them in one request; the tray clears', async () => {
    const { api, user } = await setup();
    await screen.findByText('Plain to do');
    await user.click(within(lane('todo')).getAllByRole('checkbox')[1]!);
    await user.click(within(lane('needs')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Run (2)' }));
    expect(api.delegate).toHaveBeenCalledWith({ what: [{ kind: 'todo', id: 1 }, { kind: 'todo', id: 5 }], to: { kind: 'auto' } });
    expect(await screen.findByText('Luady is on it: 2 cards.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Picked cards' })).toBeNull());
  });

  it('Give to… from the tray sends the picked cards to the chosen office', async () => {
    const { api, user } = await setup();
    await screen.findByText('Plain to do');
    await user.click(within(lane('todo')).getAllByRole('checkbox')[0]!);
    await user.click(within(screen.getByRole('toolbar', { name: 'Picked cards' })).getByRole('button', { name: 'Give to…' }));
    await user.click(screen.getByRole('button', { name: /A new session in Orchard/ }));
    expect(api.delegate).toHaveBeenCalledWith({ what: [{ kind: 'todo', id: 2 }], to: { kind: 'server', server: 'birch' } });
    expect(await screen.findByText('Luady is on it: "Today job" to Orchard.')).toBeTruthy();
  });

  it('unticking empties the tray; running cards cannot be ticked', async () => {
    const { user } = await setup();
    await screen.findByText('Plain to do');
    expect(within(lane('running')).queryAllByRole('checkbox')).toHaveLength(0);
    const box = within(lane('todo')).getAllByRole('checkbox')[0]!;
    await user.click(box);
    expect(screen.getByRole('button', { name: 'Run (1)' })).toBeTruthy();
    await user.click(box);
    expect(screen.queryByRole('toolbar', { name: 'Picked cards' })).toBeNull();
  });
});

describe('a card opened', () => {
  it('shows the work of a running card and opens its agent', async () => {
    const { dispatch, user } = await setup({}, 3);
    const sheet = await screen.findByTestId('card-sheet');
    expect(await within(sheet).findByText('Both files done.')).toBeTruthy();
    expect(within(sheet).getByText(/3 turns/)).toBeTruthy();
    expect(within(sheet).getByText('Half way.', { selector: '.card-sheet__reports span' })).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Open agent' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'select', id: RUN });
  });

  it('a card whose session asks shows the answer card', async () => {
    await setup({}, 4);
    const sheet = await screen.findByTestId('card-sheet');
    expect(await within(sheet).findByText(question().questions[0]?.question ?? '')).toBeTruthy();
  });

  it('edits title and details, and sends only what changed', async () => {
    const { api, user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'Plain to do' }));
    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Edit' }));
    await user.clear(within(sheet).getByLabelText('Title'));
    await user.type(within(sheet).getByLabelText('Title'), 'Better title');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(api.updateCard).toHaveBeenCalledWith(1, { title: 'Better title' });
    expect(await screen.findByText('Card saved.')).toBeTruthy();
  });

  it('Today, High priority, Mark done and the project picker each send their change', async () => {
    const { api, user } = await setup({}, 1);
    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Today' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { today: true });
    await user.click(within(sheet).getByRole('button', { name: 'High priority' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { priority: 1 });
    await waitFor(() => expect(within(sheet).getAllByRole('option', { name: 'api' }).length).toBe(1));
    await user.selectOptions(within(sheet).getByLabelText('Project'), 'birch/api');
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { project: 'api', server: 'birch' });
    await user.selectOptions(within(sheet).getByLabelText('Office'), 'cedar');
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { server: 'cedar', project: null });
    await user.click(within(sheet).getByRole('button', { name: 'Mark done' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(1, { state: 'done' });
  });

  it('Run and Give to… on one card; Back to To do on a card that needs you', async () => {
    const { api, user } = await setup({}, 5);
    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Run again' }));
    expect(api.delegate).toHaveBeenLastCalledWith({ what: [{ kind: 'todo', id: 5 }], to: { kind: 'auto' } });
    await user.click(within(sheet).getByRole('button', { name: 'Back to To do' }));
    expect(api.updateCard).toHaveBeenLastCalledWith(5, { state: 'open' });
  });

  it('deletes after a confirm and closes', async () => {
    const { api, user } = await setup({}, 1);
    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await user.click(within(sheet).getByRole('button', { name: 'Keep' }));
    expect(api.deleteCard).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('group', { name: 'Delete this card?' })).getByRole('button', { name: 'Delete' }));
    expect(api.deleteCard).toHaveBeenCalledWith(1);
    await waitFor(() => expect(screen.queryByTestId('card-sheet')).toBeNull());
    expect(screen.queryByText('Plain to do')).toBeNull();
  });

  it('Ask Luady about this sends the words with the card attached', async () => {
    const { api, user } = await setup({}, 2);
    const sheet = await screen.findByTestId('card-sheet');
    await user.type(within(sheet).getByLabelText('Ask Luady about this'), 'Can this wait?');
    await user.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(api.sendToLuady).toHaveBeenCalledWith({ text: 'Can this wait?', about: { kind: 'todo', id: '2' } });
    expect(await screen.findByText('Sent to Luady. His answer shows in the chat.')).toBeTruthy();
  });

  it('a failed edit says why and the card stays as it was', async () => {
    const { user } = await setup({ updateCard: async () => { throw new ApiError(501, 'not_built_yet', 'The board is not built yet.'); } }, 1);
    const sheet = await screen.findByTestId('card-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Today' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('false');
  });
});
