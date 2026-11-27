import { z } from 'zod';
import { QID_RE } from './ids.js';
import { LIMITS } from './limits.js';

export const QidSchema = z.string().regex(QID_RE);

export const AskOptionSchema = z.looseObject({
  label: z.string(),
  description: z.string().optional(),
});

export const AskQuestionSchema = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(AskOptionSchema).default([]),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

const base = {
  v: z.literal(1),
  id: z.string().min(8).max(64),
  ts: z.iso.datetime({ offset: true }),
  host: z.string().min(1).max(32),
  session_id: z.string().nullable(),
  cwd: z.string().nullable(),
  transcript_path: z.string().nullable(),
  tmux: z.string().nullable(),
  permission_mode: z.string().nullable(),
};
/** The nine envelope fields every kit spool line carries, whichever union (spool or activity) its `event` belongs to. */
export const SPOOL_ENVELOPE = base;

/** What a permission request wants to do, structured by the kit (kit 2+); everything already redacted. */
export const PermissionPreviewSchema = z.object({
  tool: z.string().max(LIMITS.toolNameMax),
  kind: z.enum(['command', 'edit', 'write', 'other']),
  /** Bash: the whole command after redaction. */
  command: z.string().max(LIMITS.permissionPreviewTextMax).nullable(),
  /** The file a file tool wants to touch. */
  path: z.string().max(LIMITS.permissionPreviewPathMax).nullable(),
  cwd: z.string().max(LIMITS.permissionPreviewPathMax).nullable(),
  edits: z
    .array(z.object({ old: z.string().max(LIMITS.permissionPreviewTextMax), new: z.string().max(LIMITS.permissionPreviewTextMax) }))
    .max(LIMITS.permissionPreviewEditsMax),
  /** True when anything was cut to fit LIMITS.permissionPreviewMaxBytes. */
  truncated: z.boolean(),
  /** What "Allow always" would allow for this session; null = not offered. */
  always: z.object({ label: z.string().max(LIMITS.permissionAlwaysLabelMax) }).nullable(),
  /**
   * False when the kit offers no Allow: part of the command is redacted or cut, so the owner denies it or answers in the
   * terminal. Older kits leave it out (see permissionAllowOffered).
   */
  allow: z.boolean().optional(),
});
export type PermissionPreview = z.infer<typeof PermissionPreviewSchema>;

export const SpoolEventSchema = z.discriminatedUnion('event', [
  z.object({ ...base, event: z.literal('session_start'), data: z.object({ source: z.string(), model: z.string().nullable() }) }),
  z.object({ ...base, event: z.literal('prompt'), data: z.object({ prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/), prompt_preview: z.string() }) }),
  z.object({ ...base, event: z.literal('stop'), data: z.object({ last_assistant_message: z.string(), truncated: z.boolean() }) }),
  z.object({ ...base, event: z.literal('stop_failure'), data: z.object({ error: z.string() }) }),
  z.object({ ...base, event: z.literal('notification'), data: z.object({ notification_type: z.string(), message: z.string(), title: z.string().nullable() }) }),
  z.object({ ...base, event: z.literal('session_end'), data: z.object({ reason: z.string() }) }),
  z.object({ ...base, event: z.literal('question'), data: z.object({ qid: QidSchema, tool_use_id: z.string().nullable(), questions: z.array(AskQuestionSchema).min(1) }) }),
  z.object({ ...base, event: z.literal('question_resolved'), data: z.object({ qid: QidSchema, outcome: z.enum(['answered', 'released', 'timeout', 'error']) }) }),
  z.object({
    ...base,
    event: z.literal('permission'),
    /** `preview` is written by kit 2 and later; kit-1 lines have none. */
    data: z.object({ qid: QidSchema, tool_name: z.string(), input_preview: z.string(), preview: PermissionPreviewSchema.optional() }),
  }),
  z.object({ ...base, event: z.literal('permission_resolved'), data: z.object({ qid: QidSchema, outcome: z.enum(['allowed', 'denied', 'released', 'timeout', 'error']) }) }),
  /** `luady-report "<text>"` run by a session mid-turn: something the owner waits for is ready now. */
  z.object({ ...base, event: z.literal('report'), data: z.object({ text: z.string().min(1).max(2000) }) }),
]);
export type SpoolEvent = z.infer<typeof SpoolEventSchema>;
export type SpoolEventType = SpoolEvent['event'];

export const SPOOL_FILE_RE = /^events-\d{8}\.jsonl$/;
export const TailEventLineSchema = z.strictObject({
  file: z.string().regex(SPOOL_FILE_RE),
  offset: z.number().int().nonnegative(),
  event: z.unknown(),
});
export const TailHeartbeatSchema = z.strictObject({ heartbeat: z.string() });
export const TailLineSchema = z.union([TailEventLineSchema, TailHeartbeatSchema]);
export type TailLine = z.infer<typeof TailLineSchema>;

export const QuestionAnswerFileSchema = z.union([
  z.strictObject({ answers: z.record(z.string(), z.string()) }),
  z.strictObject({ release: z.literal(true) }),
]);
export type QuestionAnswerFile = z.infer<typeof QuestionAnswerFileSchema>;

export const PermissionAnswerFileSchema = z.union([
  /** `always: true` = also add the preview's "Allow always" rule for this session (kit 2+). Allow only. */
  z.strictObject({ behavior: z.literal('allow'), message: z.string().optional(), always: z.literal(true).optional() }),
  z.strictObject({ behavior: z.literal('deny'), message: z.string().optional() }),
  z.strictObject({ release: z.literal(true) }),
]);
export type PermissionAnswerFile = z.infer<typeof PermissionAnswerFileSchema>;
