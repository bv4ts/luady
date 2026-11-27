import { HQ_ID, type FixtureKind } from '@luady/office';
import type { StageTarget } from '../../stage-types.js';
import { hqName } from '../../../rooms/room-lookup.js';
import { managerName } from '@luady/shared';

/** One thing in the office that opens something, as Help explains it. */
export interface HelpFixture {
  readonly kind: FixtureKind;
  readonly title: string;
  /** What it opens, in one line. */
  readonly line: string;
  /** Where "Show me" flies the camera; null while the office has no room to show it in. */
  readonly target: StageTarget | null;
  /** Where it is, for an office fixture that every room has. */
  readonly where: string;
}

const hq = (kind: FixtureKind, title: string, line: string): HelpFixture =>
  ({ kind, title, line, target: { kind: 'fixture', id: `${kind}-${HQ_ID}` }, where: hqName() });

/** "Show me" for a fixture every room has goes to the first room's (its Jira board is always there). */
const office = (room: string | null) => (kind: FixtureKind, title: string, line: string): HelpFixture =>
  ({ kind, title, line, target: room === null ? null : { kind: 'fixture', id: `${kind}-${room}` }, where: 'Every room' });

/**
 * Every fixture, in the order a visitor would walk past them: HQ's north wall, its floor, then the rooms. `firstRoom` is
 * the room "Show me" uses for the fixtures every room has (null with no rooms: those have no "Show me").
 */
export function helpFixtures(firstRoom: string | null): readonly HelpFixture[] {
  const room = office(firstRoom);
  return Object.freeze([
    hq('board', 'Board', 'Your to-do board: what is to do, what runs, what needs you and what is done.'),
    hq('clock', 'Today', 'Today as one strip: what started, finished, asked and arrived since 6 AM.'),
    hq('library', 'Library', `Every project, the knowledge base ${managerName()} and the sessions read, and the skills of each office.`),
    hq('schedule', 'Schedule', `${managerName()}’s reminders and timed jobs, with their next run. Add one or cancel one.`),
    hq('tv', 'Fleet', 'Every server and account with the last 24 hours. A red dot means something is down or nearly full.'),
    hq('fuse', 'Accounts', 'The accounts and their limits; sign in, sign out and connections.'),
    hq('notes', 'Notes', `Meeting notes and your own notes. Send one to ${managerName()} or make it a card.`),
    hq('wins', 'Wins', 'What shipped this week, office by office.'),
    hq('robot', 'Help', 'This page.'),
    room('rack', 'Server', 'Each room’s server rack: load, memory, disk and versions.'),
    room('links', 'Links', 'Your own quick links for that room: Jira, GitHub, staging, stores.'),
    room('jira', 'Jira', 'Your Jira tickets for that room, without opening Jira.'),
  ]);
}

export interface HelpKey {
  readonly keys: readonly string[];
  readonly does: string;
}

export const HELP_KEYS: readonly HelpKey[] = Object.freeze([
  { keys: ['1', '–', '9'], does: 'Go to a room (HQ is 3; the Rooms menu reaches every room)' },
  { keys: ['0'], does: 'Show the whole office' },
  { keys: ['/'], does: `Type to ${managerName()}` },
  { keys: ['M'], does: 'Mute or unmute the sounds' },
  { keys: ['?'], does: 'Open this help' },
  { keys: ['Esc'], does: 'Close what is open' },
  { keys: ['Right-click'], does: 'A character’s menu (press and hold on a phone)' },
]);
