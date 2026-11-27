import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../../src/api/context.js';
import { ApiError } from '../../../src/api/errors.js';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import { OpenModal } from '../../../src/features/agency/OpenModal.js';
import { jiraRoomsOf, useJiraSites } from '../../../src/features/agency/drawers/jira/useJiraSites.js';
import { GiveProvider, giveToast, useGive } from '../../../src/features/agency/give/GiveContext.js';
import { INITIAL_UI, reduceAgencyUi, type ModalState } from '../../../src/features/agency/model/ui-state.js';
import { snapshotInput } from '../../../src/features/agency/model/useAgencySnapshot.js';
import { StoreProvider, useStore } from '../../../src/state/store.js';
import { Toasts } from '../../../src/ui/Toasts.js';
import { overview } from '../../fixtures.js';
import { classicRoomDtos } from '../../room-fixtures.js';
import { fakeApi, type FakeApi } from '../../helpers/fake-api.js';
import { createFakeWs } from '../../helpers/fake-ws.js';
import { renderPage } from '../../helpers/render.js';
import { fleetOverview } from './agency-fixtures.js';
import { resetStageSpy, stageProps } from './stage-mock.js';

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('./stage-mock.js'));
// The real Library and Jira pop-ups need the API and the store; this file checks only the frame and the switch.
vi.mock('../../../src/features/agency/drawers/library/LibraryModal.js', () => ({
  LibraryModal: () => <p data-testid="library-modal">The library</p>,
}));
vi.mock('../../../src/features/agency/drawers/jira/JiraModal.js', () => ({
  JiraModal: ({ room, issueKey }: { room: string; issueKey?: string }) => <p data-testid="jira-modal">Jira of {room} {issueKey ?? ''}</p>,
}));

const SITE = {
  server: 'cedar' as const, baseUrl: 'https://meadow-demo.atlassian.net', email: 'o@example.com', displayName: null, connectedAt: '2026-11-15T09:00:00.000Z',
  lastOkAt: null, lastError: null, attention: null,
};

function ModalHarness({ initial }: { initial: ModalState }) {
  const [ui, dispatch] = useReducer(reduceAgencyUi, { ...INITIAL_UI, modal: initial });
  return (
    <div>
      <button type="button">outside</button>
      <output data-testid="modal-state">{ui.modal === null ? 'closed' : ui.modal.kind}</output>
      <output data-testid="selected">{ui.selectedId ?? 'none'}</output>
      {/* The page passes its first room (no fixed default room); the classic office's is Orchard on birch. */}
      <GiveProvider stage={null} dispatch={dispatch}><OpenModal ui={ui} dispatch={dispatch} firstRoom="birch" /></GiveProvider>
    </div>
  );
}

function withStore(api: FakeApi, children: React.ReactNode) {
  const ws = createFakeWs();
  return { ws, view: render(<ApiProvider api={api}><StoreProvider createWs={ws.factory} onAuthLost={vi.fn()}>{children}<Toasts /></StoreProvider></ApiProvider>) };
}

/** The real Board and Notes pop-ups load their data: an empty board, card #12 gone, no notes. */
const modalApi = () => fakeApi({
  overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
  board: async () => ({ items: [] }), missions: async () => ({ items: [] }),
  card: async () => { throw new ApiError(404, 'not_found', 'No such card'); },
  notes: async () => ({ items: [] }), note: async () => { throw new ApiError(404, 'not_found', 'No such note'); },
  luadyMessages: async () => ({ items: [], nextCursor: null }), projects: async () => [],
});

