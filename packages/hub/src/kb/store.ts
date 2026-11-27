import { KB_AUTHORS, KB_SCOPES, isHostId, type KbAuthor, type KbPageDTO, type KbPageFullDTO, type KbScope, type HostId } from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';

/**
 * kb_pages and kb_sync (migration 013). In the table `server` and `project` are '' when the scope has none, so the
 * unique key (scope, server, project, slug) also holds for global pages; here they are null.
 */
export interface KbRow {
  readonly id: number;
  readonly scope: KbScope;
  readonly server: HostId | null;
  readonly project: string | null;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly auto: boolean;
  readonly updatedAt: string;
  readonly updatedBy: KbAuthor;
  readonly createdAt: string;
}

export type KbNewRow = Omit<KbRow, 'id'>;
export type KbRowPatch = Partial<Pick<KbRow, 'slug' | 'title' | 'body' | 'tags' | 'pinned' | 'auto' | 'updatedAt' | 'updatedBy'>>;

/** Where a page lives: its scope, server and project. */
export interface KbPlace {
  readonly scope: KbScope;
  readonly server: HostId | null;
  readonly project: string | null;
}

interface RawPage {
  id: number; scope: string; server: string; project: string; slug: string; title: string; body: string; tags: string;
  pinned: number; auto: number; updated_at: string; updated_by: string; created_at: string;
}

const COLUMNS = 'id, scope, server, project, slug, title, body, tags, pinned, auto, updated_at, updated_by, created_at';
const P_COLUMNS = COLUMNS.split(', ').map((c) => `p.${c}`).join(', ');
const SEARCH_MAX_ROWS = 500;

function parseTags(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

/** A page whose scope or server does not parse is left out and logged with its id (no silent drops). */
function toRow(raw: RawPage, log?: Logger): KbRow | null {
  const scope = KB_SCOPES.find((s) => s === raw.scope);
  const updatedBy = KB_AUTHORS.find((a) => a === raw.updated_by) ?? 'system';
  const server = raw.server === '' || !isHostId(raw.server) ? null : raw.server;
  if (scope === undefined || (scope !== 'global' && server === null)) {
    log?.warn({ table: 'kb_pages', key: raw.id, scope: raw.scope, server: raw.server }, 'kb: a page row does not parse and is left out');
    return null;
  }
  return {
    id: raw.id, scope, server, project: raw.project === '' ? null : raw.project, slug: raw.slug, title: raw.title, body: raw.body,
    tags: parseTags(raw.tags), pinned: raw.pinned === 1, auto: raw.auto === 1, updatedAt: raw.updated_at, updatedBy, createdAt: raw.created_at,
  };
}

export function toPageDto(row: KbRow): KbPageDTO {
  return {
    id: row.id, scope: row.scope, server: row.server, project: row.project, slug: row.slug, title: row.title, tags: [...row.tags],
    pinned: row.pinned, auto: row.auto, size: row.body.length, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
  };
}

export function toFullDto(row: KbRow): KbPageFullDTO {
  return { ...toPageDto(row), body: row.body };
}

/** An FTS5 query from what someone typed: every word as a quoted prefix, all of them required. Empty = no words. */
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/"/g, '').trim())
    .filter((word) => word !== '')
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(' ');
}

export interface KbStore {
  all(): KbRow[];
  get(id: number): KbRow | null;
  find(place: KbPlace, slug: string): KbRow | null;
  insert(row: KbNewRow): KbRow;
  update(id: number, patch: KbRowPatch): KbRow;
  remove(id: number): boolean;
  /** Pages whose title, body or tags match, best first (pinned before the rest). */
  search(text: string): KbRow[];
  synced(): ReadonlyMap<HostId, { readonly at: string | null; readonly digest: string | null }>;
  setSynced(server: HostId, at: string, digest: string): void;
}

