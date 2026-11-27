import { z } from 'zod';
import { AskQuestionSchema, HostIdSchema, PermissionPreviewSchema, QUESTION_KINDS, QUESTION_STATES, type HostId, type QuestionDTO } from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';
import { riskOfPermission } from '../security/preview-risk.js';

export type QuestionKind = QuestionDTO['kind'];
export type QuestionState = QuestionDTO['state'];

export const QuestionPayloadSchema = z.object({
  label: z.string(),
  questions: z.array(AskQuestionSchema).default([]),
  toolName: z.string().nullable().default(null),
  inputPreview: z.string().nullable().default(null),
  toolUseId: z.string().nullable().default(null),
  claudeSessionId: z.string().nullable().default(null),
  /** Kit 2: what the permission request wants to do. Kept only while the question is pending (`dropPreview`). */
  preview: PermissionPreviewSchema.nullable().default(null),
});
export type QuestionPayload = z.infer<typeof QuestionPayloadSchema>;

/** Any host id (open ids): no question is dropped for its host. */
const RowSchema = z.object({
  qid: z.string(),
  kind: z.enum(QUESTION_KINDS),
  host: HostIdSchema,
  session_id: z.string(),
  payload_json: z.string(),
  state: z.enum(QUESTION_STATES),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  resolved_via: z.string().nullable(),
});

export interface QuestionRecord {
  qid: string;
  kind: QuestionKind;
  host: HostId;
  sessionId: string;
  payload: QuestionPayload;
  state: QuestionState;
  createdAt: string;
  resolvedAt: string | null;
  resolvedVia: string | null;
}

export interface NewQuestion {
  qid: string;
  kind: QuestionKind;
  host: HostId;
  sessionId: string;
  payload: QuestionPayload;
  createdAt: string;
}

export interface QuestionsRepo {
  insert(question: NewQuestion): boolean;
  get(qid: string): QuestionRecord | undefined;
  pending(): QuestionRecord[];
  pendingOnHostBefore(host: HostId, beforeIso: string): QuestionRecord[];
  pendingForSession(sessionId: string): QuestionRecord[];
  /** Atomically moves a pending row to `state`; false when it was no longer pending. */
  claim(qid: string, state: QuestionState, answerJson: string, via: string, nowIso: string): boolean;
  unclaim(qid: string, claimedState: QuestionState, via: string): void;
  expireClaim(qid: string, claimedState: QuestionState, nowIso: string): void;
  /**
   * Applies a final state to the question `qid` of `host` (a host closes only its own questions); returns true when
   * something changed. Keeps the first resolved_at/resolved_via.
   */
  resolve(qid: string, host: HostId, state: QuestionState, atIso: string, via: string): boolean;
  stamp(qid: string, column: 'notified_at' | 'escalated_at', nowIso: string): void;
  /** Removes the stored permission preview of `qid` on `host`; runs on every path that closes the question. */
  dropPreview(qid: string, host: HostId): void;
}

const COLUMNS = 'qid, kind, host, session_id, payload_json, state, created_at, resolved_at, resolved_via';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A row that does not parse is left out and logged with its table and key (no silent drops). */
function fromRow(raw: unknown, log?: Logger): QuestionRecord | null {
  if (raw === undefined) return null;
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) {
    const key = typeof raw === 'object' && raw !== null && 'qid' in raw ? String(raw.qid) : '?';
    log?.warn({ table: 'questions', key, issue: parsed.error.issues[0]?.message }, 'questions: a row does not parse and is left out');
    return null;
  }
  const row = parsed.data;
  const payload = QuestionPayloadSchema.safeParse(parseJson(row.payload_json));
  return {
    qid: row.qid,
    kind: row.kind,
    host: row.host,
    sessionId: row.session_id,
    payload: payload.success
      ? payload.data
      : { label: row.session_id, questions: [], toolName: null, inputPreview: null, toolUseId: null, claudeSessionId: null, preview: null },
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedVia: row.resolved_via,
  };
}

