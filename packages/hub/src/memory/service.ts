import { z } from 'zod';
import { CHAT_ROLES, ChannelSchema, type ChatMessageDTO } from '@luady/shared';
import type { Clock, Db, MemoryHit, MemoryService } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { isoNow } from '../core/time.js';
import { buildFtsQuery } from './fts-query.js';

export interface MemoryDeps {
  db: Db;
  clock: Clock;
}

export const SNIPPET_MAX_CHARS = 300;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 10;

const RecordSchema = z.object({
  thread: z.string().min(1).max(200),
  role: z.enum(CHAT_ROLES),
  channel: ChannelSchema.nullable(),
  text: z.string().max(200_000),
  extId: z.string().max(200).nullable().optional(),
});

const HitRowSchema = z.object({ thread: z.string(), role: z.string(), ts: z.string(), snip: z.string() });

const SEARCH_SQL = `SELECT m.thread AS thread, m.role AS role, m.ts AS ts,
    snippet(messages_fts, 0, '', '', '…', 32) AS snip
  FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
  WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function clampLimit(limit: number): number {
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT;
}

/** `messages` rows (the FTS index follows by trigger) and ranked FTS5 search with safe query building. */
export function createMemoryService(deps: MemoryDeps): MemoryService {
  const insert = deps.db.prepare(
    'INSERT INTO messages (id, thread, role, channel, text, ts, ext_id) VALUES (@id, @thread, @role, @channel, @text, @ts, @extId)',
  );
  const search = deps.db.prepare(SEARCH_SQL);
  return {
    record(msg) {
      const parsed = RecordSchema.safeParse(msg);
      if (!parsed.success) throw new ValidationError(`invalid message: ${parsed.error.issues[0]?.message ?? 'bad input'}`);
      const { extId, ...fields } = parsed.data;
      const dto: ChatMessageDTO = { id: newId(), ...fields, ts: isoNow(deps.clock) };
      insert.run({ ...dto, extId: extId ?? null });
      return dto;
    },
    search(query, limit) {
      const match = buildFtsQuery(query);
      if (match === null) return [];
      return search.all(match, clampLimit(limit)).flatMap((raw): MemoryHit[] => {
        const row = HitRowSchema.safeParse(raw);
        if (!row.success) return [];
        return [{ thread: row.data.thread, role: row.data.role, ts: row.data.ts, text: clip(row.data.snip, SNIPPET_MAX_CHARS) }];
      });
    },
  };
}
