import { MUTE_PALETTE, type Palette } from '@luady/office';
import { ROOM_ID_RE, type BoardEventKind, type BoardItemDTO, type BoardSource, type QuestionDTO, type RoomDTO, type SessionDTO, managerName } from '@luady/shared';
import { roomOfSession } from '../../../../state/rooms.js';
import { roomLookup, type RoomLookup } from '../../../rooms/room-lookup.js';
import { stateWords } from '../../model/words.js';

/** The office a card belongs to, by name ("Orchard"); null without a server. A card's server is a host. */
export function officeName(server: string | null, lookup: RoomLookup): string | null {
  return server === null ? null : lookup.hostLabel(server);
}

/** The colour on a card's edge: its office's room colours, grey without one. */
export function cardPalette(card: Pick<BoardItemDTO, 'server'>, lookup: RoomLookup): Palette {
  return card.server === null ? MUTE_PALETTE : lookup.roomPalette(card.server);
}

/** A session's room colours: the room it sits in, else its host's home room (HQ's for the manager's own). */
export function sessionPalette(session: Pick<SessionDTO, 'host' | 'project' | 'cwd'>, rooms: readonly RoomDTO[]): Palette {
  const lookup = roomLookup(rooms);
  const place = roomOfSession({ rooms }, session);
  return lookup.roomPalette(place === null ? session.host : place.room);
}

const SOURCE_WORDS: Readonly<Record<BoardSource, string>> = Object.freeze({
  web: 'Added on the website',
  chat: 'Added from your chat channel',
  manager: `Added by ${managerName()}`,
  meeting: 'From a meeting',
  jira: 'From Jira',
  note: 'From a note',
  session: 'From a session',
});

export function sourceWords(source: BoardSource): string {
  return SOURCE_WORDS[source];
}

/** What a reference points at, for a link: a note, a Jira ticket or a session. */
export type SourceLink =
  | { readonly kind: 'note'; readonly noteId: string }
  | { readonly kind: 'jira'; readonly room: string; readonly key: string }
  | { readonly kind: 'session'; readonly sessionId: string };

/** `<room id>:<ticket key>`: the room part follows the room-id grammar. */
const JIRA_REF = new RegExp(`^(${ROOM_ID_RE.source.slice(1, -1)}):([A-Z][A-Z0-9_]{1,19}-\\d{1,7})$`);

/** The link behind a card's source reference, when the website can open it. */
export function sourceLink(card: Pick<BoardItemDTO, 'source' | 'sourceRef'>): SourceLink | null {
  const ref = card.sourceRef;
  if (ref === null) return null;
  if (card.source === 'jira') {
    const match = JIRA_REF.exec(ref);
    const room = match?.[1];
    const key = match?.[2];
    return room === undefined || key === undefined ? null : { kind: 'jira', room, key };
  }
  if (card.source === 'note' || card.source === 'meeting') {
    if (/^[mn]:/.test(ref)) return { kind: 'note', noteId: ref };
    return { kind: 'note', noteId: card.source === 'meeting' ? `m:${ref}` : `n:${ref}` };
  }
  if (card.source === 'session') return { kind: 'session', sessionId: ref };
  return null;
}

/** The words for a session on a card: "working", "waiting for you", "failed". */
export function sessionStateWords(session: SessionDTO | undefined): string {
  if (session === undefined) return 'session ended';
  if (session.state === 'ended' && session.unexpectedEnd) return 'stopped unexpectedly';
  return stateWords(session.state);
}

/** Why a card is in Needs you, in one short line. */
export function needsReason(card: BoardItemDTO, session: SessionDTO | undefined, question: QuestionDTO | undefined): string {
  if (card.state === 'running' && session !== undefined) {
    if (session.state === 'waiting_permission' || question?.kind === 'permission') return 'Waiting for your permission';
    if (session.state === 'waiting_question') return 'Waiting for your answer';
    if (session.state === 'error' || session.unexpectedEnd) return 'The session failed';
  }
  return card.result ?? 'Needs a look from you';
}

/** A running card's line: queued cards wait for Luady to plan them. */
export function runningLine(card: BoardItemDTO, session: SessionDTO | undefined): string {
  if (card.state === 'queued') return `Waiting for ${managerName()}`;
  if (session === undefined) return card.sessionId === null ? 'Starting' : 'Session ended';
  return `${session.displayName} · ${sessionStateWords(session)}`;
}

const EVENT_WORDS: Readonly<Record<BoardEventKind, string>> = Object.freeze({
  created: 'Added', edited: 'Edited', queued: `Sent to ${managerName()}`, started: 'Started', report: 'Report', blocked: 'Blocked',
  done: 'Done', reopened: 'Back to To do', note: 'Note',
});

export function eventWords(kind: BoardEventKind): string {
  return EVENT_WORDS[kind];
}

/** "1 card", "3 cards". */
export function cardCount(count: number): string {
  return count === 1 ? '1 card' : `${String(count)} cards`;
}

/** The label of what is given: the title of one card, else the count. */
export function cardsLabel(cards: readonly Pick<BoardItemDTO, 'title'>[]): string {
  const [only] = cards;
  if (cards.length === 1 && only !== undefined) return `"${only.title.length > 48 ? `${only.title.slice(0, 47)}…` : only.title}"`;
  return cardCount(cards.length);
}
