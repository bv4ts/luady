import { createHash } from 'node:crypto';
import {
  CreateKbPageBodySchema, UpdateKbPageBodySchema, kbSlug, type CreateKbPageBody, type KbAuthor, type KbPageFullDTO, type ProjectDTO,
} from '@luady/shared';
import { z } from 'zod';
import type { Clock, Db, EventBus, Fleet, KbHit, KbListQuery, KbService, Logger, ProjectsService } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import { appliesTo, type OfficeNameOf } from './files.js';
import { OVERVIEW_SLUG, OVERVIEW_TITLE, overviewBody } from './overview.js';
import { uniqueSlug } from './slug.js';
import { createKbStore, toFullDto, toPageDto, type KbPlace, type KbRow } from './store.js';
import { createKbSync } from './sync.js';

/** Everything the knowledge base needs (wired in app.ts). */
export interface KbDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** `kb-put` on each server. */
  fleet: Fleet;
  /** Each project's automatic Overview page. */
  projects: ProjectsService;
  /** The office name a host's INDEX.md uses (its home room's name, rooms/); absent: the host id. */
  officeName?: OfficeNameOf;
}

/** How often the project list is compared for the automatic Overview pages. */
export const KB_PROJECTS_CHECK_MS = 60_000;
const EXCERPT_MAX = 200;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`Invalid knowledge page: ${z.prettifyError(result.error)}`);
  return result.data;
}

function placeOf(body: CreateKbPageBody): KbPlace {
  return { scope: body.scope, server: body.server ?? null, project: body.scope === 'project' ? (body.project ?? null) : null };
}

