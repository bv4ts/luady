import { Suspense, lazy, useCallback, type Dispatch, type ReactElement } from 'react';
import type { AgencyUi, AgencyUiAction, ModalKind, ModalState } from './model/ui-state.js';
import { ModalFrame } from './panels/ModalFrame.js';
import { OfficeBoundary } from './OfficeBoundary.js';
import type { StageTarget } from './stage-types.js';

const BoardModal = lazy(async () => ({ default: (await import('./drawers/board/BoardModal.js')).BoardModal }));
const NotesModal = lazy(async () => ({ default: (await import('./drawers/notes/NotesModal.js')).NotesModal }));
const LibraryModal = lazy(async () => ({ default: (await import('./drawers/library/LibraryModal.js')).LibraryModal }));
const JiraModal = lazy(async () => ({ default: (await import('./drawers/jira/JiraModal.js')).JiraModal }));
const ActivityModal = lazy(async () => ({ default: (await import('./hud/ActivityModal.js')).ActivityModal }));
const FleetModal = lazy(async () => ({ default: (await import('./drawers/fleet/FleetModal.js')).FleetModal }));
const WinsModal = lazy(async () => ({ default: (await import('./drawers/wins/WinsModal.js')).WinsModal }));
const TimelineModal = lazy(async () => ({ default: (await import('./drawers/timeline/TimelineModal.js')).TimelineModal }));
const ScheduleModal = lazy(async () => ({ default: (await import('./drawers/schedule/ScheduleModal.js')).ScheduleModal }));
const LinksModal = lazy(async () => ({ default: (await import('./drawers/links/LinksModal.js')).LinksModal }));
const HelpModal = lazy(async () => ({ default: (await import('./drawers/help/HelpModal.js')).HelpModal }));
const RoomsModal = lazy(async () => ({ default: (await import('../rooms/RoomsModal.js')).RoomsModal }));

/**
 * Help's "Show me": the pop-up closes and the camera goes there. A fixture (`<kind>-<room>`) or a room focuses its
 * room; a character opens its agent view. The page may pass its own handler (to outline the fixture as well).
 */
export function showActions(target: StageTarget): AgencyUiAction[] {
  const close: AgencyUiAction = { type: 'modal.close' };
  switch (target.kind) {
    case 'actor': return [close, { type: 'select', id: target.id }];
    case 'room': return [close, { type: 'focus', focus: { kind: 'room', room: target.room } }];
    case 'fixture': {
      const room = target.id.slice(target.id.indexOf('-') + 1);
      return room === '' || !target.id.includes('-') ? [close] : [close, { type: 'focus', focus: { kind: 'room', room } }];
    }
  }
}

export const MODAL_LABELS: Readonly<Record<ModalKind, string>> = {
  board: 'Board',
  notes: 'Notes',
  library: 'Library',
  jira: 'Jira',
  activity: 'Activity',
  fleet: 'Fleet',
  wins: 'Wins',
  timeline: 'Today',
  schedule: 'Schedule',
  links: 'Links',
  help: 'Help',
  rooms: 'Rooms',
};

interface ModalHandlers {
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
  readonly onShow: (target: StageTarget) => void;
  /** The room a pop-up opened without one shows: the first room; null while the office has none. */
  readonly firstRoom: string | null;
  /** Opens the Rooms pop-up. */
  readonly onRooms: () => void;
}

/** Jira and the links shelf belong to a room: with no room yet they say how to make one. */
function NoRoomYet({ onRooms }: Pick<ModalHandlers, 'onRooms'>) {
  return (
    <div className="modal-frame__loading" role="status">
      <p>The office has no rooms yet. Add a room first: its Jira board and its links live in it.</p>
      <button type="button" className="btn btn--secondary" onClick={onRooms}>Add a room</button>
    </div>
  );
}

function roomOf(modal: ModalState, firstRoom: string | null): string | null {
  return modal.room ?? firstRoom;
}

