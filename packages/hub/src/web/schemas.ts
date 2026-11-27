import { z } from 'zod';
import { ACTION_ID_RE, ActionStatusSchema, HostIdSchema, QidSchema } from '@luady/shared';

/** Private request schemas for src/web; the shared ones lack path params and queries. All objects are strict. */
export const EmptyBodySchema = z.strictObject({});

export const SessionIdParamsSchema = z.strictObject({ id: z.string().min(3).max(160) });
export const QidParamsSchema = z.strictObject({ qid: QidSchema });
export const ActionIdParamsSchema = z.strictObject({ id: z.string().regex(ACTION_ID_RE) });
/** Any host id on the wire; the route checks the fleet has it. */
export const ServerParamsSchema = z.strictObject({ name: HostIdSchema });
/** WebAuthn credential ids are base64url. */
export const PasskeyIdParamsSchema = z.strictObject({ id: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/) });

const CursorSchema = z
  .string()
  .max(256)
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value));

export const PageQuerySchema = z.strictObject({
  cursor: CursorSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const QuestionsQuerySchema = z.strictObject({
  state: z.literal('pending').default('pending'),
});

export const ActionsQuerySchema = z.strictObject({
  status: z.preprocess((value) => (value === '' ? undefined : value), ActionStatusSchema.optional()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const MemoryFileQuerySchema = z.strictObject({
  name: z.string().min(4).max(256).regex(/^[^\0\\]+\.md$/),
});

export const FilePathQuerySchema = z.strictObject({
  path: z.string().min(2).max(1024).startsWith('/'),
});

export const TerminalQuerySchema = z.strictObject({
  ticket: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

/** createTicketStore issues 32 random bytes as lowercase hex. */
export const TICKET_RE = /^[a-f0-9]{64}$/;
/** Same default as TOOL_DEFS.server_exec. */
/** Matches FileWriteBodySchema's 500000-character limit so a read-edit-write round-trip never truncates. */
export const FILE_READ_MAX_BYTES = 500_000;