export function createKbStore(db: Db, log?: Logger): KbStore {
  const all = db.prepare<[], RawPage>(`SELECT ${COLUMNS} FROM kb_pages ORDER BY pinned DESC, title COLLATE NOCASE, id`);
  const one = db.prepare<[number], RawPage>(`SELECT ${COLUMNS} FROM kb_pages WHERE id = ?`);
  const bySlug = db.prepare<[string, string, string, string], RawPage>(
    `SELECT ${COLUMNS} FROM kb_pages WHERE scope = ? AND server = ? AND project = ? AND slug = ?`,
  );
  const insert = db.prepare(
    'INSERT INTO kb_pages (scope, server, project, slug, title, body, tags, pinned, auto, updated_at, updated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const del = db.prepare('DELETE FROM kb_pages WHERE id = ?');
  const search = db.prepare<[string, number], RawPage>(
    `SELECT ${P_COLUMNS} FROM kb_pages_fts f JOIN kb_pages p ON p.id = f.rowid WHERE kb_pages_fts MATCH ? ORDER BY p.pinned DESC, f.rank LIMIT ?`,
  );
  const synced = db.prepare<[], { server: string; synced_at: string | null; digest: string | null }>('SELECT server, synced_at, digest FROM kb_sync');
  const setSynced = db.prepare('INSERT OR REPLACE INTO kb_sync (server, synced_at, digest) VALUES (?, ?, ?)');
  const rows = (raws: RawPage[]): KbRow[] => raws.flatMap((raw) => toRow(raw, log) ?? []);

  function get(id: number): KbRow | null {
    const raw = one.get(id);
    return raw === undefined ? null : toRow(raw, log);
  }

  return {
    all: () => rows(all.all()),
    get,
    find(place, slug) {
      const raw = bySlug.get(place.scope, place.server ?? '', place.project ?? '', slug);
      return raw === undefined ? null : toRow(raw, log);
    },
    insert(row) {
      const result = insert.run(
        row.scope, row.server ?? '', row.project ?? '', row.slug, row.title, row.body, JSON.stringify(row.tags), row.pinned ? 1 : 0,
        row.auto ? 1 : 0, row.updatedAt, row.updatedBy, row.createdAt,
      );
      const created = get(Number(result.lastInsertRowid));
      if (created === null) throw new Error('knowledge page insert was not readable');
      return created;
    },
    update(id, patch) {
      const sets: string[] = [];
      const values: Array<string | number> = [];
      const add = (column: string, value: string | number): void => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.slug !== undefined) add('slug', patch.slug);
      if (patch.title !== undefined) add('title', patch.title);
      if (patch.body !== undefined) add('body', patch.body);
      if (patch.tags !== undefined) add('tags', JSON.stringify(patch.tags));
      if (patch.pinned !== undefined) add('pinned', patch.pinned ? 1 : 0);
      if (patch.auto !== undefined) add('auto', patch.auto ? 1 : 0);
      if (patch.updatedAt !== undefined) add('updated_at', patch.updatedAt);
      if (patch.updatedBy !== undefined) add('updated_by', patch.updatedBy);
      if (sets.length > 0) db.prepare(`UPDATE kb_pages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      const updated = get(id);
      if (updated === null) throw new Error('knowledge page update was not readable');
      return updated;
    },
    remove: (id) => del.run(id).changes > 0,
    search(text) {
      const match = ftsQuery(text);
      return match === '' ? [] : rows(search.all(match, SEARCH_MAX_ROWS));
    },
    synced() {
      const map = new Map<HostId, { at: string | null; digest: string | null }>();
      for (const row of synced.all()) {
        if (isHostId(row.server)) map.set(row.server, { at: row.synced_at, digest: row.digest });
        else log?.warn({ table: 'kb_sync', key: row.server }, 'kb: a sync row names no host id and is left out');
      }
      return map;
    },
    setSynced: (server, at, digest) => setSynced.run(server, at, digest),
  };
}
