import {
  DEFAULT_ROOM_PALETTE, LIMITS, ROOM_SPECIES, isUnderRoot, managerName, normaliseHex, type ProjectMatch, type RoomCreateBody,
  type RoomDTO, type RoomKind, type RoomSpecies, type RoomUpdateBody,
} from '@luady/shared';
import { clampBody, defaultAccent } from '@luady/shared/pure';
import type { HostChoice } from '../../state/rooms.js';

/**
 * The room editor's form as data: what a new room starts with, the checks the hub makes,
 * in words that say what to do, and the request bodies. Pure.
 */
export interface RoomForm {
  readonly kind: RoomKind;
  /** A host id; '' for a project room on any server. */
  readonly host: string;
  readonly name: string;
  /** '' = made from the name. */
  readonly short: string;
  readonly match: readonly ProjectMatch[];
  /** As typed or picked; normalised and clamped on save. */
  readonly colour: string;
  readonly species: RoomSpecies;
}

export type RoomField = 'name' | 'short' | 'host' | 'match' | 'colour';
export interface RoomFormErrors {
  readonly fields: Readonly<Partial<Record<RoomField, string>>>;
  /** One entry per match row: its problem, or null. */
  readonly rows: readonly (string | null)[];
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const NAME_GLOB_RE = /^[A-Za-z0-9._*?-]{1,64}$/;
const PATH_GLOB_RE = /^\/[A-Za-z0-9._*?/-]{0,127}$/;

/** The form two names are compared in, as the hub does: NFC, then Unicode lower case without a locale. */
export const foldName = (name: string): string => name.normalize('NFC').trim().toLocaleLowerCase('und');

/** The first default colour no room uses yet; the palette again from the start once all are used (as the hub picks). */
export function defaultColour(rooms: readonly RoomDTO[]): string {
  const used = new Set(rooms.map((room) => room.colour));
  const free = DEFAULT_ROOM_PALETTE.find((entry) => !used.has(entry.hex));
  return (free ?? DEFAULT_ROOM_PALETTE[rooms.length % DEFAULT_ROOM_PALETTE.length] ?? DEFAULT_ROOM_PALETTE[0]).hex;
}

/** Species cycle bun → bot → shield → ghost → cat, by how many rooms there are (as the hub picks). */
export function defaultSpecies(rooms: readonly RoomDTO[]): RoomSpecies {
  return ROOM_SPECIES[rooms.length % ROOM_SPECIES.length] ?? 'bun';
}

/** A host id as a room name: `web-01` → "Web 01"; "This computer" for the local host. */
export function nameForHost(host: HostChoice | undefined): string {
  if (host === undefined) return '';
  if (host.local) return 'This computer';
  return host.id.split('-').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** True when the host already has its server or local room (other than `self`). */
export function hasHomeRoom(rooms: readonly RoomDTO[], host: string, self: string | null): boolean {
  return rooms.some((room) => room.id !== self && room.kind !== 'project' && room.host === host);
}

/** The hosts a room of this kind may take: free SSH servers, the free local host, or any host for a project room. */
export function hostsFor(kind: RoomKind, hosts: readonly HostChoice[], rooms: readonly RoomDTO[], self: string | null): readonly HostChoice[] {
  if (kind === 'project') return hosts;
  return hosts.filter((host) => host.local === (kind === 'local') && !hasHomeRoom(rooms, host.id, self));
}

/** A new room's form: the first free host of the kind, a name from it, the next default colour and species. */
export function newRoomForm(rooms: readonly RoomDTO[], hosts: readonly HostChoice[], want: { kind?: RoomKind; host?: string } = {}): RoomForm {
  const kind = want.kind ?? (hostsFor('server', hosts, rooms, null).length > 0 ? 'server' : hostsFor('local', hosts, rooms, null).length > 0 ? 'local' : 'project');
  const choices = hostsFor(kind, hosts, rooms, null);
  const host = kind === 'project' ? (want.host ?? '') : (choices.find((h) => h.id === want.host) ?? choices[0])?.id ?? '';
  return {
    kind, host, name: kind === 'project' ? '' : nameForHost(choices.find((h) => h.id === host)), short: '', match: [],
    colour: defaultColour(rooms), species: defaultSpecies(rooms),
  };
}

/** An existing room's form. */
export function editRoomForm(room: RoomDTO): RoomForm {
  return {
    kind: room.kind, host: room.host ?? '', name: room.name, short: room.short === room.name ? '' : room.short, match: room.match,
    colour: room.colour, species: room.species,
  };
}

/** The colour the room will really get: normalised and clamped into the readable range; null when it is no colour. */
export function savedColour(form: Pick<RoomForm, 'colour'>): { readonly hex: string; readonly adjusted: boolean } | null {
  const hex = normaliseHex(form.colour);
  return hex === null ? null : clampBody(hex);
}

function nameError(name: string, rooms: readonly RoomDTO[], self: string | null): string | undefined {
  const clean = name.normalize('NFC').trim();
  if (clean === '') return 'Give the room a name.';
  if (clean.length > LIMITS.roomNameMax) return `Keep the name to ${LIMITS.roomNameMax} characters or fewer.`;
  if (CONTROL_RE.test(clean)) return 'Remove the special characters from the name.';
  const folded = foldName(clean);
  if (folded === foldName('HQ') || folded === foldName(`${managerName()} HQ`)) return 'That name belongs to HQ. Pick a different name.';
  const other = rooms.find((room) => room.id !== self && foldName(room.name) === folded);
  return other === undefined ? undefined : `Another room is already called “${other.name}”. Pick a different name.`;
}

function shortError(short: string): string | undefined {
  const clean = short.trim();
  if (clean === '') return undefined;
  if (clean.length > LIMITS.roomShortMax) return `Keep the short name to ${LIMITS.roomShortMax} characters or fewer.`;
  return CONTROL_RE.test(clean) ? 'Remove the special characters from the short name.' : undefined;
}

/** A path glob without its trailing `/*` or `/**`: the folder it names. */
const globFolder = (glob: string): string => glob.replace(/\/\*\*?$/, '') || '/';

function rowError(m: ProjectMatch, root: string | null): string | null {
  const glob = m.glob.trim();
  if (glob === '') return m.by === 'name' ? 'Type a project name, like web-app or web-*.' : 'Type a folder, like /home/dev/projects/web-app.';
  if (m.by === 'name') return NAME_GLOB_RE.test(glob) ? null : 'Use letters, digits, dots, dashes, underscores, * and ? only.';
  if (!PATH_GLOB_RE.test(glob) || glob.split('/').includes('..')) return 'Start with / and use letters, digits, . _ - / * and ? only.';
  if (root !== null && !isUnderRoot(globFolder(glob), root)) return `This folder is outside ${root}. Pick a folder inside it.`;
  return null;
}

function hostError(form: RoomForm, choices: readonly HostChoice[]): string | undefined {
  if (form.kind === 'project' || form.host !== '') return undefined;
  if (choices.length > 0) return form.kind === 'local' ? 'Pick this computer.' : 'Pick a server.';
  return form.kind === 'local'
    ? 'This computer is not set up yet, or it has its room already. Add it in Settings → Servers first.'
    : 'Every server has its room already. Add a server first, or make a project room.';
}

/** Every problem of the form, in words; empty when it can be saved. */
export function validateRoomForm(
  form: RoomForm, ctx: { readonly rooms: readonly RoomDTO[]; readonly hosts: readonly HostChoice[]; readonly self: string | null },
): RoomFormErrors {
  const choices = hostsFor(form.kind, ctx.hosts, ctx.rooms, ctx.self);
  const root = form.host === '' ? null : ctx.hosts.find((host) => host.id === form.host)?.projectsRoot ?? null;
  const fields: Partial<Record<RoomField, string>> = {
    name: nameError(form.name, ctx.rooms, ctx.self),
    short: shortError(form.short),
    host: hostError(form, choices),
    match: form.kind === 'project' && form.match.length === 0 ? 'A project room needs at least one project name or folder.' : undefined,
    colour: normaliseHex(form.colour) === null ? 'Enter a colour like #3d7bff, or pick one of the swatches.' : undefined,
  };
  return {
    fields: Object.fromEntries(Object.entries(fields).filter(([, text]) => text !== undefined)),
    rows: form.match.map((m) => rowError(m, root)),
  };
}

export function isValid(errors: RoomFormErrors): boolean {
  return Object.keys(errors.fields).length === 0 && errors.rows.every((row) => row === null);
}

const cleanMatch = (match: readonly ProjectMatch[]): ProjectMatch[] => match.map((m) => ({ by: m.by, glob: m.glob.trim() }));
const hostOf = (form: RoomForm): string | null => (form.host === '' ? null : form.host);

/** The body that creates the room; `position` puts it in a chosen free slot. */
export function createBody(form: RoomForm, position?: number): RoomCreateBody {
  const colour = savedColour(form);
  const short = form.short.trim();
  return {
    name: form.name.normalize('NFC').trim(), kind: form.kind, host: hostOf(form),
    ...(form.match.length === 0 ? {} : { match: cleanMatch(form.match) }),
    ...(colour === null ? {} : { colour: colour.hex }),
    species: form.species,
    ...(short === '' ? {} : { short }),
    ...(position === undefined ? {} : { position }),
  };
}

const sameMatch = (a: readonly ProjectMatch[], b: readonly ProjectMatch[]): boolean =>
  a.length === b.length && a.every((m, i) => m.by === b[i]?.by && m.glob === b[i]?.glob);

/** The body that saves the changed fields of a room (a recolour sends the new default accent with it). */
export function updateBody(form: RoomForm, room: RoomDTO): RoomUpdateBody {
  const before = editRoomForm(room);
  const name = form.name.normalize('NFC').trim();
  const short = form.short.trim();
  const colour = savedColour(form);
  const match = cleanMatch(form.match);
  return {
    expectUpdatedAt: room.updatedAt,
    ...(name === room.name ? {} : { name }),
    ...(short === before.short || (short === '' && name !== room.name) ? {} : { short: short === '' ? name.slice(0, LIMITS.roomShortMax) : short }),
    ...(form.kind === room.kind ? {} : { kind: form.kind }),
    ...(hostOf(form) === room.host ? {} : { host: hostOf(form) }),
    ...(sameMatch(match, room.match) ? {} : { match }),
    ...(colour === null || colour.hex === room.colour ? {} : { colour: colour.hex, accent: defaultAccent(colour.hex) }),
    ...(form.species === room.species ? {} : { species: form.species }),
  };
}

/** True when the update body changes nothing (only `expectUpdatedAt`). */
export function isNoChange(body: RoomUpdateBody): boolean {
  return Object.keys(body).length === 1;
}
