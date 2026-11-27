import type {
  AccountsDTO, ActionDTO, BoardItemDTO, ChannelInfoDTO, ChatMessageDTO, HostDTO, LuadyStatusDTO, MissionDTO, NoticeDTO, OverviewDTO,
  PresenceDTO, QuestionDTO, RoomDTO, SaidDTO, ServerDTO, SetupStateDTO, WebPrefsDTO, SessionActivityDTO, SessionDTO, SessionDetailDTO,
  TranscriptItemDTO, WsServerMessage,
} from '@luady/shared';
import type { WsStatus } from '../api/ws.js';
import { applyLiveMessage, closeDetail, dropSession, loadDetail, openDetail } from './live.js';
import { upsertChannel } from './rooms.js';
import { loadActivity, loadNotices } from './activity.js';
import { EMPTY_BOARD, loadBoard, type BoardSlice } from './board.js';
import { EMPTY_MISSIONS, loadMissions, type MissionMap } from './missions.js';
import { EMPTY_PREFS, loadPrefs, type PrefsSlice } from './prefs.js';
import { EMPTY_SAID, loadSaid, type SaidSlice } from './said.js';
import { removeBy, upsertBy } from './merge.js';
import {
  EMPTY_THREAD, EMPTY_TRANSCRIPT, addPending, appendTranscript, dropPending, loadThread, loadTranscript, markPendingSent,
  olderThread, olderTranscript, receiveLuadyMessage, type LuadyThread, type TranscriptState,
} from './threads.js';

export type { LuadyThread, PendingLuadyMessage, TranscriptState } from './threads.js';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

export interface AppState {
  readonly loaded: boolean;
  /** +1 on every overview load (the first one and each one after a reconnect): the office seats what it brings. */
  readonly overviewVersion: number;
  readonly servers: readonly ServerDTO[];
  readonly sessions: readonly SessionDTO[];
  readonly questions: readonly QuestionDTO[];
  readonly actions: readonly ActionDTO[];
  readonly luady: LuadyStatusDTO | null;
  readonly transcripts: Readonly<Record<string, TranscriptState>>;
  readonly luadyThread: LuadyThread;
  readonly connection: { readonly status: WsStatus; readonly epoch: number };
  readonly toasts: readonly Toast[];
  readonly nextToastId: number;
  /** The slim live record per session (drives the map). Empty with an older hub. */
  readonly activity: Readonly<Record<string, SessionActivityDTO>>;
  /** Only for agent views that are open. */
  readonly details: Readonly<Record<string, SessionDetailDTO>>;
  /** Newest first, at most 100. */
  readonly notices: readonly NoticeDTO[];
  readonly presence: PresenceDTO | null;
  /** +1 on every pushed presence.updated: a reading requested before the latest push is older than it. */
  readonly presenceVersion: number;
  readonly accounts: AccountsDTO | null;
  /** +1 on every accounts.changed: the accounts drawer reloads when it moves. */
  readonly accountsVersion: number;
  /** Servers that answered kit_too_old to a pause: the pause item is hidden for them from then on. */
  readonly pauseRefused: readonly string[];
  /** The owner's board (empty and not loaded with an older hub). */
  readonly board: BoardSlice;
  /** The missions Luady runs now, by session id. */
  readonly missions: MissionMap;
  /** What each session said last, with arrival numbers. */
  readonly said: SaidSlice;
  /** +1 on every notes.changed / kb.changed / library.changed / jira.changed; the views reload when they move. */
  readonly notesVersion: number;
  readonly kbVersion: number;
  readonly libraryVersion: number;
  readonly jiraVersion: number;
  /** The website preferences (the defaults with an older hub). */
  readonly prefs: PrefsSlice;
  /** +1 on every prefs.changed (the store reloads the prefs), schedules.changed and links.changed. */
  readonly prefsVersion: number;
  readonly schedulesVersion: number;
  readonly linksVersion: number;
  /** The office's rooms (overview, then `rooms.changed` and the answers to room writes). */
  readonly rooms: readonly RoomDTO[];
  /** The hosts from `hosts.changed`; null until the hub sends a list. */
  readonly hosts: readonly HostDTO[] | null;
  /** The declared channels (overview, then `channel.status`). */
  readonly channels: readonly ChannelInfoDTO[];
  /** The setup state from `setup.changed`; null until one arrives. */
  readonly setup: SetupStateDTO | null;
  /** The room of the last `jira.changed` (with jiraVersion): a view of another room's board need not reload. */
  readonly jiraRoom: string | null;
}

export const initialState: AppState = {
  loaded: false, overviewVersion: 0, servers: [], sessions: [], questions: [], actions: [], luady: null, transcripts: {},
  luadyThread: EMPTY_THREAD, connection: { status: 'idle', epoch: 0 }, toasts: [], nextToastId: 1,
  activity: {}, details: {}, notices: [], presence: null, presenceVersion: 0, accounts: null, accountsVersion: 0, pauseRefused: [],
  board: EMPTY_BOARD, missions: EMPTY_MISSIONS, said: EMPTY_SAID, notesVersion: 0, kbVersion: 0, libraryVersion: 0, jiraVersion: 0,
  prefs: EMPTY_PREFS, prefsVersion: 0, schedulesVersion: 0, linksVersion: 0,
  rooms: [], hosts: null, channels: [], setup: null, jiraRoom: null,
};

