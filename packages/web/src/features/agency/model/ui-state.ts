import { LOT_PREFIX } from '@luady/office';
import { LUADY_ACTOR_ID, type StageEvent, type StageFocus } from '../stage-types.js';

/** Drawers open from the top bar over whatever panel is open; closing one shows that panel again. */
export type DrawerKind = 'accounts' | 'notices';
export type PanelKind = 'room' | 'agent' | 'rack' | 'manager' | DrawerKind;

/**
 * The large pop-ups: they sit over any panel and Esc closes them first. They include the fleet wall, the
 * wins wall, the today strip (`timeline`), the schedule board, the links shelf (with its room) and help.
 */
export type ModalKind =
  | 'board' | 'library' | 'notes' | 'jira' | 'activity'
  | 'fleet' | 'wins' | 'timeline' | 'schedule' | 'links' | 'help'
  /** The rooms list; with `room` that room's editor, with `position` a new room for that free spot. */
  | 'rooms';

export interface ModalState {
  readonly kind: ModalKind;
  /** Jira and links: the office room whose board or shelf is shown. Rooms: the room being edited. */
  readonly room?: string;
  /** Rooms: a new room goes into this free spot (a "+ Add room" plaque). */
  readonly position?: number;
  /** Rooms: open on a new room's editor (in the lowest free spot unless `position` says). */
  readonly add?: boolean;
  /** Board: the card opened in it. */
  readonly itemId?: number;
  /** Notes: the note opened in it. */
  readonly noteId?: string;
  /** Jira: the ticket opened in it. */
  readonly issueKey?: string;
}

