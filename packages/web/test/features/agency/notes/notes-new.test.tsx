import type { NoteDTO } from '@luady/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { NotesModal } from '../../../../src/features/agency/drawers/notes/NotesModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { useNewNotes } from '../../../../src/features/agency/model/useNewNotes.js';
import { modalBadge } from '../../../../src/features/agency/OpenModal.js';
import { ModalFrame } from '../../../../src/features/agency/panels/ModalFrame.js';
import { overview } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { note } from '../board/board-fixtures.js';

// A meeting not opened yet shows "NEW" until it is opened; the title says how many.
const FRESH = note('m:fresh', { title: 'Untitled meeting', isNew: true });
const READ = note('m:read', { title: 'Stand-up meeting', isNew: false });
const TYPED = note('n:7', { title: 'My own note', editable: true });

function setup(over: FakeApiOverrides = {}, noteId?: string) {
  let items: readonly NoteDTO[] = [FRESH, READ, TYPED];
  const api = fakeApi({
    activity: async () => ({ items: [] }), notices: async () => ({ items: [] }), said: async () => ({ items: [] }),
    presence: async () => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }),
    board: async () => ({ items: [] }), missions: async () => ({ items: [] }),
    luadyMessages: async () => ({ items: [], nextCursor: null }),
    notes: async () => ({ items: [...items], newCount: items.filter((n) => n.isNew === true).length }),
    note: async (id) => {
      const found = items.find((n) => n.id === id);
      if (found === undefined) throw new ApiError(404, 'not_found', 'gone');
      return found;
    },
    markNoteOpened: async (id) => {
      items = items.map((n) => (n.id === id ? { ...n, isNew: false } : n));
      return { ok: true };
    },
    ...over,
  });
  return renderPage(
    <GiveProvider stage={null} dispatch={vi.fn()}><NotesModal {...(noteId === undefined ? {} : { noteId })} onClose={vi.fn()} /></GiveProvider>,
    { api, overview: overview() },
  );
}

const list = () => screen.getByRole('complementary', { name: 'All notes' });
const row = (title: string) => within(list()).getByText(title).closest('button') as HTMLButtonElement;

describe('the NEW pill', () => {
  it('shows only on a meeting not opened yet, right after its "Meeting" label', async () => {
    await setup();
    await within(list()).findByText('Untitled meeting');
    const pill = within(row('Untitled meeting')).getByText('New');
    expect(pill.className).toBe('notes-row__new');
    expect(pill.previousElementSibling?.textContent).toBe('Meeting');
    expect(within(row('Stand-up meeting')).queryByText('New')).toBeNull();
    expect(within(row('My own note')).queryByText('New')).toBeNull();
  });

  it('opening the meeting marks it opened on the hub and the pill goes at once', async () => {
    const { api, user } = await setup();
    await within(list()).findByText('Untitled meeting');
    await user.click(row('Untitled meeting'));
    expect(within(row('Untitled meeting')).queryByText('New')).toBeNull();
    await waitFor(() => expect(api.markNoteOpened).toHaveBeenCalledWith('m:fresh'));
    expect(api.markNoteOpened).toHaveBeenCalledTimes(1);
  });

  it('opening a note that is not new, or a typed note, tells the hub nothing', async () => {
    const { api, user } = await setup();
    await within(list()).findByText('Stand-up meeting');
    await user.click(row('Stand-up meeting'));
    await screen.findByTestId('note-view');
    await user.click(row('My own note'));
    await waitFor(() => expect(within(screen.getByTestId('note-view')).getByRole('button', { name: 'Edit' })).toBeTruthy());
    expect(api.markNoteOpened).not.toHaveBeenCalled();
  });

  it('a new note opened straight away (from a link) is marked too', async () => {
    const { api } = await setup({}, 'm:fresh');
    await waitFor(() => expect(api.markNoteOpened).toHaveBeenCalledWith('m:fresh'));
    await within(list()).findByText('Untitled meeting');
    expect(within(row('Untitled meeting')).queryByText('New')).toBeNull();
  });

  it('a failed mark keeps the pill and does not break the note', async () => {
    const { api } = await setup({ markNoteOpened: async () => { throw new ApiError(500, 'internal', 'down'); } }, 'm:read');
    expect(await screen.findByTestId('note-view')).toBeTruthy();
    expect(api.markNoteOpened).not.toHaveBeenCalled();
    await within(list()).findByText('Untitled meeting');
    expect(within(row('Untitled meeting')).getByText('New')).toBeTruthy();
  });
});

describe('the Notes title: "Notes · 2 new"', () => {
  it('only Notes, only with new notes', () => {
    expect(modalBadge('notes', 2)).toBe('2 new');
    expect(modalBadge('notes', 0)).toBeUndefined();
    expect(modalBadge('board', 3)).toBeUndefined();
  });

  it('the frame shows the count after the title and keeps "Close Notes"', () => {
    render(<ModalFrame label="Notes" badge="2 new" onClose={vi.fn()}><p>body</p></ModalFrame>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Notes · 2 new');
    expect(screen.getByRole('button', { name: 'Close Notes' })).toBeTruthy();
  });

  it('without a count it is just the title', () => {
    render(<ModalFrame label="Notes" onClose={vi.fn()}><p>body</p></ModalFrame>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Notes');
  });
});

function Count() {
  const [open, setOpen] = useState(false);
  const count = useNewNotes(open);
  return <><output data-testid="count">{count}</output><button type="button" onClick={() => setOpen(true)}>Open Notes</button></>;
}

describe('useNewNotes with the hub count', () => {
  it("takes the hub's count, keeps it while Notes is open, and follows notes.changed", async () => {
    let newCount = 2;
    const api = fakeApi({ notes: async () => ({ items: [FRESH], newCount }) });
    const page = await renderPage(<Count />, { api, overview: overview() });
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
    await page.user.click(screen.getByRole('button', { name: 'Open Notes' }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    newCount = 1;
    page.ws.emit({ type: 'notes.changed', at: '2026-11-17T09:00:00Z' });
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
  });
});
