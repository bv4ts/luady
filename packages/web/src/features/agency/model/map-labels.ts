import { HQ_ID, TILE, isEmptySlot, roomRectPx, type AgencySnapshot, type FixtureDef, type Palette } from '@luady/office';
import { formatClock } from '../hud/Clock.js';
import type { Energy } from './energy.js';
import type { Badge, BadgeTone } from './hud-badges.js';

/** A chip on a fixture of the map: short text, a tone, and words for the tooltip. */
export interface MapBadge {
  readonly text: string;
  readonly tone: BadgeTone;
  readonly words: string;
  /** A dot instead of a number (the TV: something is down or nearly full). */
  readonly dot?: boolean;
}

/** The fleet, wins, schedule and links fixtures: what their badges count. Absent parts show no badge. */
export interface WaveTwoCounts {
  /** A server is offline or an account is at 95% or more. */
  readonly fleetAlert: boolean;
  /** Wins of the last 7 days. */
  readonly winsWeek: number;
  /** Schedules due in the next 24 hours. */
  readonly scheduleSoon: number;
  /** Each office's links, by server. */
  readonly links: Readonly<Record<string, number>>;
}

export interface FixtureBadgeInput extends Partial<WaveTwoCounts> {
  readonly board: Badge | null;
  /** Meeting notes that arrived since Notes was last opened. */
  readonly newNotes: number;
  /** The fullest account's 5-hour window; null without a reading. */
  readonly energy: Energy | null;
  /** Each office's tickets that need attention (JiraSiteDTO.attention), by server. */
  readonly jira: Readonly<Record<string, number | null>>;
}

/** "3 wins this week"; no badge for zero or an unknown count. */
function count(value: number | undefined, tone: BadgeTone, one: string, many: string): MapBadge | null {
  if (value === undefined || value <= 0) return null;
  return { text: String(value), tone, words: `${value} ${value === 1 ? one : many}` };
}

const ENERGY_TONE: Readonly<Record<Energy['tone'], BadgeTone>> = { ok: 'info', amber: 'warn', red: 'alert' };

/** Links and Jira sites are keyed by room: a fixture's room is its key. */
function badgeOf(fixture: FixtureDef, input: FixtureBadgeInput, serverOf: (room: string) => string | null): MapBadge | null {
  switch (fixture.kind) {
    case 'board':
      return input.board === null ? null : { text: String(input.board.count), tone: input.board.tone, words: input.board.words };
    case 'notes':
      return input.newNotes <= 0 ? null : {
        text: String(input.newNotes), tone: 'info', words: input.newNotes === 1 ? '1 new meeting note' : `${input.newNotes} new meeting notes`,
      };
    case 'fuse':
      return input.energy === null ? null : {
        text: `${input.energy.usedPct}%`, tone: ENERGY_TONE[input.energy.tone], words: `${input.energy.label} ${input.energy.usedPct}% of its 5-hour limit`,
      };
    case 'jira': {
      const server = serverOf(fixture.room);
      const attention = server === null ? null : (input.jira[server] ?? null);
      return attention === null || attention <= 0 ? null : {
        text: String(attention), tone: 'warn', words: attention === 1 ? '1 ticket needs attention' : `${attention} tickets need attention`,
      };
    }
    case 'tv':
      return input.fleetAlert === true ? { text: '', tone: 'alert', words: 'A server is offline or an account is nearly full', dot: true } : null;
    case 'wins':
      return count(input.winsWeek, 'info', 'win this week', 'wins this week');
    case 'schedule':
      return count(input.scheduleSoon, 'info', 'due in the next 24 hours', 'due in the next 24 hours');
    case 'links': {
      const server = serverOf(fixture.room);
      return count(server === null ? 0 : (input.links?.[server] ?? 0), 'info', 'link', 'links');
    }
    default:
      return null;
  }
}

/** The badge of every fixture that has something to say, by fixture id. */
export function fixtureBadges(snapshot: AgencySnapshot, input: FixtureBadgeInput): Readonly<Record<string, MapBadge>> {
  const serverOf = (room: string): string | null => (snapshot.map.rooms[room] === undefined ? null : room);
  return Object.fromEntries(snapshot.fixtures.flatMap((fixture) => {
    const badge = badgeOf(fixture, input, serverOf);
    return badge === null ? [] : [[fixture.id, badge] as const];
  }));
}

/**
 * "Board · 5 to do, 1 needs you" for the hover tip; the label alone without a badge; the clock says the time in owner time;
 * null for an unknown id.
 */