export interface ActorMenuAt {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface AgencyUi {
  readonly focus: StageFocus;
  readonly selectedId: string | null;
  readonly panel: PanelKind | null;
  readonly menu: ActorMenuAt | null;
  /** The pop-up over everything; null while none is open. */
  readonly modal: ModalState | null;
  /** The "Send a note" box, at the point where the menu was; absent while closed. */
  readonly note?: ActorMenuAt;
  /** While a drawer is open: the panel it covers, shown again when it closes. */
  readonly under?: PanelKind;
}

export type AgencyUiAction =
  | { readonly type: 'stage'; readonly event: StageEvent }
  | { readonly type: 'focus'; readonly focus: StageFocus }
  | { readonly type: 'select'; readonly id: string | null }
  | { readonly type: 'close' }
  | { readonly type: 'next-need'; readonly needs: readonly string[] }
  | { readonly type: 'gone'; readonly ids: readonly string[] }
  | ({ readonly type: 'note' } & ActorMenuAt)
  | { readonly type: 'open'; readonly panel: PanelKind }
  | { readonly type: 'modal'; readonly modal: ModalState }
  | { readonly type: 'modal.close' };

/** A view of the office; the pop-up stays as it is unless a step names it. */
type View = Omit<AgencyUi, 'modal'> & { readonly modal?: ModalState | null };

const ALL: StageFocus = Object.freeze({ kind: 'all' });
const OFFICE: View = Object.freeze({ focus: ALL, selectedId: null, panel: null, menu: null });

export const INITIAL_UI: AgencyUi = Object.freeze({ ...OFFICE, modal: null });

export function isDrawer(panel: PanelKind | null | undefined): panel is DrawerKind {
  return panel === 'accounts' || panel === 'notices';
}

function sameFocus(a: StageFocus, b: StageFocus): boolean {
  if (a.kind === 'room' && b.kind === 'room') return a.room === b.room;
  if (a.kind === 'actor' && b.kind === 'actor') return a.id === b.id;
  return a.kind === b.kind;
}

/** Keeps the previous object (and focus object) when nothing changed, so the memoised stage sees the same props. */
function next(prev: AgencyUi, update: View): AgencyUi {
  const focus = sameFocus(prev.focus, update.focus) ? prev.focus : update.focus;
  const modal = update.modal === undefined ? prev.modal : update.modal;
  const same = focus === prev.focus && update.selectedId === prev.selectedId && update.panel === prev.panel
    && update.menu === prev.menu && update.note === prev.note && update.under === prev.under && modal === prev.modal;
  if (same) return prev;
  const { note, under, ...rest } = update;
  return Object.freeze({ ...rest, focus, modal, ...(note === undefined ? {} : { note }), ...(under === undefined ? {} : { under }) });
}

/** The view without the note box or the covered panel (the optional parts). */
const plain = (state: AgencyUi): View => ({ focus: state.focus, selectedId: state.selectedId, panel: state.panel, menu: state.menu });

const roomView = (room: string, panel: 'room' | 'rack'): View =>
  ({ focus: { kind: 'room', room }, selectedId: null, panel, menu: null });

const actorView = (id: string): View =>
  ({ focus: { kind: 'actor', id }, selectedId: id, panel: id === LUADY_ACTOR_ID ? 'manager' : 'agent', menu: null });

/** A fixture press: the rack opens its panel, the fuse box the accounts drawer, the rest their pop-up. */
function onFixture(state: AgencyUi, event: Extract<StageEvent, { type: 'fixture' }>): AgencyUi {
  switch (event.fixture) {
    case 'rack': return next(state, roomView(event.room, 'rack'));
    case 'fuse': return onOpen(state, 'accounts');
    case 'board':
    case 'library':
    case 'notes':
    case 'schedule':
    case 'wins':
      return onModal(state, { kind: event.fixture });
    case 'jira': return onModal(state, { kind: 'jira', room: event.room });
    case 'tv': return onModal(state, { kind: 'fleet' });
    case 'clock': return onModal(state, { kind: 'timeline' });
    case 'robot': return onModal(state, { kind: 'help' });
    case 'links': return onModal(state, { kind: 'links', room: event.room });
  }
}

/** The spot of an empty slot's key (`lot-<position>`); null for any other key. */
export function lotPosition(key: string): number | null {
  if (!key.startsWith(LOT_PREFIX)) return null;
  const position = Number(key.slice(LOT_PREFIX.length));
  return Number.isInteger(position) && position >= 0 ? position : null;
}

function onStage(state: AgencyUi, event: StageEvent): AgencyUi {
  switch (event.type) {
    case 'room': {
      // A tap on an empty slot offers a new room there.
      const lot = event.room === null ? null : lotPosition(event.room);
      if (lot !== null) return onModal(state, { kind: 'rooms', position: lot });
      return next(state, event.room === null ? OFFICE : roomView(event.room, 'room'));
    }
    case 'actor': return next(state, actorView(event.id));
    case 'menu': return next(state, { ...state, selectedId: event.id, menu: { id: event.id, x: event.x, y: event.y } });
    case 'fixture': return onFixture(state, event);
    case 'hover': return state;
  }
}

function onFocus(state: AgencyUi, focus: StageFocus): AgencyUi {
  if (focus.kind === 'room') {
    const lot = lotPosition(focus.room);
    return lot === null ? next(state, roomView(focus.room, 'room')) : onModal(state, { kind: 'rooms', position: lot });
  }
  return next(state, focus.kind === 'actor' ? actorView(focus.id) : OFFICE);
}

const actorPanel = (panel: PanelKind | null | undefined): boolean => panel === 'agent' || panel === 'manager';

/** A drawer goes over the open panel (remembered in `under`); another panel simply replaces what is open. */
function onOpen(state: AgencyUi, panel: PanelKind): AgencyUi {
  if (state.panel === panel) return state;
  const base = { ...plain(state), menu: null, panel };
  if (!isDrawer(panel)) return next(state, base);
  const under = isDrawer(state.panel) ? state.under : (state.panel ?? undefined);
  return next(state, under === undefined ? base : { ...base, under });
}

const sameModal = (a: ModalState | null, b: ModalState): boolean =>
  a !== null && a.kind === b.kind && a.room === b.room && a.itemId === b.itemId && a.noteId === b.noteId && a.issueKey === b.issueKey
  && a.position === b.position && a.add === b.add;

/** A pop-up opens over whatever is open (the panel stays under it); the menu and note box close. */
function onModal(state: AgencyUi, modal: ModalState): AgencyUi {
  if (sameModal(state.modal, modal)) return state;
  const under = state.under === undefined ? {} : { under: state.under };
  return next(state, { ...plain(state), menu: null, ...under, modal: Object.freeze({ ...modal }) });
}

/**
 * Esc and close: the note box first, then the menu, then the pop-up, then a drawer (back to its panel), then the
 * panel, then the office.
 */
function onClose(state: AgencyUi): AgencyUi {
  if (state.note !== undefined) return next(state, { ...plain(state), ...(state.under === undefined ? {} : { under: state.under }) });
  if (state.menu !== null) return next(state, { ...state, menu: null });
  if (state.modal !== null) return next(state, { ...state, modal: null });
  if (isDrawer(state.panel)) return next(state, { ...plain(state), panel: state.under ?? null });
  if (state.panel !== null) return next(state, { ...plain(state), panel: null, selectedId: null });
  return next(state, OFFICE);
}

/** The need after the current selection, wrapping; the first one when the selection is not waiting; null when none. */
export function nextNeedId(needs: readonly string[], selectedId: string | null): string | null {
  if (needs.length === 0) return null;
  const at = selectedId === null ? -1 : needs.indexOf(selectedId);
  return needs[(at + 1) % needs.length] ?? null;
}

function onNextNeed(state: AgencyUi, needs: readonly string[]): AgencyUi {
  const id = nextNeedId(needs, state.selectedId);
  return id === null ? state : next(state, actorView(id));
}

function onGone(state: AgencyUi, ids: readonly string[]): AgencyUi {
  const gone = new Set(ids);
  const lostSelection = state.selectedId !== null && gone.has(state.selectedId);
  const note = state.note !== undefined && !gone.has(state.note.id) ? { note: state.note } : {};
  const under = state.under !== undefined && !(lostSelection && actorPanel(state.under)) ? { under: state.under } : {};
  return next(state, {
    focus: state.focus.kind === 'actor' && gone.has(state.focus.id) ? ALL : state.focus,
    selectedId: lostSelection ? null : state.selectedId,
    panel: lostSelection && actorPanel(state.panel) ? null : state.panel,
    menu: state.menu !== null && gone.has(state.menu.id) ? null : state.menu,
    ...note,
    ...under,
  });
}

/** What the office shows and which panel and pop-up are open, from stage taps and owner actions. */
export function reduceAgencyUi(state: AgencyUi, action: AgencyUiAction): AgencyUi {
  switch (action.type) {
    case 'stage': return onStage(state, action.event);
    case 'focus': return onFocus(state, action.focus);
    case 'select':
      if (action.id !== null) return next(state, actorView(action.id));
      return next(state, { ...plain(state), selectedId: null, menu: null, panel: actorPanel(state.panel) ? null : state.panel });
    case 'close': return onClose(state);
    case 'next-need': return onNextNeed(state, action.needs);
    case 'gone': return onGone(state, action.ids);
    case 'note': return next(state, { ...state, menu: null, note: { id: action.id, x: action.x, y: action.y } });
    case 'open': return onOpen(state, action.panel);
    case 'modal': return onModal(state, action.modal);
    case 'modal.close': return state.modal === null ? state : next(state, { ...state, modal: null });
  }
}
