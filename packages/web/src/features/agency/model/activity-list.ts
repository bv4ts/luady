import type { Palette } from '@luady/office';
import type { RoomDTO, SessionActivityDTO, SessionDTO, ToolKind } from '@luady/shared';
import { roomOfSession } from '../../../state/rooms.js';
import { roomLookup } from '../../rooms/room-lookup.js';

/** One working session in the Activity pop-up. */
export interface ActivityRow {
  readonly id: string;
  readonly name: string;
  /** The name of the room it sits in ("Orchard"), else its host as the owner knows it. */
  readonly room: string;
  readonly palette: Palette;
  /** The current step's title ("Editing checkout.ts"); null when the hub has not said. */
  readonly step: string | null;
  /** The owner paused it: it stops after the current step. */
  readonly paused: boolean;
  /** Epoch ms when the running turn started; null when unknown. */
  readonly startedAt: number | null;
  readonly helpers: number;
  readonly helperTypes: readonly string[];
}

export interface ActivityCounts {
  readonly working: number;
  readonly helpers: number;
}

type ActivityMap = Readonly<Record<string, SessionActivityDTO>>;

const working = (sessions: readonly SessionDTO[]): readonly SessionDTO[] => sessions.filter((session) => session.state === 'working');

const parseMs = (iso: string | null | undefined): number | null => {
  const ms = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** What a tool does, in front of the step's bare title the hub sends ("checkout.ts" → "Editing checkout.ts"). */
const STEP_VERB: Readonly<Record<ToolKind, string>> = {
  read: 'Reading', edit: 'Editing', run: 'Running', search: 'Searching', web: 'Looking up', skill: 'Using', mail: 'Mail:',
  agent: 'Helper:', plan: 'Planning', other: '',
};

export function stepWords(tool: ToolKind | null | undefined, title: string | null | undefined): string | null {
  if (title === null || title === undefined || title.trim() === '') return null;
  const verb = tool === null || tool === undefined ? '' : STEP_VERB[tool];
  return verb === '' ? title : `${verb} ${title}`;
}

/** Working sessions and the helpers they run now. */
export function activityCounts(sessions: readonly SessionDTO[], activity: ActivityMap): ActivityCounts {
  const list = working(sessions);
  const helpers = list.reduce((sum, session) => sum + (activity[session.id]?.helpers ?? 0), 0);
  return { working: list.length, helpers };
}

/** "7 working · 4 helpers", "1 working", or "All quiet". */
export function pillWords(counts: ActivityCounts): string {
  if (counts.working === 0) return 'All quiet';
  const helpers = counts.helpers === 0 ? '' : ` · ${counts.helpers} ${counts.helpers === 1 ? 'helper' : 'helpers'}`;
  return `${counts.working} working${helpers}`;
}

/** The room a session sits in, by name and colours; a session on no room shows its host, in grey. */
function placeOf(session: SessionDTO, rooms: readonly RoomDTO[]): { name: string; palette: Palette } {
  const lookup = roomLookup(rooms);
  const place = roomOfSession({ rooms }, session);
  return place === null
    ? { name: lookup.hostLabel(session.host), palette: lookup.roomPalette(session.host) }
    : { name: lookup.roomName(place.room), palette: lookup.roomPalette(place.room) };
}

/** Every working session: longest-running turn first, then by name. */
export function activityRows(sessions: readonly SessionDTO[], activity: ActivityMap, rooms: readonly RoomDTO[]): readonly ActivityRow[] {
  const rows = working(sessions).map((session): ActivityRow => {
    const live = activity[session.id];
    const { name: room, palette } = placeOf(session, rooms);
    return {
      id: session.id, name: session.displayName, room, palette,
      step: stepWords(live?.tool, live?.title),
      paused: live?.paused ?? false,
      startedAt: parseMs(live?.turnStartedAt ?? session.turnStartedAt),
      helpers: live?.helpers ?? 0,
      helperTypes: live?.helperTypes ?? [],
    };
  });
  return rows.toSorted((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.name.localeCompare(b.name));
}

const MINUTE_MS = 60_000;

/** How long a turn has run: "just started", "for 4 min", "for 1 h 12 min"; null when unknown. */
export function turnWords(startedAt: number | null, now: number): string | null {
  if (startedAt === null) return null;
  const minutes = Math.floor(Math.max(0, now - startedAt) / MINUTE_MS);
  if (minutes < 1) return 'just started';
  if (minutes < 60) return `for ${minutes} min`;
  const rest = minutes % 60;
  return `for ${Math.floor(minutes / 60)} h${rest === 0 ? '' : ` ${rest} min`}`;
}

/** "Explore, code-reviewer" plus "and 2 more" when more helpers run than have a named type. */
export function helperWords(row: Pick<ActivityRow, 'helpers' | 'helperTypes'>): string | null {
  if (row.helpers === 0) return null;
  const named = row.helperTypes.slice(0, row.helpers);
  const extra = row.helpers - named.length;
  if (named.length === 0) return row.helpers === 1 ? '1 helper' : `${row.helpers} helpers`;
  return extra === 0 ? named.join(', ') : `${named.join(', ')} and ${extra} more`;
}