function permissionOf(record: QuestionRecord): NonNullable<QuestionDTO['permission']> {
  const toolName = record.payload.toolName ?? 'unknown';
  const inputPreview = record.payload.inputPreview ?? '';
  const preview = record.payload.preview;
  return { toolName, inputPreview, preview, risk: { ...riskOfPermission({ toolName, inputPreview, preview }) } };
}

export function toQuestionDto(record: QuestionRecord): QuestionDTO {
  return {
    qid: record.qid,
    kind: record.kind,
    host: record.host,
    sessionId: record.sessionId,
    sessionLabel: record.payload.label,
    questions: record.kind === 'question' ? record.payload.questions : [],
    permission: record.kind === 'permission' ? permissionOf(record) : null,
    state: record.state,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
    resolvedVia: record.resolvedVia,
  };
}

export function createQuestionsRepo(db: Db, log?: Logger): QuestionsRepo {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO questions (qid, kind, host, session_id, payload_json, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  );
  const byQid = db.prepare(`SELECT ${COLUMNS} FROM questions WHERE qid = ?`);
  const pending = db.prepare(`SELECT ${COLUMNS} FROM questions WHERE state = 'pending' ORDER BY created_at, qid`);
  const pendingOnHost = db.prepare(`SELECT ${COLUMNS} FROM questions WHERE state = 'pending' AND host = ? AND created_at < ? ORDER BY created_at, qid`);
  const pendingInSession = db.prepare(`SELECT ${COLUMNS} FROM questions WHERE state = 'pending' AND session_id = ? ORDER BY created_at, qid`);
  const claim = db.prepare(
    "UPDATE questions SET state = @state, answer_json = @answer, resolved_via = @via, resolved_at = @now WHERE qid = @qid AND state = 'pending'",
  );
  const unclaim = db.prepare(
    "UPDATE questions SET state = 'pending', answer_json = NULL, resolved_via = NULL, resolved_at = NULL WHERE qid = @qid AND state = @state AND resolved_via = @via",
  );
  const expire = db.prepare("UPDATE questions SET state = 'timeout', resolved_via = 'server', resolved_at = @now WHERE qid = @qid AND state = @state");
  const resolve = db.prepare(
    `UPDATE questions SET state = @state, resolved_at = COALESCE(resolved_at, @at), resolved_via = COALESCE(resolved_via, @via)
     WHERE qid = @qid AND host = @host AND (state <> @state OR resolved_at IS NULL)`,
  );
  const notified = db.prepare('UPDATE questions SET notified_at = ? WHERE qid = ?');
  const escalated = db.prepare('UPDATE questions SET escalated_at = ? WHERE qid = ?');
  const dropPreview = db.prepare(
    "UPDATE questions SET payload_json = json_remove(payload_json, '$.preview') WHERE qid = ? AND host = ? AND json_valid(payload_json) AND json_type(payload_json, '$.preview') IS NOT NULL",
  );
  const many = (raws: unknown[]): QuestionRecord[] => raws.flatMap((raw) => fromRow(raw, log) ?? []);
  return {
    insert: (q) => insert.run(q.qid, q.kind, q.host, q.sessionId, JSON.stringify(q.payload), q.createdAt).changes === 1,
    get: (qid) => fromRow(byQid.get(qid), log) ?? undefined,
    pending: () => many(pending.all()),
    pendingOnHostBefore: (host, beforeIso) => many(pendingOnHost.all(host, beforeIso)),
    pendingForSession: (sessionId) => many(pendingInSession.all(sessionId)),
    claim: (qid, state, answerJson, via, nowIso) => claim.run({ qid, state, answer: answerJson, via, now: nowIso }).changes === 1,
    unclaim: (qid, state, via) => {
      unclaim.run({ qid, state, via });
    },
    expireClaim: (qid, state, nowIso) => {
      expire.run({ qid, state, now: nowIso });
    },
    resolve: (qid, host, state, atIso, via) => resolve.run({ qid, host, state, at: atIso, via }).changes === 1,
    stamp: (qid, column, nowIso) => {
      (column === 'notified_at' ? notified : escalated).run(nowIso, qid);
    },
    dropPreview: (qid, host) => {
      dropPreview.run(qid, host);
    },
  };
}
