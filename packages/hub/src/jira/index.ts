import {
  LIMITS, isJiraSiteUrl, type JiraBoardDTO, type JiraIssueDTO, type JiraIssueDetailDTO, type JiraSiteDTO, type JiraView, type HostId,
} from '@luady/shared';
import type { Clock, Db, EventBus, JiraConnectInput, JiraSearchInput, JiraService, Logger } from '../core/contracts.js';
import { JiraNotConnectedError, RefusedError, ValidationError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import { sealer } from '../google/api.js';
import { textToAdf } from './adf.js';
import {
  getFieldIds, getIssue, getMyself, getTransitions, postComment, postTransition, putAssignee, putIssueFields, searchIssues, type FieldIds,
  type RawIssue,
} from './api.js';
import { createJiraClient, siteOrigin, type FetchFn, type JiraHttp } from './client.js';
import { JiraError, JiraNotFoundError } from './errors.js';
import { DETAIL_FIELDS, LIST_FIELDS, boardSprint, columnsOf, fieldList, toDetailDto, toIssueDto } from './map.js';
import { createJiraStore, type SiteRow } from './store.js';
import { BOARD_MAX, jqlFor, matchMove, needsAttention } from './views.js';

/** Everything Jira needs (wired in app.ts). */
export interface JiraDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** Seals the API token at rest (the same secret the Wispr and Google tokens are sealed with). */
  secret: string;
  /** Jira's REST API; tests (and the preview hub) pass a fake. */
  fetch: FetchFn;
  /** True while at least one website client is connected; the attention count is refreshed only then. */
  clientsPresent?: () => boolean;
  /** Per request; 15 s by default. */
  timeoutMs?: number;
  /** The name the owner knows for a room id (rooms/): Jira is kept per room. Absent: the id itself. */
  officeName?: (room: string) => string;
}

export const ATTENTION_EVERY_MS = 5 * 60_000;
export const ATTENTION_TICK_MS = 60_000;

/** A fetched board query ('sprint' or 'mine'), kept LIMITS.jiraBoardCacheMs. `hasNews` is applied when it is served. */
interface CachedBoard {
  readonly at: number;
  readonly view: 'sprint' | 'mine';
  readonly issues: readonly JiraIssueDTO[];
  readonly sprint: JiraBoardDTO['sprint'];
}