type Page<T> = { items: readonly T[]; nextCursor: string | null };

export type AppAction =
  | { type: 'overview.loaded'; overview: OverviewDTO }
  | { type: 'ws.message'; message: WsServerMessage }
  | { type: 'connection.changed'; status: WsStatus; epoch: number }
  | { type: 'question.removed'; qid: string }
  | { type: 'action.removed'; id: string }
  | { type: 'transcript.opened'; sessionId: string }
  | ({ type: 'transcript.loaded'; sessionId: string } & Page<TranscriptItemDTO>)
  | ({ type: 'transcript.older'; sessionId: string } & Page<TranscriptItemDTO>)
  | { type: 'transcript.closed'; sessionId: string }
  | ({ type: 'luady.loaded' } & Page<ChatMessageDTO>)
  | ({ type: 'luady.older' } & Page<ChatMessageDTO>)
  | { type: 'luady.pending'; localId: string; text: string; ts: string }
  | { type: 'luady.pendingSent'; localId: string }
  | { type: 'luady.pendingFailed'; localId: string }
  | { type: 'toast.push'; kind: ToastKind; text: string }
  | { type: 'toast.dismiss'; id: number }
  | { type: 'activity.loaded'; items: readonly SessionActivityDTO[] }
  | { type: 'detail.opened'; sessionId: string }
  | { type: 'detail.loaded'; detail: SessionDetailDTO }
  | { type: 'detail.closed'; sessionId: string }
  | { type: 'notices.loaded'; items: readonly NoticeDTO[] }
  /** `version`: presenceVersion when the request went out; a push that came after it wins. */
  | { type: 'presence.loaded'; presence: PresenceDTO; version?: number }
  | { type: 'accounts.loaded'; accounts: AccountsDTO }
  | { type: 'pause.refused'; host: string }
  | { type: 'board.loaded'; items: readonly BoardItemDTO[] }
  | { type: 'missions.loaded'; items: readonly MissionDTO[] }
  | { type: 'said.loaded'; items: readonly SaidDTO[] }
  | { type: 'prefs.loaded'; prefs: WebPrefsDTO }
  /** The rooms from `GET /api/rooms` or the answer to a room write (the map follows at once, before `rooms.changed`). */
  | { type: 'rooms.loaded'; rooms: readonly RoomDTO[] }
  /** A room the owner just created or saved; a room just removed. */
  | { type: 'room.saved'; room: RoomDTO }
  | { type: 'room.removed'; id: string };

const MAX_TOASTS = 4;
const byQid = (question: QuestionDTO): string => question.qid;
const byActionId = (action: ActionDTO): string => action.id;
const bySessionId = (session: SessionDTO): string => session.id;
const byServerName = (server: ServerDTO): string => server.name;
const byRoomId = (room: RoomDTO): string => room.id;

function withQuestions(state: AppState, questions: readonly QuestionDTO[]): AppState {
  return questions === state.questions ? state : { ...state, questions };
}

function withActions(state: AppState, actions: readonly ActionDTO[]): AppState {
  return actions === state.actions ? state : { ...state, actions };
}

function setTranscript(state: AppState, sessionId: string, value: TranscriptState): AppState {
  return { ...state, transcripts: { ...state.transcripts, [sessionId]: value } };
}

function updateTranscript(state: AppState, sessionId: string, update: (prev: TranscriptState) => TranscriptState): AppState {
  const prev = state.transcripts[sessionId];
  if (!prev) return state;
  const next = update(prev);
  return next === prev ? state : setTranscript(state, sessionId, next);
}

function closeTranscript(state: AppState, sessionId: string): AppState {
  if (!Object.hasOwn(state.transcripts, sessionId)) return state;
  return { ...state, transcripts: Object.fromEntries(Object.entries(state.transcripts).filter(([id]) => id !== sessionId)) };
}

function applyOverview(state: AppState, overview: OverviewDTO): AppState {
  return {
    ...state,
    loaded: true,
    overviewVersion: state.overviewVersion + 1,
    servers: overview.servers,
    sessions: overview.sessions.filter((session) => session.origin !== 'system'),
    questions: overview.questions.filter((question) => question.state === 'pending'),
    actions: overview.actions.filter((action) => action.status === 'pending_confirmation'),
    luady: overview.manager,
    rooms: overview.rooms,
    channels: overview.channels,
  };
}

