import { z } from 'zod';
import { HostIdSchema, PinSchema, RESERVED_IDS, RESERVED_PREFIXES } from './ids.js';
import { LIMITS } from './limits.js';

/** server: an SSH host's room; local: the room of "this computer"; project: projects matched by name or path. */
export const ROOM_KINDS = ['server', 'project', 'local'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
/** v1 draws medium rooms only. */
export const ROOM_SIZES = ['m'] as const;
export const ROOM_SPECIES = ['bun', 'bot', 'shield', 'ghost', 'cat'] as const;
export type RoomSpecies = (typeof ROOM_SPECIES)[number];

/** Room ids: 2-32 characters; the same reserved words and prefixes as host ids. */
export const ROOM_ID_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function isRoomId(value: string): boolean {
  return ROOM_ID_RE.test(value);
}

/** An id a user may choose for a new room: the grammar, not reserved, no reserved prefix (`lot-` names an empty slot). */
export function isNewRoomId(value: string): boolean {
  return isRoomId(value)
    && !(RESERVED_IDS as readonly string[]).includes(value)
    && !RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** Grammar only: DTOs, rows, route parameters, link and Jira room keys, RoomDeleteBody.to. */
export const RoomIdSchema = z.string().regex(ROOM_ID_RE);
/** RoomCreateBody.id and RoomImport.id. */
export const NewRoomIdSchema = RoomIdSchema.refine(isNewRoomId, { message: 'reserved room id' });

export const HexSchema = z.string().regex(/^#[0-9a-f]{6}$/);
export const ProjectMatchSchema = z.strictObject({
  by: z.enum(['name', 'path']), glob: z.string().min(1).max(LIMITS.roomGlobMax),
});
export type ProjectMatch = z.infer<typeof ProjectMatchSchema>;

const RoomName = z.string().trim().min(1).max(LIMITS.roomNameMax);
const RoomShort = z.string().trim().min(1).max(LIMITS.roomShortMax);
const RoomMatches = z.array(ProjectMatchSchema).max(LIMITS.roomMatchesMax);
const Position = z.number().int().min(0);

export const RoomDTOSchema = z.object({
  id: RoomIdSchema, name: z.string().min(1).max(LIMITS.roomNameMax), short: z.string().min(1).max(LIMITS.roomShortMax),
  kind: z.enum(ROOM_KINDS), host: HostIdSchema.nullable(),
  match: RoomMatches,
  colour: HexSchema, accent: HexSchema, species: z.enum(ROOM_SPECIES),
  position: Position, size: z.enum(ROOM_SIZES),
  /** A kept room of a removed host stays editable; only its host is no longer valid. */
  hostState: z.enum(['ok', 'removed']),
  createdAt: z.string(), updatedAt: z.string(),
});
export type RoomDTO = z.infer<typeof RoomDTOSchema>;

/** The grid the hub reports and the office draws: slotCount = max(position) + 1 (0 with no rooms), then gridFor. */
export const GridDTOSchema = z.object({
  slotCount: z.number().int().min(0), K: z.number().int().min(1), R: z.number().int().min(1), capacity: z.number().int().min(4),
});
export type GridDTO = z.infer<typeof GridDTOSchema>;

export const RoomsDTOSchema = z.object({ items: z.array(RoomDTOSchema), grid: GridDTOSchema });
export type RoomsDTO = z.infer<typeof RoomsDTOSchema>;

export const RoomWarningSchema = z.object({
  kind: z.enum(['near-reserved', 'near-room', 'overlap']), detail: z.string(), room: RoomIdSchema.nullable(),
});
export type RoomWarning = z.infer<typeof RoomWarningSchema>;

export const RoomWriteDTOSchema = z.object({
  room: RoomDTOSchema, adjusted: z.object({ colour: z.boolean(), accent: z.boolean() }), warnings: z.array(RoomWarningSchema),
});
export type RoomWriteDTO = z.infer<typeof RoomWriteDTOSchema>;

export const RoomPreviewDTOSchema = z.object({
  sessions: z.array(z.string()), projects: z.array(z.string()),
  overlaps: z.array(z.object({ room: RoomIdSchema, projects: z.array(z.string()) })),
});
export type RoomPreviewDTO = z.infer<typeof RoomPreviewDTOSchema>;

export const RoomCreateBodySchema = z.strictObject({
  name: RoomName, kind: z.enum(ROOM_KINDS), host: HostIdSchema.nullable().optional(), match: RoomMatches.optional(),
  colour: HexSchema.optional(), accent: HexSchema.optional(), species: z.enum(ROOM_SPECIES).optional(),
  id: NewRoomIdSchema.optional(), short: RoomShort.optional(),
  /** Free and either below the grid's capacity or the lowest free slot. */
  position: Position.optional(),
});
export type RoomCreateBody = z.infer<typeof RoomCreateBodySchema>;

/** Every field but the id and position; `expectUpdatedAt` is the room's `updatedAt` as last seen (409 when it moved). */
export const RoomUpdateBodySchema = z.strictObject({
  name: RoomName.optional(), short: RoomShort.optional(), kind: z.enum(ROOM_KINDS).optional(),
  host: HostIdSchema.nullable().optional(), match: RoomMatches.optional(),
  colour: HexSchema.optional(), accent: HexSchema.optional(), species: z.enum(ROOM_SPECIES).optional(),
  expectUpdatedAt: z.string().min(1).max(64),
});
export type RoomUpdateBody = z.infer<typeof RoomUpdateBodySchema>;

/** A permutation of every room id; positions become 0..n-1. */
export const RoomOrderBodySchema = z.strictObject({ ids: z.array(RoomIdSchema) });
export type RoomOrderBody = z.infer<typeof RoomOrderBodySchema>;

export const RoomMoveBodySchema = z.strictObject({ position: Position });
export type RoomMoveBody = z.infer<typeof RoomMoveBodySchema>;

/** What happens to the room's links and Jira site; `to` is the room they move to; the PIN when Jira is disconnected. */
export const RoomDeleteBodySchema = z.strictObject({
  links: z.enum(['move', 'delete']), jira: z.enum(['move', 'disconnect']), to: RoomIdSchema.optional(), pin: PinSchema.optional(),
});
export type RoomDeleteBody = z.infer<typeof RoomDeleteBodySchema>;

export const RoomPreviewBodySchema = z.strictObject({
  kind: z.enum(ROOM_KINDS), host: HostIdSchema.nullable(), match: RoomMatches, id: RoomIdSchema.optional(),
});
export type RoomPreviewBody = z.infer<typeof RoomPreviewBodySchema>;

/** A room from config.rooms, imported once with its id and position kept. */
export const RoomImportSchema = RoomCreateBodySchema.extend({ id: NewRoomIdSchema, position: Position });
export type RoomImport = z.infer<typeof RoomImportSchema>;
