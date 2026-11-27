import { z } from 'zod';
import { NOTICE_REF_KINDS, NoticeKindSchema, NoticeSettledViaSchema, type NoticeDTO, type NoticeKind, type NoticeRef } from '@luady/shared';
import type { Db } from '../core/contracts.js';

/** Settled notices are deleted this long after they settled; open ones older than this are expired first. */
export const NOTICE_RETENTION_DAYS = 30;
/** A safety cap on `recent`: open notices are few in practice (retention expires the old ones). */
const RECENT_OPEN_MAX = 500;

export type SettledVia = NonNullable<NoticeDTO['settledVia']>;

export interface NoticeRow {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly text: string;
  readonly ref: NoticeRef | null;
  readonly createdAt: string;
  readonly chatDueAt: string | null;
  readonly chatSentAt: string | null;
  readonly chatMsgId: string | null;
  readonly settledAt: string | null;
  readonly settledVia: NoticeDTO['settledVia'];
}

export interface NoticesRepo {
  insert(row: NoticeRow): void;
  get(id: string): NoticeRow | undefined;
  /** Every unsettled row, then the newest settled ones, newest first, at most `limit` in all (open ones always). */
  recent(limit: number): NoticeRow[];
  /** chat_due_at <= now, not sent, not settled; oldest first. */
  due(nowIso: string): NoticeRow[];
  openByRef(kind: NoticeRef['kind'], id: string): NoticeRow[];
  openOfKind(kind: NoticeKind): NoticeRow[];
  /** Sets chat_sent_at only while unsent and unsettled; true for the one caller that won. */
  claimSend(id: string, nowIso: string): boolean;
  setMessage(id: string, msgId: string | null): void;
  /** The adapter refused the send: the claim is undone so the next pass can try again. */
  unclaim(id: string): void;
  /** null = no fallback any more (given up after refusals). */
  setDue(id: string, dueIso: string | null): void;
  /** Every pending fallback becomes due now; returns how many. */
  bringForward(nowIso: string): number;
  /** Only while unsettled; true when this call settled it. */
  settle(id: string, via: SettledVia, nowIso: string): boolean;
  /** Settles (`expired`) every open notice created before the cut; returns how many. */
  expire(createdBeforeIso: string, nowIso: string): number;
  /** Deletes settled rows that settled before the cut; returns how many. */
  purge(settledBeforeIso: string): number;
}

const DbRowSchema = z.object({
  id: z.string(),
  kind: NoticeKindSchema,
  text: z.string(),
  ref_kind: z.enum(NOTICE_REF_KINDS).nullable(),
  ref_id: z.string().nullable(),
  created_at: z.string(),
  chat_due_at: z.string().nullable(),
  chat_sent_at: z.string().nullable(),
  chat_msg_id: z.string().nullable(),
  settled_at: z.string().nullable(),
  settled_via: NoticeSettledViaSchema.nullable(),
});

const COLUMNS = 'id, kind, text, ref_kind, ref_id, created_at, chat_due_at, chat_sent_at, chat_msg_id, settled_at, settled_via';
const OPEN = 'settled_at IS NULL';

function fromDb(raw: unknown): NoticeRow | null {
  const parsed = DbRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    id: r.id, kind: r.kind, text: r.text,
    ref: r.ref_kind !== null && r.ref_id !== null ? { kind: r.ref_kind, id: r.ref_id } : null,
    createdAt: r.created_at, chatDueAt: r.chat_due_at, chatSentAt: r.chat_sent_at, chatMsgId: r.chat_msg_id,
    settledAt: r.settled_at, settledVia: r.settled_via,
  };
}

const rowsOf = (raws: readonly unknown[]): NoticeRow[] => raws.map(fromDb).filter((r): r is NoticeRow => r !== null);