function applyMessage(state: AppState, message: WsServerMessage): AppState {
  switch (message.type) {
    case 'hello':
      return state;
    case 'server.updated':
      return { ...state, servers: upsertBy(state.servers, message.server, byServerName) };
    case 'session.updated':
      return message.session.origin === 'system' ? state : { ...state, sessions: upsertBy(state.sessions, message.session, bySessionId) };
    case 'session.removed':
      return dropSession({ ...state, sessions: removeBy(state.sessions, message.id, bySessionId) }, message.id);
    case 'question.updated':
      return withQuestions(state, message.question.state === 'pending'
        ? upsertBy(state.questions, message.question, byQid)
        : removeBy(state.questions, message.question.qid, byQid));
    case 'action.updated':
      return withActions(state, message.action.status === 'pending_confirmation'
        ? upsertBy(state.actions, message.action, byActionId)
        : removeBy(state.actions, message.action.id, byActionId));
    case 'manager.message':
      return { ...state, luadyThread: receiveLuadyMessage(state.luadyThread, message.message) };
    case 'manager.status':
      return { ...state, luady: message.status };
    case 'transcript.appended':
      return updateTranscript(state, message.sessionId, (prev) => appendTranscript(prev, message.items));
    case 'activity.updated':
    case 'steps.appended':
    case 'notice.created':
    case 'notice.updated':
    case 'presence.updated':
    case 'accounts.changed':
    case 'board.updated':
    case 'board.removed':
    case 'mission.updated':
    case 'mission.removed':
    case 'session.said':
    case 'notes.changed':
    case 'kb.changed':
    case 'library.changed':
    case 'schedules.changed':
    case 'links.changed':
    case 'prefs.changed':
      return applyLiveMessage(state, message);
    case 'jira.changed':
      // The room whose Jira changed.
      return { ...applyLiveMessage(state, message), jiraRoom: message.room };
    // The full lists replace what the store has; host jobs and their logs are followed through useWsMessage.
    case 'rooms.changed':
      return { ...state, rooms: message.rooms };
    case 'hosts.changed':
      return { ...state, hosts: message.hosts };
    case 'channel.status':
      return { ...state, channels: upsertChannel(state.channels, message.channel) };
    case 'setup.changed':
      return { ...state, setup: message.state };
    case 'host.job':
    case 'host.log':
      return state;
  }
}

function pushToast(state: AppState, kind: ToastKind, text: string): AppState {
  const toasts = [...state.toasts, { id: state.nextToastId, kind, text }].slice(-MAX_TOASTS);
  return { ...state, toasts, nextToastId: state.nextToastId + 1 };
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'overview.loaded': return applyOverview(state, action.overview);
    case 'ws.message': return applyMessage(state, action.message);
    case 'connection.changed': return { ...state, connection: { status: action.status, epoch: action.epoch } };
    case 'question.removed': return withQuestions(state, removeBy(state.questions, action.qid, byQid));
    case 'action.removed': return withActions(state, removeBy(state.actions, action.id, byActionId));
    case 'transcript.opened':
      return state.transcripts[action.sessionId] ? state : setTranscript(state, action.sessionId, EMPTY_TRANSCRIPT);
    case 'transcript.loaded':
      return setTranscript(state, action.sessionId, loadTranscript(state.transcripts[action.sessionId], action.items, action.nextCursor));
    case 'transcript.older':
      return updateTranscript(state, action.sessionId, (prev) => olderTranscript(prev, action.items, action.nextCursor));
    case 'transcript.closed': return closeTranscript(state, action.sessionId);
    case 'luady.loaded': return { ...state, luadyThread: loadThread(state.luadyThread, action.items, action.nextCursor) };
    case 'luady.older': return { ...state, luadyThread: olderThread(state.luadyThread, action.items, action.nextCursor) };
    case 'luady.pending': return { ...state, luadyThread: addPending(state.luadyThread, action.localId, action.text, action.ts) };
    case 'luady.pendingSent': return { ...state, luadyThread: markPendingSent(state.luadyThread, action.localId) };
    case 'luady.pendingFailed': return { ...state, luadyThread: dropPending(state.luadyThread, action.localId) };
    case 'toast.push': return pushToast(state, action.kind, action.text);
    case 'toast.dismiss': return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    case 'activity.loaded': return { ...state, activity: loadActivity(state.activity, action.items) };
    case 'detail.opened': return openDetail(state, action.sessionId);
    case 'detail.loaded': return loadDetail(state, action.detail);
    case 'detail.closed': return closeDetail(state, action.sessionId);
    case 'notices.loaded': return { ...state, notices: loadNotices(action.items) };
    case 'presence.loaded':
      return action.version !== undefined && action.version !== state.presenceVersion ? state : { ...state, presence: action.presence };
    case 'accounts.loaded': return { ...state, accounts: action.accounts };
    case 'pause.refused':
      return state.pauseRefused.includes(action.host) ? state : { ...state, pauseRefused: [...state.pauseRefused, action.host] };
    case 'board.loaded': return { ...state, board: loadBoard(state.board, action.items) };
    case 'missions.loaded': return { ...state, missions: loadMissions(action.items) };
    case 'said.loaded': return { ...state, said: loadSaid(state.said, action.items) };
    case 'prefs.loaded': return { ...state, prefs: loadPrefs(state.prefs, action.prefs) };
    case 'rooms.loaded': return { ...state, rooms: action.rooms };
    case 'room.saved': return { ...state, rooms: upsertBy(state.rooms, action.room, byRoomId) };
    case 'room.removed': return { ...state, rooms: removeBy(state.rooms, action.id, byRoomId) };
  }
}
