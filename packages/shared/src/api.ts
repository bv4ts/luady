import { z } from 'zod';
import {
  ACTION_ID_RE, HostIdSchema, NAME_RE, PinSchema, TARGET_RE, isAddonId, isBuiltinChannel, type Channel,
} from './ids.js';
import { ChannelInfoDTOSchema } from './addon.js';
import { RoomDTOSchema } from './rooms.js';
import { AUTH_MODES } from './setup.js';
import { AskQuestionSchema, PermissionPreviewSchema, QidSchema } from './spool.js';
import { CtlCommitSchema, CtlSysinfoSchema } from './ctl.js';
import { LIMITS } from './limits.js';

/**
 * A channel: the built-in values, or any id that fits the add-on grammar, so the rows of a removed
 * add-on still parse. Never the declared list.
 */
export const ChannelSchema: z.ZodType<Channel, Channel> = z.string()
  .refine((value) => isBuiltinChannel(value) || isAddonId(value), { message: 'unknown channel' });

/** Who started a session (sessions.origin): the owner, the manager (a mission), or the hub itself (the manager's own pane). */
export const SESSION_ORIGINS = ['owner', 'manager', 'system'] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];
/** Who asked for an action (actions.actor). */
export const ACTION_ACTORS = ['owner', 'manager'] as const;
export type ActionActor = (typeof ACTION_ACTORS)[number];
/** The author of a chat message (messages.role); `manager` is also the manager's thread (messages.thread). */
export const CHAT_ROLES = ['owner', 'manager', 'user', 'assistant', 'system'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];
/** The manager's chat thread (messages.thread). */
export const MANAGER_THREAD = 'manager';

export const SESSION_STATES = ['starting', 'idle', 'working', 'waiting_question', 'waiting_permission', 'error', 'ended'] as const;
export const SessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const ACTION_STATUSES = ['pending_confirmation', 'approved', 'denied', 'expired', 'done', 'failed'] as const;
export const ActionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const ServerDTOSchema = z.object({
  name: HostIdSchema, host: z.string(), status: z.enum(['online', 'offline', 'connecting']),
  lastSeenAt: z.string().nullable(), claudeVersion: z.string().nullable(), kitVersion: z.string().nullable(),
  sysinfo: CtlSysinfoSchema.nullable(),
  /** An SSH server or "this computer"; its projects folder and home; the web terminal is off for the local host. */
  kind: z.enum(['ssh', 'local']).default('ssh'),
  projectsRoot: z.string().nullable().default(null),
  homeDir: z.string().nullable().default(null),
  terminal: z.boolean().default(true),
});
export type ServerDTO = z.infer<typeof ServerDTOSchema>;

export const SessionDTOSchema = z.object({
  id: z.string(), host: HostIdSchema, target: z.string(), claudeSessionId: z.string().nullable(),
  cwd: z.string().nullable(), project: z.string().nullable(), displayName: z.string(),
  state: SessionStateSchema, origin: z.enum(SESSION_ORIGINS), registered: z.boolean(),
  lastEventAt: z.string().nullable(), turnStartedAt: z.string().nullable(),
  pendingQid: QidSchema.nullable(), unexpectedEnd: z.boolean(),
});
export type SessionDTO = z.infer<typeof SessionDTOSchema>;

/** How dangerous a permission request looks, judged by the hub. */
export const RiskDTOSchema = z.object({ level: z.enum(['safe', 'normal', 'risky']), reason: z.string().max(200) });
export type RiskDTO = z.infer<typeof RiskDTOSchema>;

export const QUESTION_KINDS = ['question', 'permission'] as const;
export const QUESTION_STATES = ['pending', 'answered', 'released', 'timeout'] as const;

export const QuestionDTOSchema = z.object({
  qid: QidSchema, kind: z.enum(QUESTION_KINDS), host: HostIdSchema, sessionId: z.string(),
  sessionLabel: z.string(), questions: z.array(AskQuestionSchema),
  /** `preview` is null or absent for a kit-1 request; `risk` is absent until the hub judges it. */
  permission: z.object({
    toolName: z.string(), inputPreview: z.string(),
    preview: PermissionPreviewSchema.nullable().optional(), risk: RiskDTOSchema.optional(),
  }).nullable(),
  state: z.enum(QUESTION_STATES),
  createdAt: z.string(), resolvedAt: z.string().nullable(), resolvedVia: z.string().nullable(),
});
export type QuestionDTO = z.infer<typeof QuestionDTOSchema>;

