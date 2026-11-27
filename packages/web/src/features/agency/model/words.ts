import { visualFor, type BubbleIcon, type LuadyView } from '@luady/office';
import type { SessionActivityDTO, ToolKind } from '@luady/shared';

/** Session states the way the owner says them. */
const SESSION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  working: 'working',
  waiting_question: 'waiting for you',
  waiting_permission: 'waiting for you',
  idle: 'idle',
  error: 'failed',
  starting: 'starting',
  ended: 'ended',
});

const LUADY_WORDS: Readonly<Record<LuadyView['state'], string>> = Object.freeze({
  running: 'ready', busy: 'thinking', starting: 'starting', down: 'offline', off: 'switched off',
});

/** A session state in plain words; a state from a newer hub is shown as written. */
export function stateWords(state: string): string {
  return Object.hasOwn(SESSION_WORDS, state) ? (SESSION_WORDS[state] ?? state) : state.replaceAll('_', ' ');
}

/** The manager's state in words; `off`: the owner switched the manager off (a calm state, not "offline"). */
export function luadyWords(state: LuadyView['state']): string {
  return LUADY_WORDS[state];
}

/** A server link that is not up, in words; null while it is online (or for rooms without a server). */
export function linkDown(status: 'online' | 'offline' | 'connecting' | null | undefined): 'offline' | 'connecting' | null {
  return status === 'offline' || status === 'connecting' ? status : null;
}

/** What the owner should know about a room whose server is not online. */
export function linkNotice(down: 'offline' | 'connecting'): string {
  const lead = down === 'offline' ? 'This server is offline.' : 'Luady is reconnecting to this server.';
  return `${lead} What you see here may be out of date.`;
}

/** "1 session", "3 sessions": the word the docs and the rest of the page use. */
export function sessionCount(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

/** First line of a chat message without markdown marks, for one-line previews. */
export function plainLine(text: string, max = 140): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '';
  const plain = line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+)/, '').replace(/[*_`~]/g, '');
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

/** What an agent does, from the map's slim record (it carries the tool kind, not the title). */
const DOING_WORDS: Readonly<Record<ToolKind, string>> = Object.freeze({
  read: 'reading', edit: 'editing', run: 'running a command', search: 'searching', web: 'on the web',
  skill: 'using a skill', agent: 'with a helper', plan: 'planning', mail: 'writing mail', other: 'working',
});

/** The bubble and words for what an agent is doing now: "paused" for a paused one; null when it does nothing. */
export function doingOf(state: string, activity: SessionActivityDTO | undefined): { icon: BubbleIcon; words: string } | null {
  if (activity === undefined) return null;
  if (activity.paused && (state === 'working' || state === 'idle')) return { icon: 'pause', words: 'paused' };
  if (activity.tool === null || state !== 'working') return null;
  const icon = visualFor({ state: 'working', idleMs: 0, silentMs: 0, tool: activity.tool }).bubble ?? 'dots';
  return { icon, words: DOING_WORDS[activity.tool] };
}
