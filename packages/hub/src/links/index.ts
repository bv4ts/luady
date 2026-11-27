import { LIMITS, LinkUrlSchema, isRoomId, type LinkDTO, type HostId } from '@luady/shared';
import type { Clock, Db, EventBus, LinksService, Logger } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';

/** Everything the links shelf needs (wired in app.ts). */
export interface LinksDeps {
  db: Db;
  /** `links.changed` on every change. */
  bus: EventBus;
  clock: Clock;
  log: Logger;
}

interface LinkRow { id: number; server: string; label: string; url: string; position: number; created_at: string }

/** Links are kept per room; a row whose key is no room id is left out and logged (no silent drops). */
function toDto(row: LinkRow, log: Logger): LinkDTO | null {
  if (isRoomId(row.server)) return { id: row.id, server: row.server, label: row.label, url: row.url, position: row.position };
  log.warn({ table: 'links', key: row.id, room: row.server }, 'links: a row names no room id and is left out');
  return null;
}

function cleanLabel(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (clean === '' || clean.length > LIMITS.linkLabelMax) throw new ValidationError(`A link name needs 1-${LIMITS.linkLabelMax} characters`);
  return clean;
}

/** Only `https://` addresses; the hub stores them and never requests them. */
function cleanUrl(url: string): string {
  const parsed = LinkUrlSchema.safeParse(url.trim());
  if (!parsed.success) throw new ValidationError('A link must be an https:// address of at most 500 characters');
  return parsed.data;
}

/** The order after moving `id` to `position` (clamped): the office's ids, front to back. */
export function reorder(ids: readonly number[], id: number, position: number): number[] {
  const rest = ids.filter((other) => other !== id);
  const at = Math.max(0, Math.min(position, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The owner's quick links per office, on the `links` table (migration 014). */
export function createLinksService(deps: LinksDeps): LinksService {
  const db = deps.db;
  const all = db.prepare<[], LinkRow>('SELECT * FROM links ORDER BY server, position, id');
  const byId = db.prepare<[number], LinkRow>('SELECT * FROM links WHERE id = ?');
  const ofServer = db.prepare<[string], LinkRow>('SELECT * FROM links WHERE server = ? ORDER BY position, id');
  const insert = db.prepare<[string, string, string, number, string]>(
    'INSERT INTO links (server, label, url, position, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const setFields = db.prepare<[string, string, number]>('UPDATE links SET label = ?, url = ? WHERE id = ?');
  const setPosition = db.prepare<[number, number]>('UPDATE links SET position = ? WHERE id = ?');
  const deleteRow = db.prepare<[number]>('DELETE FROM links WHERE id = ?');

  const changed = (): void => deps.bus.emit('links.changed', { at: deps.clock.now().toISOString() });

  function row(id: number): LinkRow {
    const found = byId.get(id);
    if (found === undefined) throw new NotFoundError(`No link ${id}`);
    return found;
  }

  function dto(id: number): LinkDTO {
    const found = toDto(row(id), deps.log);
    if (found === null) throw new NotFoundError(`No link ${id}`);
    return found;
  }

  /** Positions 0..n-1 in the given order. */
  const renumber = db.transaction((ids: readonly number[]) => {
    ids.forEach((id, index) => setPosition.run(index, id));
  });

  return {
    list: () => all.all().flatMap((link) => toDto(link, deps.log) ?? []),
    async create(body) {
      const server: HostId = body.server;
      const label = cleanLabel(body.label);
      const url = cleanUrl(body.url);
      const id = db.transaction(() => {
        const existing = ofServer.all(server);
        if (existing.length >= LIMITS.linksPerOfficeMax) {
          throw new RefusedError(`An office holds at most ${LIMITS.linksPerOfficeMax} links. Remove one first.`);
        }
        return Number(insert.run(server, label, url, existing.length, deps.clock.now().toISOString()).lastInsertRowid);
      })();
      changed();
      return dto(id);
    },
    async update(id, body) {
      const current = row(id);
      const label = body.label === undefined ? current.label : cleanLabel(body.label);
      const url = body.url === undefined ? current.url : cleanUrl(body.url);
      db.transaction(() => {
        setFields.run(label, url, id);
        if (body.position !== undefined) {
          renumber(reorder(ofServer.all(current.server).map((link) => link.id), id, body.position));
        }
      })();
      changed();
      return dto(id);
    },
    async remove(id) {
      const current = row(id);
      db.transaction(() => {
        deleteRow.run(id);
        renumber(ofServer.all(current.server).map((link) => link.id));
      })();
      changed();
    },
  };
}