export const ActionDTOSchema = z.object({
  id: z.string().regex(ACTION_ID_RE), actor: z.enum(ACTION_ACTORS), channel: ChannelSchema,
  kind: z.string(), tier: z.union([z.literal(0), z.literal(1)]), summary: z.string(),
  status: ActionStatusSchema, createdAt: z.string(), decidedAt: z.string().nullable(),
  result: z.string().nullable(), error: z.string().nullable(),
  /**
   * A finished `session.resume` only: whether the pause had stopped the agent (`wasHit`) and whether the resume text
   * was typed (`sent`). Absent on every other action and on an older hub.
   */
  resume: z.object({ wasHit: z.boolean(), sent: z.boolean() }).optional(),
});
export type ActionDTO = z.infer<typeof ActionDTOSchema>;
/**
 * `GET /api/actions/:id/text`: the whole text an action types or writes (a session's prompt or message, a file's
 * content, an answer to a session's question), every hidden character marked; null for an action without one. The
 * summary's SHA-256 is of the text as stored: this view marks hidden characters and turns `\r\n` and a lone `\r` into
 * line breaks, so the two hashes match only when the text holds neither.
 */
export const ActionTextDTOSchema = z.object({ text: z.string().nullable() });
export type ActionTextDTO = z.infer<typeof ActionTextDTOSchema>;
/** The actions whose summary shows only the first lines of a text the confirmation card can open in full. */
export const FULL_TEXT_ACTION_KINDS: readonly string[] = ['session.start', 'session.send', 'server.file_write', 'question.answer'];

/** What an owner message to Luady can be about: a note (`m:…`/`n:…`), a card (its number) or a ticket (`birch:ORC-123`). */
export const ABOUT_KINDS = ['note', 'todo', 'jira'] as const;
export const AboutKindSchema = z.enum(ABOUT_KINDS);
export type AboutKind = (typeof ABOUT_KINDS)[number];
export const AboutRefSchema = z.strictObject({ kind: AboutKindSchema, id: z.string().min(1).max(LIMITS.aboutIdMax) });
export type AboutRef = z.infer<typeof AboutRefSchema>;

export const ChatMessageDTOSchema = z.object({
  id: z.string(), thread: z.string(), role: z.enum(CHAT_ROLES),
  channel: ChannelSchema.nullable(), text: z.string(), ts: z.string(),
  /** The note, card or ticket this owner message is about, with its label. Absent on an older hub. */
  about: z.object({ kind: AboutKindSchema, id: z.string(), label: z.string() }).optional(),
});
export type ChatMessageDTO = z.infer<typeof ChatMessageDTOSchema>;

/**
 * The answer of `POST /api/manager/messages`. `held`: Luady is signed out; the message is stored and shown as usual, and
 * passed on to him after the sign-in. Absent (not false) on an older hub.
 */
export const LuadyMessageSentDTOSchema = z.object({ ok: z.literal(true), held: z.boolean().optional() });
export type LuadyMessageSentDTO = z.infer<typeof LuadyMessageSentDTOSchema>;

export const TranscriptItemDTOSchema = z.object({
  uuid: z.string(), role: z.enum(['user', 'assistant', 'tool', 'system']), text: z.string(),
  ts: z.string().nullable(), toolName: z.string().nullable(),
});
export type TranscriptItemDTO = z.infer<typeof TranscriptItemDTOSchema>;

/** The manager's state; `off` while the manager switch is off, `down` when it is on but not running. */
export const MANAGER_STATES = ['running', 'busy', 'starting', 'down', 'off'] as const;
export const LuadyStatusDTOSchema = z.object({
  state: z.enum(MANAGER_STATES), since: z.string(),
  claudeSessionId: z.string().nullable(), queued: z.number().int().nonnegative(),
});
export type LuadyStatusDTO = z.infer<typeof LuadyStatusDTOSchema>;

