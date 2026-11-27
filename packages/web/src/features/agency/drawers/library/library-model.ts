import type { Palette } from '@luady/office';
import {
  type KbAuthor, type KbPageDTO, type LibraryOfficeDTO, type LibraryProjectDTO, type SessionDTO, type SkillDTO, type SkillSource,
  managerName,
} from '@luady/shared';
import type { RoomLookup } from '../../../rooms/room-lookup.js';
import { whenText } from '../account-text.js';

/*
 * An "office" here is a host (projects, skills and pages live on hosts), named and coloured by its home room
 * (rooms/room-lookup.ts). The reading order is the rooms' slot order; hosts without a room follow, by id.
 */

/** A host as the owner knows it: its home room's name, "This computer", HQ, or its id. */
export const officeName = (server: string, lookup: RoomLookup): string => lookup.hostLabel(server);
/** A host's colours: its home room's, else grey. */
export const officePalette = (server: string, lookup: RoomLookup): Palette => lookup.roomPalette(server);

/** The hosts of the home rooms (server and local rooms), in slot order: the offices the owner reads. */
export function officeHosts(lookup: RoomLookup): readonly string[] {
  const hosts = lookup.list.flatMap((room) => (room.kind !== 'project' && room.host !== null ? [room.host] : []));
  return [...new Set(hosts)];
}

/** Compares two hosts in reading order: by their home room's slot, hosts without one after them by id. */
export function compareOffices(lookup: RoomLookup): (a: string, b: string) => number {
  const order = new Map(officeHosts(lookup).map((host, index) => [host, index] as const));
  const rank = (host: string): number => order.get(host) ?? Number.POSITIVE_INFINITY;
  return (a, b) => {
    const byRoom = rank(a) - rank(b);
    // Two hosts without a room give Infinity - Infinity: they go by id.
    return Number.isNaN(byRoom) ? a.localeCompare(b) : byRoom;
  };
}

/** The offices in reading order, each with its projects sorted by name. */
export function sortOffices(offices: readonly LibraryOfficeDTO[], lookup: RoomLookup): readonly LibraryOfficeDTO[] {
  const compare = compareOffices(lookup);
  return offices
    .toSorted((a, b) => compare(a.server, b.server))
    .map((office) => ({ ...office, projects: office.projects.toSorted((a, b) => a.name.localeCompare(b.name)) }));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 sessions now · 3 open cards · 1 page"; the parts that are zero are left out, "Quiet" when all are. */
export function projectCounts(project: Pick<LibraryProjectDTO, 'sessions' | 'openItems' | 'pages'>): string {
  const parts = [
    project.sessions > 0 ? `${plural(project.sessions, 'session', 'sessions')} now` : null,
    project.openItems > 0 ? plural(project.openItems, 'open card', 'open cards') : null,
    project.pages > 0 ? plural(project.pages, 'page', 'pages') : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Quiet' : parts.join(' · ');
}

/** The folder without its host's projects folder, so a long path reads as the project's own part; as it is without a root. */
export function shortFolder(path: string, root: string | null): string {
  if (root === null || root === '') return path;
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) || path : path;
}

/** The live sessions of a project: same server, and its folder or its project name. */
export function projectSessions(sessions: readonly SessionDTO[], project: Pick<LibraryProjectDTO, 'server' | 'path' | 'name'>): readonly SessionDTO[] {
  return sessions.filter((session) => session.host === project.server && session.state !== 'ended'
    && (session.cwd === project.path || session.project === project.name));
}

/** One shelf of knowledge pages: everyone, one office, or one project of an office. */
export interface Shelf {
  readonly key: string;
  readonly label: string;
  readonly server: string | null;
  readonly project: string | null;
  readonly pages: readonly KbPageDTO[];
}

/** Pinned pages first, then by title. */
const byPinThenTitle = (a: KbPageDTO, b: KbPageDTO): number => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title);

/**
 * The pages on shelves: Everyone first, then each office in reading order with its office-wide shelf before its
 * project shelves (sorted by project). Empty shelves are left out.
 */
