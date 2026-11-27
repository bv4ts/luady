import type { AppState } from '../../../state/reducer.js';
import type { SoundKind } from './engine.js';

/** What the store looks like for the sounds: ids per kind of event; null where that part has not loaded yet. */
export interface SoundView {
  /** +1 on every fresh overview load: what a reload brings is not news. */
  readonly loadKey: number;
  readonly luady: ReadonlySet<string> | null;
  readonly done: ReadonlySet<string> | null;
  readonly asks: ReadonlySet<string> | null;
  readonly sessions: ReadonlySet<string> | null;
}

/** A Luady message older than this when it shows up (an older page loaded in the chat) is history, not news. */
export const FRESH_MESSAGE_MS = 120_000;

/** The ids the sounds compare, from the store. `now` decides which Luady messages are fresh. */
export function soundView(state: AppState, now: number): SoundView {
  const luady = state.luadyThread.loaded
    ? new Set(state.luadyThread.items.filter((m) => (m.role === 'manager' || m.role === 'assistant') && now - Date.parse(m.ts) < FRESH_MESSAGE_MS).map((m) => m.id))
    : null;
  const done = state.board.loaded
    ? new Set(Object.values(state.board.cards).filter((card) => card.state === 'done').map((card) => String(card.id)))
    : null;
  return {
    loadKey: state.overviewVersion,
    luady,
    done,
    asks: state.loaded ? new Set(state.questions.map((question) => question.qid)) : null,
    sessions: state.loaded ? new Set(state.sessions.map((session) => session.id)) : null,
  };
}

const added = (prev: ReadonlySet<string> | null, next: ReadonlySet<string> | null): boolean =>
  prev !== null && next !== null && [...next].some((id) => !prev.has(id));

/**
 * The one sound for what changed, loudest news first: a card done (ding), something that needs the owner (blip), a
 * message from Luady (pop), a session that arrived (step). Nothing for the first view or a reload.
 */
export function soundFor(prev: SoundView | null, next: SoundView): SoundKind | null {
  if (prev === null || prev.loadKey !== next.loadKey) return null;
  if (added(prev.done, next.done)) return 'ding';
  if (added(prev.asks, next.asks)) return 'blip';
  if (added(prev.luady, next.luady)) return 'pop';
  if (added(prev.sessions, next.sessions)) return 'step';
  return null;
}