function excerpt(body: string): string {
  const text = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter((l) => l !== '').join(' ');
  return text.length <= EXCERPT_MAX ? text : `${text.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * A page the manager may not replace: one the owner pinned, or one whose last change was the owner's. The store keeps
 * only the last author, and the manager can never change such a page, so it stays the owner's until the owner edits it.
 */
const ownersPage = (row: Pick<KbRow, 'pinned' | 'updatedBy'>): boolean => row.pinned || row.updatedBy === 'owner';

const sameTags = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((tag, i) => tag === b[i]);
const cleanTags = (tags: readonly string[] | undefined): string[] => [...new Set((tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ''))];

export function createKbService(deps: KbDeps): KbService {
  const store = createKbStore(deps.db, deps.log);
  const changed = (): void => deps.bus.emit('kb.changed', { at: isoNow(deps.clock) });
  const sync = createKbSync({
    store, bus: deps.bus, clock: deps.clock, log: deps.log, fleet: deps.fleet, onSynced: changed,
    ...(deps.officeName === undefined ? {} : { officeName: deps.officeName }),
  });
  let projectsDigest: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function touched(): void {
    changed();
    sync.schedule();
  }

  function slugIn(place: KbPlace, title: string, exceptId: number | null): string {
    return uniqueSlug(title, (slug) => {
      const hit = store.find(place, slug);
      return hit !== null && hit.id !== exceptId;
    });
  }

  function mustGet(id: number): KbRow {
    const row = store.get(id);
    if (row === null) throw new NotFoundError(`No knowledge page ${id}`);
    return row;
  }

  function insert(body: CreateKbPageBody, by: KbAuthor, slug: string): KbRow {
    const at = isoNow(deps.clock);
    return store.insert({
      ...placeOf(body), slug, title: body.title, body: body.body, tags: cleanTags(body.tags), pinned: false, auto: false,
      updatedAt: at, updatedBy: by, createdAt: at,
    });
  }

  /** The automatic Overview of each project: created, or rebuilt while nobody has edited it. */
  function rebuildOverviews(projects: readonly ProjectDTO[]): boolean {
    let any = false;
    for (const project of projects) {
      const place: KbPlace = { scope: 'project', server: project.server, project: project.name };
      const body = overviewBody(project);
      const existing = store.find(place, OVERVIEW_SLUG);
      const at = isoNow(deps.clock);
      if (existing === null) {
        store.insert({ ...place, slug: OVERVIEW_SLUG, title: OVERVIEW_TITLE, body, tags: [], pinned: false, auto: true, updatedAt: at, updatedBy: 'system', createdAt: at });
        any = true;
      } else if (existing.auto && existing.body !== body) {
        store.update(existing.id, { body, updatedAt: at, updatedBy: 'system' });
        any = true;
      }
    }
    return any;
  }

  function checkProjects(): void {
    const projects = deps.projects.list();
    const digest = createHash('sha256')
      .update(JSON.stringify(projects.map((p) => [p.server, p.name, p.path, p.remote, p.branch, p.stack, p.commits.slice(0, 5)])))
      .digest('hex');
    if (digest === projectsDigest) return;
    projectsDigest = digest;
    if (rebuildOverviews(projects)) touched();
  }

  function matches(row: KbRow, query: KbListQuery): boolean {
    if (query.scope !== undefined && row.scope !== query.scope) return false;
    if (query.server !== undefined && row.server !== query.server) return false;
    return query.project === undefined || row.project === query.project;
  }

  async function create(input: CreateKbPageBody, by: KbAuthor): Promise<KbPageFullDTO> {
    const body = parse(CreateKbPageBodySchema, input);
    const row = insert(body, by, slugIn(placeOf(body), body.title, null));
    touched();
    return toFullDto(row);
  }

  return {
    list(query) {
      const rows = query.query === undefined || query.query.trim() === '' ? store.all() : store.search(query.query);
      return { items: rows.filter((row) => matches(row, query)).map(toPageDto), syncedAt: sync.syncedAt() };
    },
    get: (id) => {
      const row = store.get(id);
      return row === null ? null : toFullDto(row);
    },
    create,
    async update(id, input, by) {
      const patch = parse(UpdateKbPageBodySchema, input);
      const row = mustGet(id);
      const tags = patch.tags === undefined ? undefined : cleanTags(patch.tags);
      const titleChanged = patch.title !== undefined && patch.title !== row.title;
      const contentChanged = titleChanged || (patch.body !== undefined && patch.body !== row.body) || (tags !== undefined && !sameTags(tags, row.tags));
      if (!contentChanged && (patch.pinned === undefined || patch.pinned === row.pinned)) return toFullDto(row);
      const updated = store.update(id, {
        ...(titleChanged ? { title: patch.title, slug: slugIn(row, patch.title ?? row.title, id) } : {}),
        ...(patch.body === undefined ? {} : { body: patch.body }),
        ...(tags === undefined ? {} : { tags }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        // An edit of the content makes an automatic page the editor's own: it is never rebuilt again.
        ...(contentChanged ? { auto: false } : {}),
        updatedAt: isoNow(deps.clock),
        updatedBy: by,
      });
      touched();
      return toFullDto(updated);
    },
    async remove(id) {
      mustGet(id);
      store.remove(id);
      touched();
    },
    async write(input, by) {
      const body = parse(CreateKbPageBodySchema, input);
      const existing = store.find(placeOf(body), kbSlug(body.title));
      if (existing === null) return create(body, by);
      if (by === 'manager' && ownersPage(existing)) {
        throw new RefusedError(`The owner wrote or pinned page #${existing.id} "${existing.title}": kb_write never replaces it. Use another title, or ask the owner.`);
      }
      const updated = store.update(existing.id, {
        title: body.title, body: body.body, tags: cleanTags(body.tags), auto: false, updatedAt: isoNow(deps.clock), updatedBy: by,
      });
      touched();
      return toFullDto(updated);
    },
    search(query, opts) {
      const hits = store.search(query).filter((row) => {
        if (opts.server !== undefined && !appliesTo(row, opts.server)) return false;
        return opts.project === undefined || row.scope !== 'project' || row.project === opts.project;
      });
      return hits.slice(0, opts.limit).map((row): KbHit => ({ ...toPageDto(row), excerpt: excerpt(row.body) }));
    },
    async sync(server) {
      if (server === undefined) await sync.syncAll(true);
      else await sync.syncServer(server, true);
    },
    start() {
      if (timer !== null) return;
      checkProjects();
      sync.start();
      timer = setInterval(() => {
        try {
          checkProjects();
        } catch (err) {
          deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'kb: overview pages check failed');
        }
      }, KB_PROJECTS_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      sync.stop();
    },
  };
}
