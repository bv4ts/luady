import { z } from 'zod';
import { isAddonId } from './ids.js';
import { LIMITS } from './limits.js';

export const NOTICE_KINDS = ['reply', 'result', 'question', 'permission', 'alert', 'mail', 'meeting', 'morning', 'system'] as const;
export const NoticeKindSchema = z.enum(NOTICE_KINDS);
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** What a notice points to: a question (qid), an action (id), a session (id) or a chat message of the manager. */
export const NOTICE_REF_KINDS = ['question', 'action', 'session', 'manager'] as const;
export const NoticeRefSchema = z.object({ kind: z.enum(NOTICE_REF_KINDS), id: z.string().max(200) });
export type NoticeRef = z.infer<typeof NoticeRefSchema>;

/**
 * How a notice was settled (notices.settled_via): `web` = seen or clicked on the website; `answer` = the question or
 * confirmation it points to was resolved on any channel; `expired` = dropped by retention before anything else; any
 * other value is the id of the chat channel that delivered it (at once or by the fallback).
 */
export const NOTICE_SETTLED_VIA = ['web', 'answer', 'expired'] as const;
/** The built-in values, or a channel id (open, like ChannelSchema). */
export const NoticeSettledViaSchema = z.string()
  .refine((value) => (NOTICE_SETTLED_VIA as readonly string[]).includes(value) || isAddonId(value), { message: 'unknown settle reason' });

/** A file sent to the owner while no channel was up: `GET /api/files/:id` serves it. */
export const NoticeFileSchema = z.object({
  id: z.string().min(1).max(64), name: z.string().min(1).max(255), mime: z.string().max(200), size: z.number().int().min(0),
});
export type NoticeFile = z.infer<typeof NoticeFileSchema>;

/** An update the manager or the hub started, shown on the website, with a fallback to the owner's chat channel. */

export const NoticeDTOSchema = z.object({
  id: z.string().max(64),
  kind: NoticeKindSchema,
  text: z.string().max(LIMITS.noticeTextMax),
  ref: NoticeRefSchema.nullable(),
  createdAt: z.string(),
  /** When the same text goes to the chat channel if nothing settles it; null = no fallback pending. */
  chatDueAt: z.string().nullable(),
  chatSentAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  settledVia: NoticeSettledViaSchema.nullable(),
  /** The file this notice carries, when it was sent while no channel was up. */
  file: NoticeFileSchema.optional(),
});
export type NoticeDTO = z.infer<typeof NoticeDTOSchema>;

export const NoticeListDTOSchema = z.object({ items: z.array(NoticeDTOSchema) });
export type NoticeListDTO = z.infer<typeof NoticeListDTOSchema>;

export const PresenceDTOSchema = z.object({
  /** Where a Luady-started update goes right now. */
  mode: z.enum(['here', 'chat']),
  /** At least one fresh website client. */
  online: z.boolean(),
  clients: z.number().int().min(0),
  /** Set while the owner's "Updates: chat" is in force. */
  forcedUntil: z.string().nullable(),
});
export type PresenceDTO = z.infer<typeof PresenceDTOSchema>;

/** `chat: true` sends updates to the chat channel for an hour; false clears it. */
export const PresenceForceBodySchema = z.strictObject({ chat: z.boolean() });
export type PresenceForceBody = z.infer<typeof PresenceForceBodySchema>;
