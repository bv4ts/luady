import type { NoteDTO } from '@luady/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { NOTES_MISSING } from '../../../../src/features/agency/drawers/notes/useNotes.js';
import { NotesModal } from '../../../../src/features/agency/drawers/notes/NotesModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { chat, overview } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { card, note } from '../board/board-fixtures.js';

const MEETING = note('m:sync', {
  title: 'Weekly sync', people: 'Lina, Omar', gist: 'Coupons ship Sunday.', summary: 'The team agreed on Sunday.', hasTranscript: true,
  actionItems: '- Ship coupons\n- Payroll ISO dates', project: 'orchard-web', link: 'https://wisprflow.ai/notes/sync',
});
const TYPED = note('n:7', { title: 'Stand-up', summary: 'Yesterday: coupons.', editable: true });
const ALL: readonly NoteDTO[] = [TYPED, MEETING];

function setup(over: FakeApiOverrides = {}, noteId?: string) {
  const dispatch = vi.fn();
  const api = fakeApi({
    activity: async () => ({ items: [] }), notices: async () => ({ items: [] }), said: async () => ({ items: [] }),
    presence: async () => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }),
    board: async () => ({ items: [card(30, { title: 'Ship coupons', source: 'meeting', sourceRef: 'sync', state: 'running' })] }),
    missions: async () => ({ items: [] }),
    notes: async (filter) => ({ items: ALL.filter((n) => filter?.query === undefined || n.title.toLowerCase().includes(filter.query.toLowerCase())) }),
    note: async (id) => {
      const found = id === 'n:9' ? note('n:9', { title: 'Sunday', editable: true }) : ALL.find((n) => n.id === id);
      if (found === undefined) throw new ApiError(404, 'not_found', 'gone');
      return found;
    },
    createNote: async (body) => note('n:9', { title: body.title ?? 'Untitled', summary: body.body, editable: true }),
    updateNote: async (id, body) => ({ ...TYPED, id, title: body.title ?? TYPED.title, summary: body.body ?? TYPED.summary }),
    deleteNote: async () => ({ ok: true }),
    noteTranscript: async (_id, start = 0) => ({ text: start === 0 ? 'Lina: hello.\n' : 'Omar: bye.\n', nextStart: start === 0 ? 1 : null }),
    createCard: async (body) => card(41, { title: body.title, source: body.source ?? 'web', sourceRef: body.sourceRef ?? null }),
    sendToLuady: async () => ({ ok: true, held: false }),
    luadyMessages: async () => ({
      items: [
        chat({ id: 'a', role: 'owner', ts: '2026-11-15T09:00:00Z', about: { kind: 'note', id: 'n:7', label: 'Stand-up' } }),
        chat({ id: 'b', role: 'manager', ts: '2026-11-15T09:01:00Z', text: 'Coupons first, I put it on the board.' }),
      ],
      nextCursor: null,
    }),
    ...over,
  });
  return renderPage(
    <GiveProvider stage={null} dispatch={dispatch}><NotesModal {...(noteId === undefined ? {} : { noteId })} onClose={vi.fn()} /></GiveProvider>,
    { api, overview: overview() },
  ).then((page) => ({ ...page, dispatch }));
}

const list = () => screen.getByRole('complementary', { name: 'All notes' });