export const ProjectDTOSchema = z.object({
  server: HostIdSchema, path: z.string(), name: z.string(), remote: z.string().nullable(),
  branch: z.string().nullable(), commits: z.array(CtlCommitSchema), stack: z.array(z.string()), updatedAt: z.string(),
});
export type ProjectDTO = z.infer<typeof ProjectDTOSchema>;

/** `owner` is who is in front of the hub (the Access e-mail, or the owner label in local mode) and `authMode` how they signed in. */
export const MeDTOSchema = z.object({
  owner: z.string(), authMode: z.enum(AUTH_MODES), passkeys: z.number().int(), pinSet: z.boolean(), csrf: z.string(),
});
export type MeDTO = z.infer<typeof MeDTOSchema>;

export const OverviewDTOSchema = z.object({
  servers: z.array(ServerDTOSchema), sessions: z.array(SessionDTOSchema), questions: z.array(QuestionDTOSchema),
  actions: z.array(ActionDTOSchema), manager: LuadyStatusDTOSchema,
  /** The self host's fixed id (SELF_HOST_ID); the website compares hosts through isSelfHost and checks it matches. */
  selfHost: HostIdSchema,
  /** The rooms and the declared channels; empty from a hub that has none (or predates them). */
  rooms: z.array(RoomDTOSchema).default([]),
  channels: z.array(ChannelInfoDTOSchema).default([]),
});
export type OverviewDTO = z.infer<typeof OverviewDTOSchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** The hub checks that `server` is a host it has, and the cwd against that host's projects folder. */
export const CreateSessionBodySchema = z.strictObject({
  server: HostIdSchema, cwd: z.string().min(1).max(1024),
  prompt: z.string().max(20000).optional(), name: z.string().regex(NAME_RE).optional(),
});
export const SendBodySchema = z.strictObject({ text: z.string().min(1).max(20000) });
/** `POST /api/manager/messages`: the session body plus what the message is about. */
export const LuadySendBodySchema = z.strictObject({ text: z.string().min(1).max(20000), about: AboutRefSchema.optional() });
export type LuadySendBody = z.infer<typeof LuadySendBodySchema>;
export const PinBodySchema = z.strictObject({ pin: PinSchema });
export const StopBodySchema = z.strictObject({ pin: PinSchema, force: z.boolean().optional() });
export const AnswerBodySchema = z.union([
  z.strictObject({ answers: z.record(z.string(), z.string().max(5000)) }),
  /** `always` belongs to allow only. */
  z.strictObject({ behavior: z.literal('allow'), message: z.string().max(1000).optional(), always: z.literal(true).optional() }),
  z.strictObject({ behavior: z.literal('deny'), message: z.string().max(1000).optional() }),
]);
/** Machine-readable `error` codes of API refusals. */
export const API_ERROR_CODES = { sessionPaused: 'session_paused', kitTooOld: 'kit_too_old' } as const;
export const ExecBodySchema = z.strictObject({ command: z.string().min(1).max(4000), cwd: z.string().max(1024).optional(), pin: PinSchema.optional() });
export const FileWriteBodySchema = z.strictObject({ path: z.string().min(1).max(1024), content: z.string().max(500000), pin: PinSchema });
/**
 * `timeZone`: the browser's own zone, sent with the first PIN (the claim). The hub stores it as `owner_tz` only when none
 * is set, after checking it the way Settings checks a zone; an unknown one is ignored and never stops the PIN.
 */
export const SetPinBodySchema = z.strictObject({
  newPin: PinSchema, currentPin: PinSchema.optional(), setupCode: z.string().min(8).max(64).optional(), timeZone: z.string().min(1).max(64).optional(),
});
export const TerminalOpenBodySchema = z.strictObject({ server: HostIdSchema, target: z.string().regex(TARGET_RE).optional(), pin: PinSchema });
export const PasskeyRegisterOptionsBodySchema = z.strictObject({ setupCode: z.string().min(8).max(64).optional(), pin: PinSchema.optional() });
export const PasskeyVerifyBodySchema = z.strictObject({ response: z.record(z.string(), z.unknown()), label: z.string().min(1).max(64).optional() });