export function fixtureTip(snapshot: AgencySnapshot, badges: Readonly<Record<string, MapBadge>>, id: string, now: number = Date.now()): string | null {
  const fixture = snapshot.fixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) return null;
  if (fixture.kind === 'clock') return `${fixture.label} · ${formatClock(now)} in owner time`;
  const badge = badges[id];
  return badge === undefined ? fixture.label : `${fixture.label} · ${badge.words}`;
}

export interface RoomPlaque {
  readonly key: string;
  readonly name: string;
  /** "3 working · 1 needs you", or '' when both are zero. */
  readonly words: string;
  readonly needs: boolean;
}

/** "3 working · 1 needs you"; only the parts that are not zero. */
export function roomWords(working: number, needs: number): string {
  const parts = [working > 0 ? `${working} working` : null, needs > 0 ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : null];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/**
 * One plaque per room (HQ included) that is not an empty slot: its name and what its agents do. `only`: the rooms the
 * view shows (model/view-rooms.ts); null for every room.
 */
export function roomPlaques(snapshot: AgencySnapshot, only: readonly string[] | null = null): readonly RoomPlaque[] {
  return (only ?? snapshot.map.order).flatMap((key) => {
    const def = snapshot.map.rooms[key];
    if (def === undefined || isEmptySlot(def)) return [];
    const room = snapshot.rooms[key];
    const ids = [...(room?.actors ?? []), ...(room?.overflow ?? [])];
    const working = ids.filter((id) => snapshot.actors[id]?.state === 'working').length;
    const needs = room?.needsOwner ?? 0;
    return [{ key, name: def.name, words: roomWords(working, needs), needs: needs > 0 }];
  });
}

/** A far-mode badge: the room's colour, name, how many agents it holds and how many need the owner. */
export interface RoomBadge {
  readonly key: string;
  readonly name: string;
  readonly palette: Palette;
  /** Live sessions in the room (overflow included); null for HQ. */
  readonly agents: number | null;
  readonly needs: number;
}

/** The far-mode badges of these rooms (at most FAR_BADGES of them, chosen by the view). */
export function roomBadges(snapshot: AgencySnapshot, keys: readonly string[]): readonly RoomBadge[] {
  return keys.flatMap((key) => {
    const def = snapshot.map.rooms[key];
    if (def === undefined || isEmptySlot(def)) return [];
    const room = snapshot.rooms[key];
    const agents = key === HQ_ID ? null : (room?.actors.length ?? 0) + (room?.overflow.length ?? 0);
    return [{ key, name: def.short, palette: def.palette, agents, needs: room?.needsOwner ?? 0 }];
  });
}

/** "Harbor: 3 agents, 1 needs you" for a badge's label. */
export function badgeWords(badge: RoomBadge): string {
  const parts = [
    badge.name,
    badge.agents === null ? null : `${badge.agents} ${badge.agents === 1 ? 'agent' : 'agents'}`,
    badge.needs > 0 ? `${badge.needs} ${badge.needs === 1 ? 'needs' : 'need'} you` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(', ');
}

/** How far below the room's top a fixture still counts as hanging on the back wall (map pixels). */
const BACK_WALL_DEPTH = TILE * 2 + 8;

/**
 * The free run of a server room's back wall for its plaque, in map pixels: from the inside corner to the first wall
 * fixture (a west room's plaque, `wall`), or from the far end back to the last one (an east room's, `wall-end`). So
 * the plaque never covers the links board or another wall fixture, nor sits under its badge. Undefined for HQ's
 * floor plaque and for a side of the wall without fixtures.
 */
export function plaqueWallRun(snapshot: Pick<AgencySnapshot, 'map' | 'fixtures'>, roomKey: string, mode: string): number | undefined {
  const room = snapshot.map.rooms[roomKey];
  if (room === undefined || (mode !== 'wall' && mode !== 'wall-end')) return undefined;
  const q = roomRectPx(room);
  const left = q.x + TILE;
  const right = q.x + q.w - TILE;
  const onWall = snapshot.fixtures.filter((f) => f.room === roomKey && f.box.y < q.y + BACK_WALL_DEPTH);
  if (mode === 'wall') {
    const first = Math.min(...onWall.map((f) => f.box.x).filter((x) => x > left));
    return Number.isFinite(first) ? first - left : undefined;
  }
  const last = Math.max(...onWall.map((f) => f.box.x + f.box.w).filter((x) => x < right));
  return Number.isFinite(last) ? right - last : undefined;
}
