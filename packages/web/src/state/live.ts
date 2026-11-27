import type { SessionDetailDTO, WsServerMessage } from '@luady/shared';
import { applySteps, emptyDetail, followPause, mergeActivity, mergeDetail, upsertNotice } from './activity.js';
import { removeCards, upsertCards } from './board.js';
import { removeMission, upsertMission } from './missions.js';
import type { AppState } from './reducer.js';
import { dropSaid, receiveSaid } from './said.js';

type LiveMessage = Extract<WsServerMessage, {
  type: 'activity.updated' | 'steps.appended' | 'notice.created' | 'notice.updated' | 'presence.updated' | 'accounts.changed'
    | 'board.updated' | 'board.removed' | 'mission.updated' | 'mission.removed' | 'session.said' | 'notes.changed' | 'kb.changed'
    | 'library.changed' | 'jira.changed' | 'schedules.changed' | 'links.changed' | 'prefs.changed';
}>;
type StepCMessage = Extract<LiveMessage, { type: 'board.updated' | 'board.removed' | 'mission.updated' | 'mission.removed' | 'session.said' }>;

const without = <T>(record: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> =>
  Object.hasOwn(record, id) ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== id)) : record;

/** Open agent views follow pause changes on the map; views of other sessions keep their objects. */
function onActivity(state: AppState, items: Extract<LiveMessage, { type: 'activity.updated' }>['items']): AppState {
  const activity = mergeActivity(state.activity, items);
  if (activity === state.activity) return state;
  const changed = Object.entries(state.details).filter(([id, detail]) => followPause(detail, activity[id]) !== detail);
  const details = changed.length === 0
    ? state.details
    : { ...state.details, ...Object.fromEntries(changed.map(([id, detail]) => [id, followPause(detail, activity[id])])) };
  return { ...state, activity, details };
}

function onSteps(state: AppState, message: Extract<LiveMessage, { type: 'steps.appended' }>): AppState {
  const detail = Object.hasOwn(state.details, message.sessionId) ? state.details[message.sessionId] : undefined;
  if (detail === undefined) return state;
  return { ...state, details: { ...state.details, [message.sessionId]: applySteps(detail, message) } };
}

/** The board, missions and speech. */
function onStepC(state: AppState, message: StepCMessage): AppState {
  switch (message.type) {
    case 'board.updated': return { ...state, board: upsertCards(state.board, message.items) };
    case 'board.removed': return { ...state, board: removeCards(state.board, message.ids) };
    case 'mission.updated': return { ...state, missions: upsertMission(state.missions, message.mission) };
    case 'mission.removed': return { ...state, missions: removeMission(state.missions, message.sessionId) };
    case 'session.said': {
      const { type: _type, ...said } = message;
      return { ...state, said: receiveSaid(state.said, said) };
    }
  }
}

/** The live-activity server messages, and the live board, missions, speech and refetch signals. */
export function applyLiveMessage(state: AppState, message: LiveMessage): AppState {
  switch (message.type) {
    case 'activity.updated': return onActivity(state, message.items);
    case 'steps.appended': return onSteps(state, message);
    case 'notice.created':
    case 'notice.updated':
      return { ...state, notices: upsertNotice(state.notices, message.notice) };
    case 'presence.updated': return { ...state, presence: message.presence, presenceVersion: state.presenceVersion + 1 };
    case 'accounts.changed': return { ...state, accountsVersion: state.accountsVersion + 1 };
    case 'notes.changed': return { ...state, notesVersion: state.notesVersion + 1 };
    case 'kb.changed': return { ...state, kbVersion: state.kbVersion + 1 };
    case 'library.changed': return { ...state, libraryVersion: state.libraryVersion + 1 };
    case 'jira.changed': return { ...state, jiraVersion: state.jiraVersion + 1 };
    case 'schedules.changed': return { ...state, schedulesVersion: state.schedulesVersion + 1 };
    case 'links.changed': return { ...state, linksVersion: state.linksVersion + 1 };
    case 'prefs.changed': return { ...state, prefsVersion: state.prefsVersion + 1 };
    default: return onStepC(state, message);
  }
}

/** An agent view opened: steps from the socket are kept from now on, even before its detail loads. */
export function openDetail(state: AppState, sessionId: string): AppState {
  if (Object.hasOwn(state.details, sessionId)) return state;
  const paused = Object.hasOwn(state.activity, sessionId) && state.activity[sessionId]?.paused === true;
  return { ...state, details: { ...state.details, [sessionId]: { ...emptyDetail(sessionId), paused } } };
}

/** A loaded detail lands only while its view is open (a late answer after closing is dropped). */
export function loadDetail(state: AppState, loaded: SessionDetailDTO): AppState {
  const prev = Object.hasOwn(state.details, loaded.sessionId) ? state.details[loaded.sessionId] : undefined;
  if (prev === undefined) return state;
  return { ...state, details: { ...state.details, [loaded.sessionId]: mergeDetail(prev, loaded) } };
}

export function closeDetail(state: AppState, sessionId: string): AppState {
  const details = without(state.details, sessionId);
  return details === state.details ? state : { ...state, details };
}

/** session.removed: its live record, open view and last speech go too. */
export function dropSession(state: AppState, sessionId: string): AppState {
  return {
    ...state, activity: without(state.activity, sessionId), details: without(state.details, sessionId), said: dropSaid(state.said, sessionId),
  };
}