export function createJiraService(deps: JiraDeps): JiraService {
  const store = createJiraStore(deps.db, deps.log);
  const officeName = (room: string): string => deps.officeName?.(room) ?? room;
  const box = sealer(deps.secret);
  const fields = new Map<HostId, FieldIds>();
  const boards = new Map<string, CachedBoard>();
  const attention = new Map<HostId, number>();
  const attentionAt = new Map<HostId, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const nowMs = (): number => deps.clock.now().getTime();
  const changed = (room: string): void => deps.bus.emit('jira.changed', { room, at: isoNow(deps.clock) });

  function forget(server: HostId): void {
    fields.delete(server);
    for (const key of [...boards.keys()]) if (key.startsWith(`${server}:`)) boards.delete(key);
  }

  function siteOf(server: HostId): SiteRow {
    const row = store.site(server);
    if (row === null) throw new JiraNotConnectedError(`Jira is not connected for ${officeName(server)}.`);
    return row;
  }

  function clientOf(row: SiteRow): JiraHttp {
    let token: string;
    try {
      token = box.open(row.tokenEnc);
    } catch {
      throw new JiraError('auth', 'The saved Jira sign-in could not be read. Connect Jira again.');
    }
    return createJiraClient(
      { baseUrl: row.baseUrl, email: row.email, token, cloudId: row.cloudId },
      { fetch: deps.fetch, timeoutMs: deps.timeoutMs, onGateway: (cloudId) => store.setCloudId(row.server, cloudId) },
    );
  }

  /** Runs calls against one office's site and records whether Jira answered (last_ok_at / last_error). */
  async function withSite<T>(server: HostId, run: (http: JiraHttp, row: SiteRow) => Promise<T>): Promise<T> {
    const row = siteOf(server);
    try {
      const result = await run(clientOf(row), row);
      store.setHealth(server, isoNow(deps.clock), null);
      if (row.lastError !== null) changed(server);
      return result;
    } catch (err) {
      if (err instanceof JiraError) {
        deps.log.warn({ server, kind: err.kind }, 'jira: call failed');
        store.setHealth(server, isoNow(deps.clock), err.message);
        if (row.lastError !== err.message) changed(server);
      }
      throw err;
    }
  }

  async function fieldIds(server: HostId, http: JiraHttp): Promise<FieldIds> {
    const known = fields.get(server);
    if (known !== undefined) return known;
    const found = await getFieldIds(http);
    fields.set(server, found);
    return found;
  }

  function withNews(server: HostId, row: SiteRow, issues: readonly JiraIssueDTO[]): JiraIssueDTO[] {
    const seen = store.seenAt(server, issues.map((issue) => issue.key));
    const since = (key: string): number => Date.parse(seen.get(key) ?? row.connectedAt);
    return issues.map((issue) => ({ ...issue, hasNews: Date.parse(issue.updatedAt) > since(issue.key) }));
  }

  async function query(http: JiraHttp, ids: FieldIds, jql: string, max: number): Promise<RawIssue[]> {
    return searchIssues(http, jql, fieldList(LIST_FIELDS, ids), max);
  }

  /** My sprint, falling back to All mine when the site has no sprints or the sprint is empty. */
  async function fetchBoard(http: JiraHttp, row: SiteRow, view: 'sprint' | 'mine'): Promise<CachedBoard> {
    const ids = await fieldIds(row.server, http);
    const site = siteOrigin(row.baseUrl);
    if (view === 'sprint' && ids.sprint !== null) {
      const raws = await query(http, ids, jqlFor('sprint'), BOARD_MAX).catch((err: unknown) => {
        if (err instanceof JiraError && err.kind === 'bad') return [];
        throw err;
      });
      if (raws.length > 0) {
        return { at: nowMs(), view: 'sprint', issues: raws.map((raw) => toIssueDto(raw, ids, site)), sprint: boardSprint(raws, ids) };
      }
    }
    const raws = await query(http, ids, jqlFor('mine'), BOARD_MAX);
    return { at: nowMs(), view: 'mine', issues: raws.map((raw) => toIssueDto(raw, ids, site)), sprint: null };
  }

  async function cachedBoard(server: HostId, base: 'sprint' | 'mine', refresh: boolean): Promise<{ entry: CachedBoard; row: SiteRow }> {
    const key = `${server}:${base}`;
    const hit = boards.get(key);
    if (!refresh && hit !== undefined && nowMs() - hit.at < LIMITS.jiraBoardCacheMs) return { entry: hit, row: siteOf(server) };
    const entry = await withSite(server, (http, row) => fetchBoard(http, row, base));
    boards.set(key, entry);
    return { entry, row: siteOf(server) };
  }

  function noteAttention(server: HostId, count: number): void {
    attentionAt.set(server, nowMs());
    if (attention.get(server) === count) return;
    attention.set(server, count);
    changed(server);
  }

  async function board(server: HostId, view: JiraView, refresh: boolean): Promise<JiraBoardDTO> {
    const { entry, row } = await cachedBoard(server, view === 'sprint' ? 'sprint' : 'mine', refresh);
    const issues = withNews(server, row, entry.issues);
    const shown = view === 'attention' ? issues.filter(needsAttention) : issues;
    if (view !== 'sprint') noteAttention(server, issues.filter(needsAttention).length);
    return {
      view: view === 'attention' ? 'attention' : entry.view,
      issues: shown,
      columns: columnsOf(shown),
      sprint: view === 'attention' ? null : entry.sprint,
      fetchedAt: new Date(entry.at).toISOString(),
    };
  }

  async function detail(server: HostId, key: string, seen: boolean): Promise<JiraIssueDetailDTO> {
    const dto = await withSite(server, async (http, row) => {
      const ids = await fieldIds(server, http);
      const [raw, transitions] = await Promise.all([getIssue(http, key, fieldList(DETAIL_FIELDS, ids)), getTransitions(http, key)]);
      return toDetailDto(raw, transitions, ids, siteOrigin(row.baseUrl));
    });
    if (seen) {
      store.markSeen(server, dto.key, isoNow(deps.clock));
      return { ...dto, hasNews: false };
    }
    const [withFlag] = withNews(server, siteOf(server), [dto]);
    return { ...dto, hasNews: withFlag?.hasNews ?? false };
  }

  /** A change the owner (or Luady, when the owner said so) made: the boards are fetched again and the website told. */
  async function write(server: HostId, key: string, run: (http: JiraHttp, row: SiteRow) => Promise<void>): Promise<JiraIssueDetailDTO> {
    await withSite(server, run);
    forget(server);
    changed(server);
    return detail(server, key, true);
  }

  function editFields(patch: Parameters<JiraService['edit']>[2]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (patch.summary !== undefined) out.summary = patch.summary;
    if (patch.description !== undefined) out.description = patch.description.trim() === '' ? null : textToAdf(patch.description);
    if (patch.priority !== undefined) out.priority = { name: patch.priority };
    if (patch.labels !== undefined) out.labels = patch.labels.map((label) => label.replace(/\s+/g, '_'));
    if (Object.keys(out).length === 0) throw new ValidationError('Nothing to change on the ticket.');
    return out;
  }

  function toSiteDto(row: SiteRow): JiraSiteDTO {
    return {
      server: row.server, baseUrl: siteOrigin(row.baseUrl), email: row.email, displayName: row.displayName, connectedAt: row.connectedAt,
      lastOkAt: row.lastOkAt, lastError: row.lastError, attention: attention.get(row.server) ?? null,
    };
  }

  async function connect(server: HostId, input: JiraConnectInput): Promise<JiraSiteDTO> {
    if (!isJiraSiteUrl(input.baseUrl)) throw new ValidationError('The Jira site address must look like https://name.atlassian.net.');
    const email = input.email.trim();
    if (email.length < 3 || email.length > LIMITS.jiraEmailMax) throw new ValidationError('That e-mail address does not look right.');
    if (input.token.length < LIMITS.jiraTokenMin || input.token.length > LIMITS.jiraTokenMax) throw new ValidationError('That API token does not look right.');
    const http = createJiraClient({ baseUrl: input.baseUrl, email, token: input.token, cloudId: null }, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
    const me = await getMyself(http).catch((err: unknown) => {
      throw err instanceof JiraNotFoundError ? new JiraError('site', 'No Jira site answered at that address.') : err;
    });
    const at = isoNow(deps.clock);
    store.save({
      server, baseUrl: siteOrigin(input.baseUrl), email, tokenEnc: box.seal(input.token), cloudId: http.cloudId(), accountId: me.accountId,
      displayName: me.displayName, connectedAt: at, lastOkAt: at, lastError: null,
    });
    forget(server);
    attention.delete(server);
    attentionAt.delete(server);
    deps.log.info({ server, site: new URL(siteOrigin(input.baseUrl)).host, gateway: http.cloudId() !== null }, 'jira: connected');
    changed(server);
    deps.bus.emit('accounts.changed', { at });
    return toSiteDto(siteOf(server));
  }

  function pick(server?: HostId): HostId {
    const connected = store.sites().map((row) => row.server);
    if (server !== undefined) {
      if (!connected.includes(server)) throw new JiraNotConnectedError(`Jira is not connected for ${officeName(server)}.`);
      return server;
    }
    if (connected.length === 1) return connected[0]!;
    if (connected.length === 0) throw new JiraNotConnectedError('No office has Jira connected yet.');
    throw new RefusedError(`Jira is connected for ${connected.map(officeName).join(' and ')}: say which office (server ${connected.join(' or ')}).`);
  }

  async function attentionTick(): Promise<void> {
    if (deps.clientsPresent?.() !== true) return;
    for (const row of store.sites()) {
      const last = attentionAt.get(row.server);
      if (last !== undefined && nowMs() - last < ATTENTION_EVERY_MS) continue;
      attentionAt.set(row.server, nowMs());
      await board(row.server, 'attention', false).catch(() => undefined);
    }
  }

  return {
    sites: () => ({ sites: store.sites().map(toSiteDto) }),
    connect,
    async disconnect(server) {
      store.remove(server);
      forget(server);
      attention.delete(server);
      attentionAt.delete(server);
      deps.log.info({ server }, 'jira: disconnected');
      changed(server);
      deps.bus.emit('accounts.changed', { at: isoNow(deps.clock) });
    },
    board,
    issue: (server, key, opts) => detail(server, key, opts.seen),
    transition: (server, key, transitionId) => write(server, key, (http) => postTransition(http, key, transitionId)),
    comment: (server, key, text) => write(server, key, (http) => postComment(http, key, textToAdf(text))),
    edit: (server, key, patch) => {
      const body = editFields(patch);
      return write(server, key, (http) => putIssueFields(http, key, body));
    },
    assign: (server, key, me) => write(server, key, async (http, row) => {
      const accountId = me ? (row.accountId ?? (await getMyself(http)).accountId) : null;
      await putAssignee(http, key, accountId);
    }),
    pick,
    async search(server, input: JiraSearchInput) {
      const limit = Math.max(1, Math.min(input.limit, LIMITS.jiraSearchMax));
      if (input.jql === undefined) return (await board(server, input.view ?? 'sprint', false)).issues.slice(0, limit);
      const jql = input.jql;
      return withSite(server, async (http, row) => {
        const ids = await fieldIds(server, http);
        const raws = await query(http, ids, jql, limit);
        return withNews(server, row, raws.map((raw) => toIssueDto(raw, ids, siteOrigin(row.baseUrl))));
      });
    },
    async moveTo(server, key, to) {
      const ticket = await detail(server, key, false);
      const match = matchMove(ticket.transitions, to);
      if (match.kind === 'one') return write(server, key, (http) => postTransition(http, key, match.id));
      const lead = match.kind === 'none' ? `${key} has no move called "${to}".` : `"${to}" fits more than one move on ${key}.`;
      throw new RefusedError(`${lead} ${match.choices}`);
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        attentionTick().catch((err: unknown) => deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'jira: attention check failed'));
      }, ATTENTION_TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