describe('the Notes pop-up', () => {
  it('lists meetings and typed notes, newest first as the hub sends them', async () => {
    await setup();
    await within(list()).findByText('Weekly sync');
    const rows = within(list()).getAllByRole('button').filter((b) => b.classList.contains('notes-row'));
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Stand-up'), expect.stringContaining('Weekly sync')]);
    expect(within(list()).getByText('Coupons ship Sunday.')).toBeTruthy();
  });

  it('searches after a short pause', async () => {
    const { api, user } = await setup();
    await within(list()).findByText('Weekly sync');
    await user.type(screen.getByRole('searchbox', { name: 'Search notes' }), 'weekly');
    await waitFor(() => expect(api.notes).toHaveBeenLastCalledWith({ query: 'weekly' }));
    await waitFor(() => expect(within(list()).queryByText('Stand-up')).toBeNull());
    await user.clear(screen.getByRole('searchbox', { name: 'Search notes' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search notes' }), 'zzz');
    expect(await within(list()).findByText('No note matches that search.')).toBeTruthy();
  });

  it('reloads on notes.changed', async () => {
    const { api, ws } = await setup();
    await within(list()).findByText('Weekly sync');
    const calls = api.notes.mock.calls.length;
    ws.emit({ type: 'notes.changed', at: '2026-11-15T10:00:00Z' });
    await waitFor(() => expect(api.notes.mock.calls.length).toBe(calls + 1));
  });

  it('an older hub says notes need an update', async () => {
    await setup({ notes: async () => { throw new ApiError(404, 'not_found', 'x'); } });
    expect(await screen.findByText(NOTES_MISSING)).toBeTruthy();
  });
});

describe('a note opened', () => {
  it('a meeting shows everything, the transcript in parts, and the cards made from it', async () => {
    const { user } = await setup({}, 'm:sync');
    const view = await screen.findByTestId('note-view');
    expect(within(view).getByText('Coupons ship Sunday.')).toBeTruthy();
    expect(within(view).getByText(/With Lina, Omar/)).toBeTruthy();
    expect(within(view).getByRole('link', { name: 'Open in Wispr Flow' }).getAttribute('href')).toBe('https://wisprflow.ai/notes/sync');
    expect(within(view).getByText('On the board, running')).toBeTruthy();
    expect(within(view).queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(within(view).getByRole('button', { name: 'Show transcript' }));
    expect(await within(view).findByText(/Lina: hello\./)).toBeTruthy();
    await user.click(within(view).getByRole('button', { name: 'Show more' }));
    expect(await within(view).findByText(/Omar: bye\./)).toBeTruthy();
    expect(within(view).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('Make it a task: one action item, then the whole note', async () => {
    const { api, user } = await setup({}, 'm:sync');
    const view = await screen.findByTestId('note-view');
    await user.click(within(view).getByRole('button', { name: 'Make it a task: Payroll ISO dates' }));
    expect(api.createCard).toHaveBeenLastCalledWith({
      title: 'Payroll ISO dates', details: 'From the meeting "Weekly sync".', source: 'meeting', sourceRef: 'm:sync', project: 'orchard-web',
    });
    expect(await screen.findByText('Added #41: Payroll ISO dates')).toBeTruthy();
    await user.click(within(view).getByRole('button', { name: 'Make it a task' }));
    expect(api.createCard).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Weekly sync', source: 'meeting', sourceRef: 'm:sync' }));
  });

  it("shows Luady's answer to the note and sends it to him again with the note attached", async () => {
    const { api, user } = await setup({}, 'n:7');
    const view = await screen.findByTestId('note-view');
    expect(await within(view).findByText('Coupons first, I put it on the board.')).toBeTruthy();
    await user.click(within(view).getByRole('button', { name: 'Send to Luady' }));
    expect(api.sendToLuady).toHaveBeenCalledWith({ text: expect.stringContaining('Please read this note'), about: { kind: 'note', id: 'n:7' } });
  });

  it('a typed note is edited and deleted', async () => {
    const { api, user } = await setup({}, 'n:7');
    const view = await screen.findByTestId('note-view');
    await user.click(within(view).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit note' });
    await user.type(within(form).getByLabelText('Note', { exact: true }), ' Today: payroll.');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(api.updateNote).toHaveBeenCalledWith('n:7', { body: 'Yesterday: coupons. Today: payroll.', title: 'Stand-up', project: null });
    const again = await screen.findByTestId('note-view');
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('group', { name: 'Delete this note?' })).getByRole('button', { name: 'Delete' }));
    expect(api.deleteNote).toHaveBeenCalledWith('n:7');
    await waitFor(() => expect(screen.queryByTestId('note-view')).toBeNull());
  });

  it('a note that is gone says so', async () => {
    await setup({}, 'n:99');
    expect(await screen.findByText('This note is gone.')).toBeTruthy();
  });
});

describe('a new note', () => {
  it('Save keeps it without Luady', async () => {
    const { api, user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'New note' }));
    const form = screen.getByRole('form', { name: 'New note' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Paste or type the note first.')).toBeTruthy();
    await user.type(within(form).getByLabelText('Title (optional)'), 'Sunday');
    await user.type(within(form).getByLabelText('Note', { exact: true }), 'Coupons are live.');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(api.createNote).toHaveBeenCalledWith({ body: 'Coupons are live.', title: 'Sunday' });
    expect(await screen.findByText('Note saved.')).toBeTruthy();
    expect(await screen.findByTestId('note-view')).toBeTruthy();
  });

  it('Send to Luady saves it with discuss', async () => {
    const { api, user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'New note' }));
    const form = screen.getByRole('form', { name: 'New note' });
    await user.type(within(form).getByLabelText('Note', { exact: true }), 'Stand-up: all good.');
    await user.type(within(form).getByLabelText('Project (optional)'), 'harbor-web');
    await user.click(within(form).getByRole('button', { name: 'Send to Luady' }));
    expect(api.createNote).toHaveBeenCalledWith({ body: 'Stand-up: all good.', project: 'harbor-web', discuss: true });
    expect(await screen.findByText('Saved and sent to Luady. His answer shows here and in the chat.')).toBeTruthy();
  });
});
