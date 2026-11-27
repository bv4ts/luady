import { z } from 'zod';
import { HostIdSchema } from './ids.js';
import { JiraKeySchema } from './jira.js';
import { LIMITS } from './limits.js';
import { NoteIdSchema } from './notes.js';
import { RoomIdSchema } from './rooms.js';

/**
 * A card's life: `open` → `queued` (Run was pressed; Luady is planning) → `running` (a session has it) → `done`.
 * `review` = needs the owner (reported blocked, the session ended without reporting it, or Luady could not place it).
 */
export const BOARD_STATES = ['open', 'queued', 'running', 'review', 'done'] as const;
export const BoardStateSchema = z.enum(BOARD_STATES);
export type BoardState = (typeof BOARD_STATES)[number];

export const BOARD_SOURCES = ['web', 'chat', 'manager', 'meeting', 'jira', 'note', 'session'] as const;
export const BoardSourceSchema = z.enum(BOARD_SOURCES);
export type BoardSource = (typeof BOARD_SOURCES)[number];

export const BOARD_EVENT_KINDS = ['created', 'edited', 'queued', 'started', 'report', 'blocked', 'done', 'reopened', 'note'] as const;
export const BoardEventKindSchema = z.enum(BOARD_EVENT_KINDS);
export type BoardEventKind = (typeof BOARD_EVENT_KINDS)[number];

/** Normal (0) or high (1). */
export const BoardPrioritySchema = z.union([z.literal(0), z.literal(1)]);
export type BoardPriority = z.infer<typeof BoardPrioritySchema>;

/** One card. `auto`: made by the hub for a mission (renamed with the mission until someone edits it). */
export const BoardItemDTOSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(LIMITS.boardTitleMax),
  details: z.string().max(LIMITS.boardDetailsMax),
  project: z.string().nullable(),
  server: HostIdSchema.nullable(),
  source: BoardSourceSchema,
  sourceRef: z.string().nullable(),
  state: BoardStateSchema,
  today: z.boolean(),
  priority: BoardPrioritySchema,
  auto: z.boolean(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  result: z.string().max(LIMITS.boardResultMax).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  snoozeUntil: z.string().nullable(),
});
export type BoardItemDTO = z.infer<typeof BoardItemDTOSchema>;

/** One line of a card's log. */
export const BoardEventDTOSchema = z.object({
  id: z.number().int().positive(),
  itemId: z.number().int().positive(),
  at: z.string(),
  kind: BoardEventKindSchema,
  text: z.string().max(LIMITS.boardEventTextMax),
});
export type BoardEventDTO = z.infer<typeof BoardEventDTOSchema>;

export const MISSION_PHASES = ['working', 'waiting', 'idle'] as const;
export const MissionPhaseSchema = z.enum(MISSION_PHASES);
export type MissionPhase = (typeof MISSION_PHASES)[number];

/** A mission Luady runs in a session, as the website shows it (the board's Running lane, the agent view). */
export const MissionDTOSchema = z.object({
  sessionId: z.string(),
  label: z.string(),
  title: z.string(),
  phase: MissionPhaseSchema,
  turns: z.number().int().min(0),
  note: z.string().nullable(),
  lastText: z.string().max(LIMITS.missionLastTextMax).nullable(),
  openedAt: z.string(),
  idleSince: z.string().nullable(),
});
export type MissionDTO = z.infer<typeof MissionDTOSchema>;

/** `GET /api/missions`. */
export const MissionListDTOSchema = z.object({ items: z.array(MissionDTOSchema) });
export type MissionListDTO = z.infer<typeof MissionListDTOSchema>;

export const BoardItemDetailDTOSchema = z.object({
  item: BoardItemDTOSchema,
  /** Oldest first. */
  events: z.array(BoardEventDTOSchema),
  mission: MissionDTOSchema.nullable(),
});
export type BoardItemDetailDTO = z.infer<typeof BoardItemDetailDTOSchema>;

/** Everything not done, plus what was done in the last LIMITS.boardDoneDays days. */
export const BoardListDTOSchema = z.object({ items: z.array(BoardItemDTOSchema) });
export type BoardListDTO = z.infer<typeof BoardListDTOSchema>;

/** Sources a card made on the website may name (`chat` and `manager` are set by the hub). */
export const WEB_BOARD_SOURCES = ['web', 'meeting', 'jira', 'note', 'session'] as const;

const Title = z.string().trim().min(1).max(LIMITS.boardTitleMax);
const Details = z.string().max(LIMITS.boardDetailsMax);
const Project = z.string().min(1).max(LIMITS.boardProjectMax);
const IsoTime = z.iso.datetime({ offset: true });

export const CreateBoardItemBodySchema = z.strictObject({
  title: Title,
  details: Details.optional(),
  project: Project.optional(),
  server: HostIdSchema.optional(),
  today: z.boolean().optional(),
  priority: BoardPrioritySchema.optional(),
  source: z.enum(WEB_BOARD_SOURCES).optional(),
  sourceRef: z.string().min(1).max(LIMITS.boardSourceRefMax).optional(),
});
export type CreateBoardItemBody = z.infer<typeof CreateBoardItemBodySchema>;

/** The owner's edits; the owner can only reopen (`open`) or tick (`done`) a card, the rest of the life is the hub's. */
export const UpdateBoardItemBodySchema = z.strictObject({
  title: Title.optional(),
  details: Details.optional(),
  project: Project.nullable().optional(),
  server: HostIdSchema.nullable().optional(),
  today: z.boolean().optional(),
  priority: BoardPrioritySchema.optional(),
  state: z.enum(['open', 'done']).optional(),
  dueAt: IsoTime.nullable().optional(),
  snoozeUntil: IsoTime.nullable().optional(),
});
export type UpdateBoardItemBody = z.infer<typeof UpdateBoardItemBodySchema>;

/** What is sent to work: a card, a Jira ticket or a note (the last two become cards first). */
export const DelegateWhatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('todo'), id: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('jira'), server: RoomIdSchema, key: JiraKeySchema }),
  z.strictObject({ kind: z.literal('note'), id: NoteIdSchema }),
]);
export type DelegateWhat = z.infer<typeof DelegateWhatSchema>;

/** Who does it: Luady decides (`auto`), a named session, or a new session on a server. */
export const DelegateToSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('auto') }),
  z.strictObject({ kind: z.literal('session'), id: z.string().min(3).max(160) }),
  z.strictObject({ kind: z.literal('server'), server: HostIdSchema }),
]);
export type DelegateTo = z.infer<typeof DelegateToSchema>;

/** `POST /api/delegate`: Run (target auto) and Give to… (a named target). */
export const DelegateBodySchema = z.strictObject({
  what: z.array(DelegateWhatSchema).min(1).max(LIMITS.delegateItemsMax),
  to: DelegateToSchema,
  note: z.string().max(LIMITS.delegateNoteMax).optional(),
});
export type DelegateBody = z.infer<typeof DelegateBodySchema>;

/** `manager`: `sent` = the event reached the manager now; `queued` = it waits in his queue (he is busy, down or signed out). */
export const DelegateResultDTOSchema = z.object({
  runId: z.string(),
  items: z.array(BoardItemDTOSchema),
  manager: z.enum(['sent', 'queued']),
});
export type DelegateResultDTO = z.infer<typeof DelegateResultDTOSchema>;