function statements(db: Db) {
  return {
    insert: db.prepare(`INSERT INTO notices (${COLUMNS}) VALUES (@id, @kind, @text, @refKind, @refId, @createdAt, @chatDueAt,
      @chatSentAt, @chatMsgId, @settledAt, @settledVia)`),
    get: db.prepare<[string]>(`SELECT ${COLUMNS} FROM notices WHERE id = ?`),
    open: db.prepare<[number]>(`SELECT ${COLUMNS} FROM notices WHERE ${OPEN} ORDER BY created_at DESC, rowid DESC LIMIT ?`),
    settled: db.prepare<[number]>(
      `SELECT ${COLUMNS} FROM notices WHERE settled_at IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ),
    due: db.prepare<[string]>(`SELECT ${COLUMNS} FROM notices
      WHERE chat_due_at IS NOT NULL AND chat_due_at <= ? AND chat_sent_at IS NULL AND ${OPEN} ORDER BY created_at, rowid`),
    ofKind: db.prepare<[string]>(`SELECT ${COLUMNS} FROM notices WHERE kind = ? AND ${OPEN} ORDER BY created_at, rowid`),
    byRef: db.prepare<[string, string]>(
      `SELECT ${COLUMNS} FROM notices WHERE ref_kind = ? AND ref_id = ? AND ${OPEN} ORDER BY created_at, rowid`,
    ),
    claim: db.prepare<[string, string]>(`UPDATE notices SET chat_sent_at = ? WHERE id = ? AND chat_sent_at IS NULL AND ${OPEN}`),
    message: db.prepare<[string | null, string]>('UPDATE notices SET chat_msg_id = ? WHERE id = ?'),
    unclaim: db.prepare<[string]>(`UPDATE notices SET chat_sent_at = NULL WHERE id = ? AND chat_msg_id IS NULL AND ${OPEN}`),
    setDue: db.prepare<[string | null, string]>('UPDATE notices SET chat_due_at = ? WHERE id = ?'),
    forward: db.prepare<[string, string]>(`UPDATE notices SET chat_due_at = ?
      WHERE chat_due_at IS NOT NULL AND chat_due_at > ? AND chat_sent_at IS NULL AND ${OPEN}`),
    settle: db.prepare<[string, string, string]>(`UPDATE notices SET settled_at = ?, settled_via = ? WHERE id = ? AND ${OPEN}`),
    expire: db.prepare<[string, string]>(
      `UPDATE notices SET settled_at = ?, settled_via = 'expired' WHERE ${OPEN} AND created_at < ?`,
    ),
    purge: db.prepare<[string]>('DELETE FROM notices WHERE settled_at IS NOT NULL AND settled_at < ?'),
  };
}

export function createNoticesRepo(db: Db): NoticesRepo {
  const sql = statements(db);
  return {
    insert: (row) => {
      sql.insert.run({
        id: row.id, kind: row.kind, text: row.text, refKind: row.ref?.kind ?? null, refId: row.ref?.id ?? null,
        createdAt: row.createdAt, chatDueAt: row.chatDueAt, chatSentAt: row.chatSentAt, chatMsgId: row.chatMsgId,
        settledAt: row.settledAt, settledVia: row.settledVia,
      });
    },
    get: (id) => fromDb(sql.get.get(id)) ?? undefined,
    recent: (limit) => {
      const open = rowsOf(sql.open.all(RECENT_OPEN_MAX));
      const room = Math.max(0, limit - open.length);
      return room === 0 ? open : [...open, ...rowsOf(sql.settled.all(room))];
    },
    due: (nowIso) => rowsOf(sql.due.all(nowIso)),
    openByRef: (kind, id) => rowsOf(sql.byRef.all(kind, id)),
    openOfKind: (kind) => rowsOf(sql.ofKind.all(kind)),
    claimSend: (id, nowIso) => sql.claim.run(nowIso, id).changes === 1,
    setMessage: (id, msgId) => {
      sql.message.run(msgId, id);
    },
    setDue: (id, dueIso) => {
      sql.setDue.run(dueIso, id);
    },
    unclaim: (id) => {
      sql.unclaim.run(id);
    },
    bringForward: (nowIso) => sql.forward.run(nowIso, nowIso).changes,
    settle: (id, via, nowIso) => sql.settle.run(nowIso, via, id).changes === 1,
    expire: (createdBeforeIso, nowIso) => sql.expire.run(nowIso, createdBeforeIso).changes,
    purge: (settledBeforeIso) => sql.purge.run(settledBeforeIso).changes,
  };
}

export function toNoticeDto(row: NoticeRow): NoticeDTO {
  return {
    id: row.id, kind: row.kind, text: row.text, ref: row.ref, createdAt: row.createdAt, chatDueAt: row.chatDueAt,
    chatSentAt: row.chatSentAt, settledAt: row.settledAt, settledVia: row.settledVia,
  };
}