export function shelvesOf(pages: readonly KbPageDTO[], lookup: RoomLookup): readonly Shelf[] {
  const compare = compareOffices(lookup);
  const groups = new Map<string, { shelf: Omit<Shelf, 'pages'>; pages: readonly KbPageDTO[] }>();
  for (const page of pages) {
    const shelf = shelfFor(page, lookup);
    const group = groups.get(shelf.key);
    groups.set(shelf.key, { shelf, pages: [...(group?.pages ?? []), page] });
  }
  const order = (a: Omit<Shelf, 'pages'>, b: Omit<Shelf, 'pages'>): number => {
    if (a.server === null || b.server === null) return a.server === b.server ? 0 : a.server === null ? -1 : 1;
    return compare(a.server, b.server) || Number(a.project !== null) - Number(b.project !== null)
      || (a.project ?? '').localeCompare(b.project ?? '');
  };
  return [...groups.values()]
    .toSorted((a, b) => order(a.shelf, b.shelf))
    .map(({ shelf, pages: list }) => ({ ...shelf, pages: list.toSorted(byPinThenTitle) }));
}

function shelfFor(page: KbPageDTO, lookup: RoomLookup): Omit<Shelf, 'pages'> {
  if (page.scope === 'global' || page.server === null) return { key: 'global', label: 'Everyone', server: null, project: null };
  const name = officeName(page.server, lookup);
  if (page.scope === 'office' || page.project === null) {
    return { key: `office:${page.server}`, label: name, server: page.server, project: null };
  }
  return { key: `project:${page.server}:${page.project}`, label: `${name} · ${page.project}`, server: page.server, project: page.project };
}

const AUTHORS: Readonly<Record<KbAuthor, string>> = { owner: 'you', manager: managerName(), system: 'automatic' };

/** "Changed by Luady at 3:20 PM" / "Built automatically, Sun 9:00 AM". */
export function changedLine(page: Pick<KbPageDTO, 'updatedBy' | 'updatedAt'>, now: Date): string {
  const when = whenText(page.updatedAt, now);
  if (page.updatedBy === 'system') return when === '' ? 'Built automatically' : `Built automatically, ${when}`;
  return when === '' ? `Changed by ${AUTHORS[page.updatedBy]}` : `Changed by ${AUTHORS[page.updatedBy]}, ${when}`;
}

/** When each office last got its copy of the pages, in reading order: "Orchard · 3:20 PM" or "· not yet". */
export function syncLines(
  syncedAt: Partial<Record<string, string | null>>, now: Date, lookup: RoomLookup,
): readonly { server: string; text: string }[] {
  return Object.keys(syncedAt).toSorted(compareOffices(lookup)).map((server) => {
    const at = syncedAt[server] ?? null;
    const when = at === null ? '' : whenText(at, now);
    return { server, text: when === '' ? 'not yet' : when };
  });
}

/** A book's height on the shelf: longer pages stand taller, between 132 and 176 pixels. */
export function spineHeight(size: number): number {
  const steps = Math.log10(Math.max(10, size));
  return Math.round(Math.min(176, Math.max(132, 104 + steps * 16)));
}

export const SKILL_GROUPS: readonly { source: SkillSource; label: string }[] = Object.freeze([
  { source: 'user', label: 'Yours' },
  { source: 'project', label: 'In a project' },
  { source: 'plugin', label: 'From plug-ins' },
]);

/** Skills grouped as user, project and plug-in, each sorted by name; empty groups are left out. */
export function groupSkills(skills: readonly SkillDTO[]): readonly { source: SkillSource; label: string; skills: readonly SkillDTO[] }[] {
  return SKILL_GROUPS
    .map((group) => ({ ...group, skills: skills.filter((skill) => skill.source === group.source).toSorted((a, b) => a.name.localeCompare(b.name)) }))
    .filter((group) => group.skills.length > 0);
}

/** Skills whose name or description contains every word of the filter (no case). */
export function filterSkills(skills: readonly SkillDTO[], filter: string): readonly SkillDTO[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return skills;
  return skills.filter((skill) => {
    const text = `${skill.name} ${skill.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Tags typed as "a, b c" become ['a', 'b c']: trimmed, no blanks, no repeats, at most eight. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(',').map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
}
