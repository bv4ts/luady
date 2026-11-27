import { z } from 'zod';
import {
  ActionDTOSchema, ChatMessageDTOSchema, LuadyStatusDTOSchema, QuestionDTOSchema, ServerDTOSchema,
  SessionDTOSchema, TranscriptItemDTOSchema,
} from './api.js';
import { HelperDTOSchema, SessionActivityDTOSchema, StepDTOSchema, TodoItemSchema } from './activity.js';
import { ChannelInfoDTOSchema } from './addon.js';
import { BoardItemDTOSchema, MissionDTOSchema } from './board.js';
import { HOST_JOB_STATES, HostDTOSchema } from './hosts.js';
import { HostIdSchema } from './ids.js';
import { RoomDTOSchema, RoomIdSchema } from './rooms.js';
import { SetupStateDTOSchema } from './setup.js';
import { SaidDTOSchema } from './said.js';
import { LIMITS } from './limits.js';
import { NoticeDTOSchema, PresenceDTOSchema } from './notices.js';

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), now: z.string() }),
  z.object({ type: z.literal('server.updated'), server: ServerDTOSchema }),
  z.object({ type: z.literal('session.updated'), session: SessionDTOSchema }),
  z.object({ type: z.literal('session.removed'), id: z.string() }),
  z.object({ type: z.literal('question.updated'), question: QuestionDTOSchema }),
  z.object({ type: z.literal('action.updated'), action: ActionDTOSchema }),
  z.object({ type: z.literal('manager.message'), message: ChatMessageDTOSchema }),
  z.object({ type: z.literal('manager.status'), status: LuadyStatusDTOSchema }),
  z.object({ type: z.literal('transcript.appended'), sessionId: z.string(), items: z.array(TranscriptItemDTOSchema) }),
  /** Every client; at most once a second; only sessions that changed. */
  z.object({ type: z.literal('activity.updated'), items: z.array(SessionActivityDTOSchema) }),
  /** Only sockets subscribed to that session; `todos`/`helpers` null = unchanged. Receivers replace steps by `id`. */
  z.object({
    type: z.literal('steps.appended'), sessionId: z.string(), steps: z.array(StepDTOSchema),
    todos: z.array(TodoItemSchema).nullable(), helpers: z.array(HelperDTOSchema).nullable(),
  }),
  z.object({ type: z.literal('notice.created'), notice: NoticeDTOSchema }),
  z.object({ type: z.literal('notice.updated'), notice: NoticeDTOSchema }),
  z.object({ type: z.literal('presence.updated'), presence: PresenceDTOSchema }),
  /** No payload: the website refetches GET /api/accounts. */
  z.object({ type: z.literal('accounts.changed'), at: z.string() }),
  // ── Board, missions, speech, notes and Jira, to every client ──
  /** Cards that changed (new, edited, moved, ticked). */
  z.object({ type: z.literal('board.updated'), items: z.array(BoardItemDTOSchema) }),
  z.object({ type: z.literal('board.removed'), ids: z.array(z.number().int().positive()) }),
  z.object({ type: z.literal('mission.updated'), mission: MissionDTOSchema }),
  z.object({
    type: z.literal('mission.removed'), sessionId: z.string(), outcome: z.enum(['done', 'ended']), summary: z.string().nullable(),
  }),
  /** What an agent said (the fields of SaidDTO). */
  z.object({ type: z.literal('session.said'), ...SaidDTOSchema.shape }),
  /** No payload: the website refetches what it shows. */
  z.object({ type: z.literal('notes.changed'), at: z.string() }),
  z.object({ type: z.literal('kb.changed'), at: z.string() }),
  z.object({ type: z.literal('library.changed'), at: z.string() }),
  /** `server` is the room key of the office whose Jira changed. */
  z.object({ type: z.literal('jira.changed'), room: RoomIdSchema, at: z.string() }),
  // ── Schedules, links and preferences, to every client: no payload, the website refetches ──
  z.object({ type: z.literal('schedules.changed'), at: z.string() }),
  z.object({ type: z.literal('links.changed'), at: z.string() }),
  z.object({ type: z.literal('prefs.changed'), at: z.string() }),
  // ── Rooms and hosts, to every client; full lists, coalesced to at most 4 a second ──
  z.object({ type: z.literal('rooms.changed'), rooms: z.array(RoomDTOSchema), at: z.string() }),
  z.object({ type: z.literal('hosts.changed'), hosts: z.array(HostDTOSchema), at: z.string() }),
  z.object({
    type: z.literal('host.job'), host: HostIdSchema, job: z.string(), state: z.enum(HOST_JOB_STATES),
    summary: z.string().max(LIMITS.hostSummaryMax).optional(), error: z.string().optional(),
  }),
  z.object({ type: z.literal('channel.status'), channel: ChannelInfoDTOSchema }),
  z.object({ type: z.literal('setup.changed'), state: SetupStateDTOSchema }),
  /** Only sockets subscribed to that host (`subscribe.host`): one line of its running job. */
  z.object({ type: z.literal('host.log'), host: HostIdSchema, job: z.string(), line: z.string().max(LIMITS.hostLogLineMax), at: z.string() }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe.transcript'), sessionId: z.string().max(160) }),
  z.object({ type: z.literal('unsubscribe.transcript'), sessionId: z.string().max(160) }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe.steps'), sessionId: z.string().max(160) }),
  z.object({ type: z.literal('unsubscribe.steps'), sessionId: z.string().max(160) }),
  /** On connect and on every visibility change. */
  z.object({ type: z.literal('presence.hello'), visible: z.boolean() }),
  /** The owner touched the page; at most one a minute. */
  z.object({ type: z.literal('presence.active') }),
  z.object({ type: z.literal('notice.ack'), ids: z.array(z.string().max(64)).min(1).max(LIMITS.noticeAckMax) }),
  /** The log lines of one host's jobs (`host.log`). */
  z.object({ type: z.literal('subscribe.host'), host: HostIdSchema }),
  z.object({ type: z.literal('unsubscribe.host'), host: HostIdSchema }),
  /** The page key, as the first message; the hub enforces it once the rule is switched on. */
  z.object({ type: z.literal('auth'), key: z.string().min(1).max(128) }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

export const TermClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65536) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
]);
export type TermClientMessage = z.infer<typeof TermClientMessageSchema>;

export const TermServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
]);
export type TermServerMessage = z.infer<typeof TermServerMessageSchema>;
