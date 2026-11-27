import { LIMITS, WinLinkSchema, type HostId, type WinDTO, type WinsDTO } from '@luady/shared';
import type { Clock, Db, Logger, WinsService } from '../core/contracts.js';
import { cardHost } from '../board/store.js';
import { clipUnits } from '../board/text.js';

/** Everything the wins wall needs (wired in app.ts). */
export interface WinsDeps {
  /** Done cards (`todos`) and their log (`todo_events`). */
  db: Db;
  clock: Clock;
  log: Logger;
}

const DAY_MS = 24 * 60 * 60_000;
const URL_RE = /https:\/\/[^\s<>"'`)\]]+/gi;
/** Punctuation that ends a sentence, not the address. */
const TRAILING_RE = /[.,;:!?]+$/;

interface DoneRow { id: number; text: string; project: string | null; server: string | null; result: string | null; done_at: string }

/** The `https://` addresses in some text, in order, each once, each a valid address of at most 300 characters. */
export function linksIn(texts: readonly string[], max: number = LIMITS.winsLinksMax): string[] {
  const found: string[] = [];
  for (const value of texts) {
    for (const match of value.matchAll(URL_RE)) {
      const url = match[0].replace(TRAILING_RE, '');
      if (found.includes(url) || !WinLinkSchema.safeParse(url).success) continue;
      found.push(url);
      if (found.length >= max) return found;
    }
  }
  return found;
}

/** The wins wall: done cards of the last days, newest first, with their links and a count per office. */
export function createWinsService(deps: WinsDeps): WinsService {
  const doneRows = deps.db.prepare<[string], DoneRow>(
    'SELECT id, text, project, server, result, done_at FROM todos WHERE done = 1 AND done_at >= ? ORDER BY done_at DESC, id DESC',
  );
  const logOf = deps.db.prepare<[number], { text: string }>('SELECT text FROM todo_events WHERE todo_id = ? ORDER BY id');
  return {
    wins(days) {
      const span = Math.max(1, Math.min(LIMITS.winsDaysMax, Math.trunc(days)));
      const since = new Date(deps.clock.now().getTime() - span * DAY_MS).toISOString();
      const items = doneRows.all(since).map((row): WinDTO => ({
        id: row.id,
        title: clipUnits(row.text, LIMITS.boardTitleMax),
        project: row.project,
        server: cardHost('todos', row.id, row.server, deps.log),
        result: row.result,
        links: linksIn([row.result ?? '', ...logOf.all(row.id).map((line) => line.text)]),
        doneAt: row.done_at,
      }));
      const byServer: Partial<Record<HostId, number>> = {};
      for (const item of items) if (item.server !== null) byServer[item.server] = (byServer[item.server] ?? 0) + 1;
      return { items, byServer };
    },
  };
}