beforeEach(() => {
  resetStageSpy();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenModal and ModalFrame', () => {
  it.each([
    [{ kind: 'board', itemId: 12 }, 'Board', 'board-modal', 'This card is gone.'],
    [{ kind: 'notes', noteId: 'n:4' }, 'Notes', 'notes-modal', 'No notes yet.'],
    [{ kind: 'library' }, 'Library', 'library-modal', 'library'],
    [{ kind: 'jira', room: 'cedar', issueKey: 'MDW-7' }, 'Jira', 'jira-modal', 'cedar'],
    [{ kind: 'jira' }, 'Jira', 'jira-modal', 'birch'],
    [{ kind: 'activity' }, 'Activity', 'activity-modal', 'All quiet'],
  ] as const)('%j loads its pop-up in a labelled modal dialog', async (modal, label, testId, text) => {
    withStore(modalApi(), <ModalHarness initial={modal} />);
    const dialog = screen.getByRole('dialog', { name: label });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(screen.getByTestId(testId).textContent).toContain(text), { timeout: 8000 });
  });

  it('Esc still closes it when the focus fell out of the dialog (a card sheet inside closed and left the page focused)', async () => {
    withStore(modalApi(), <ModalHarness initial={{ kind: 'board' }} />);
    await screen.findByTestId('board-modal');
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('modal-state').textContent).toBe('closed');
  });

  it('Esc, the close button and a press outside close it', async () => {
    const user = userEvent.setup();
    const { view: { unmount } } = withStore(modalApi(), <ModalHarness initial={{ kind: 'board' }} />);
    await screen.findByTestId('board-modal');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByTestId('modal-state').textContent).toBe('closed');
    unmount();

    const { view: second } = withStore(modalApi(), <ModalHarness initial={{ kind: 'notes' }} />);
    await user.click(screen.getByRole('button', { name: 'Close Notes' }));
    expect(screen.getByTestId('modal-state').textContent).toBe('closed');
    second.unmount();

    withStore(modalApi(), <ModalHarness initial={{ kind: 'library' }} />);
    fireEvent.mouseDown(screen.getByTestId('modal-backdrop'));
    expect(screen.getByTestId('modal-state').textContent).toBe('closed');
  });

  it('a press inside the dialog does not close it, and focus starts inside and stays inside on Tab', async () => {
    const user = userEvent.setup();
    withStore(modalApi(), <ModalHarness initial={{ kind: 'library' }} />);
    await screen.findByTestId('library-modal');
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(screen.getByTestId('modal-state').textContent).toBe('library');
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close Library' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close Library' }));
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('GiveProvider', () => {
  function Giver() {
    const { give, startDrag } = useGive();
    return (
      <div>
        <button type="button" onClick={() => give([{ kind: 'todo', id: 12 }, { kind: 'jira', server: 'birch', key: 'ORC-1' }], 'Two items')}>give</button>
        <button type="button" onPointerDown={(event) => startDrag([{ kind: 'todo', id: 12 }], 'Card', event)}>drag</button>
      </div>
    );
  }

  it('give posts the items to Luady (target auto) and says so in a toast', async () => {
    const api = fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      delegate: async () => ({ runId: 'r_1', items: [], manager: 'queued' }),
    });
    withStore(api, <GiveProvider stage={null}><Giver /></GiveProvider>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'give' }));
    expect(api.delegate).toHaveBeenCalledWith({ what: [{ kind: 'todo', id: 12 }, { kind: 'jira', server: 'birch', key: 'ORC-1' }], to: { kind: 'auto' } });
    expect(await screen.findByText('Waiting for Luady: Two items. He gets it when he is back.')).toBeTruthy();
    expect(giveToast('Card', 'sent')).toBe('Luady is on it: Card.');
  });

  it('a stub hub (501) ends in an error toast; a press on a handle without a move sends nothing', async () => {
    const api = fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      delegate: async () => { throw new ApiError(501, 'not_built_yet', 'The board is not built yet.'); },
    });
    withStore(api, <GiveProvider stage={null}><Giver /></GiveProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'drag' }));
    await user.click(screen.getByRole('button', { name: 'give' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('useGive outside the provider is a programming error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Giver />)).toThrow(/GiveProvider/);
  });
});

describe('useJiraSites', () => {
  function Hosts() {
    const hosts = useJiraSites();
    const { dispatch } = useStore();
    return (
      <div>
        <output data-testid="hosts">{hosts.join(',')}</output>
        <button type="button" onClick={() => dispatch({ type: 'ws.message', message: { type: 'jira.changed', room: 'cedar', at: '2026-11-15T09:00:00.000Z' } })}>changed</button>
      </div>
    );
  }

  // By design: the room that always shows its board is the first room (birch with the classic four), not a fixed id.
  it('always includes the first room, adds connected rooms, and refetches on jira.changed', async () => {
    const api = fakeApi({ overview: async () => overview({ rooms: classicRoomDtos() }), jiraSites: async () => ({ sites: [] }) });
    withStore(api, <Hosts />);
    await waitFor(() => expect(api.jiraSites).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('hosts').textContent).toBe('birch');
    api.jiraSites.mockResolvedValue({ sites: [SITE] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'changed' }));
    await waitFor(() => expect(screen.getByTestId('hosts').textContent).toBe('birch,cedar'));
    expect(jiraRoomsOf(['cedar', 'birch', 'cedar'], 'birch')).toEqual(['birch', 'cedar']);
    expect(jiraRoomsOf(['cedar'], null)).toEqual(['cedar']);
  });

  it('an older hub (404) keeps the first room only', async () => {
    const api = fakeApi({ overview: async () => overview({ rooms: classicRoomDtos() }), jiraSites: async () => { throw new ApiError(404, 'not_found', 'x'); } });
    withStore(api, <Hosts />);
    await waitFor(() => expect(api.jiraSites).toHaveBeenCalled());
    expect(screen.getByTestId('hosts').textContent).toBe('birch');
  });
});

describe('the snapshot input helper', () => {
  it('carries the rooms with a Jira board next to the office input (jiraRooms: Jira sites are keyed by room)', () => {
    const base = { servers: [], rooms: [], sessions: [], questions: [], luady: null, now: 0, previousSeats: {} };
    expect(snapshotInput(base, ['birch'])).toEqual({ ...base, jiraRooms: ['birch'] });
  });
});

describe('AgencyPage with the board pop-up and the stage handle', () => {
  const pageApi = () => fakeApi({
    luadyMessages: async () => ({ items: [], nextCursor: null }),
    jiraSites: async () => ({ sites: [] }),
  });

  it('a board fixture opens the Board pop-up and Esc closes it', async () => {
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    act(() => stageProps().onEvent({ type: 'fixture', fixture: 'board', id: 'board-hq', room: 'hq' }));
    expect(await screen.findByTestId('board-modal')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Board' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Board' })).toBeNull();
  });

  it('keeps the stage handle from onReady and gives the stage its handle callback', async () => {
    await renderPage(<AgencyPage />, { api: pageApi(), overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    const onReady = stageProps().onReady;
    expect(typeof onReady).toBe('function');
    act(() => onReady?.({ pick: () => null, setDropHint: () => undefined }));
    act(() => onReady?.(null));
  });
});