function modalContent(modal: ModalState, handlers: ModalHandlers): ReactElement {
  const { onClose, onSelect, onShow, firstRoom, onRooms } = handlers;
  const room = roomOf(modal, firstRoom);
  switch (modal.kind) {
    case 'board': return <BoardModal {...(modal.itemId === undefined ? {} : { itemId: modal.itemId })} onClose={onClose} />;
    case 'notes': return <NotesModal {...(modal.noteId === undefined ? {} : { noteId: modal.noteId })} onClose={onClose} />;
    case 'library': return <LibraryModal onClose={onClose} />;
    case 'jira':
      return room === null ? <NoRoomYet onRooms={onRooms} />
        : <JiraModal room={room} {...(modal.issueKey === undefined ? {} : { issueKey: modal.issueKey })} onClose={onClose} />;
    case 'activity': return <ActivityModal onClose={onClose} onSelect={onSelect} />;
    case 'fleet': return <FleetModal onClose={onClose} />;
    case 'wins': return <WinsModal onClose={onClose} />;
    case 'timeline': return <TimelineModal onClose={onClose} />;
    case 'schedule': return <ScheduleModal onClose={onClose} />;
    case 'links': return room === null ? <NoRoomYet onRooms={onRooms} /> : <LinksModal room={room} onClose={onClose} />;
    case 'help': return <HelpModal onClose={onClose} onShow={onShow} />;
    case 'rooms':
      return <RoomsModal {...(modal.room === undefined ? {} : { room: modal.room })} {...(modal.position === undefined ? {} : { position: modal.position })}
        add={modal.add === true} onClose={onClose} onShowRoom={(id) => onShow({ kind: 'room', room: id })} />;
  }
}

/** What follows a pop-up's title: Notes says how many notes are not opened yet ("2 new"). */
export function modalBadge(kind: ModalKind, newNotes: number): string | undefined {
  return kind === 'notes' && newNotes > 0 ? `${String(newNotes)} new` : undefined;
}

/** The one large pop-up that is open, loaded on first use, in the shared frame. */
export function OpenModal({ ui, dispatch, onShow, newNotes = 0, firstRoom = null }: {
  ui: AgencyUi; dispatch: Dispatch<AgencyUiAction>; onShow?: (target: StageTarget) => void;
  /** Notes not opened yet, for the Notes title. */
  newNotes?: number;
  /** The room Jira and the links shelf open on without one: the first room; null while the office has none. */
  firstRoom?: string | null;
}) {
  const onClose = useCallback(() => dispatch({ type: 'modal.close' }), [dispatch]);
  const onSelect = useCallback((id: string) => {
    dispatch({ type: 'modal.close' });
    dispatch({ type: 'select', id });
  }, [dispatch]);
  const show = useCallback((target: StageTarget) => {
    if (onShow !== undefined) onShow(target);
    else showActions(target).forEach(dispatch);
  }, [dispatch, onShow]);
  const onRooms = useCallback(() => dispatch({ type: 'modal', modal: { kind: 'rooms', add: true } }), [dispatch]);
  if (ui.modal === null) return null;
  return (
    <ModalFrame label={MODAL_LABELS[ui.modal.kind]} badge={modalBadge(ui.modal.kind, newNotes)} onClose={onClose}>
      <OfficeBoundary key={ui.modal.kind} fallback={<ModalFailed />}>
        <Suspense fallback={<p className="modal-frame__loading" role="status">Opening…</p>}>
          {modalContent(ui.modal, { onClose, onSelect, onShow: show, firstRoom, onRooms })}
        </Suspense>
      </OfficeBoundary>
    </ModalFrame>
  );
}

/**
 * A pop-up whose code could not load (after a deploy an open tab asks for a file the server no longer has) or that
 * crashed: said inside its own frame, with a reload, instead of the whole office falling back to the classic view.
 */
function ModalFailed() {
  return (
    <div className="modal-frame__loading" role="alert">
      <p>This pop-up could not open. The site may have been updated since this page was loaded.</p>
      <button type="button" className="btn btn--secondary" onClick={() => window.location.reload()}>Reload the page</button>
    </div>
  );
}
