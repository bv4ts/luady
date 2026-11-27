import type { JiraBoardDTO, JiraIssueDTO, JiraIssueDetailDTO, JiraSiteDTO, JiraView, KbPageFullDTO, HostId } from '@luady/shared';
import { iso } from '../office/data.js';
import { ISSUES, LIBRARY, MEMORY, PAGES, SITE, STATUS_OF, SYNCED_AT, detailOf } from './data.js';

/** The library, knowledge-base and Jira routes of a pretend hub, with the little state the demo changes. */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

type Body = Record<string, unknown>;
const summary = ({ body: _body, ...page }: KbPageFullDTO) => page;
const ORDER: readonly string[] = ['To Do', 'In Progress', 'In Review', 'Done'];

export interface DrawerRoutes {
  handle(method: string, path: string, query: URLSearchParams, body: Body): Response | null;
}

export function createDrawerRoutes(options: { connected: boolean; refused: boolean }): DrawerRoutes {
  let pages: readonly KbPageFullDTO[] = PAGES;
  let site: JiraSiteDTO | null = options.connected ? { ...SITE, lastError: options.refused ? 'Jira refused the sign-in. The token may have expired.' : null } : null;
  let details: Readonly<Record<string, JiraIssueDetailDTO>> = Object.fromEntries(ISSUES.map((issue) => [issue.key, detailOf(issue)]));
  let seen: ReadonlySet<string> = new Set();
  let nextId = 100;

  const issues = (): readonly JiraIssueDTO[] =>
    Object.values(details).map(({ descriptionMd: _d, reporter: _r, assignee: _a, createdAt: _c, dueDate: _due, comments: _co, transitions: _t, subtasks: _s, ...issue }) =>
      ({ ...issue, hasNews: issue.hasNews && !seen.has(issue.key) }));

  const board = (view: JiraView): JiraBoardDTO => {
    const mine = issues();
    const list = view === 'attention' ? mine.filter((i) => i.status.category !== 'done' && (i.flagged || i.hasNews || i.priority === 'Highest' || i.priority === 'High')) : mine;
    const columns = ORDER.map((name) => ({ name, category: STATUS_OF[name] ?? 'todo', keys: list.filter((i) => i.status.name === name).map((i) => i.key) }))
      .filter((column) => view === 'sprint' || column.keys.length > 0);
    return { view, issues: [...list], columns, sprint: view === 'sprint' ? { name: 'Sprint 42 · Checkout', endsAt: iso(3 * 86_400_000) } : null, fetchedAt: iso(0) };
  };

  const change = (key: string, edit: (issue: JiraIssueDetailDTO) => JiraIssueDetailDTO): Response => {
    const issue = details[key];
    if (issue === undefined) return fail(404, 'not_found', 'No such ticket');
    const next = { ...edit(issue), updatedAt: iso(0) };
    details = { ...details, [key]: next };
    return json(next);
  };

  const kbRoute = (method: string, path: string, query: URLSearchParams, body: Body): Response | null => {
    if (method === 'GET' && path === '/api/kb') {
      const q = (query.get('query') ?? '').toLowerCase();
      const list = pages.filter((p) => (query.get('scope') ?? p.scope) === p.scope && (query.get('server') ?? p.server) === p.server
        && (query.get('project') ?? p.project) === p.project && (q === '' || `${p.title} ${p.tags.join(' ')} ${p.body}`.toLowerCase().includes(q)));
      return json({ items: list.map(summary), syncedAt: SYNCED_AT });
    }
    if (method === 'POST' && path === '/api/kb') {
      nextId += 1;
      const text = String(body.body ?? '');
      const page: KbPageFullDTO = {
        id: nextId, scope: body.scope as KbPageFullDTO['scope'], server: (body.server as HostId | undefined) ?? null, project: (body.project as string | undefined) ?? null,
        slug: String(body.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page', title: String(body.title),
        tags: (body.tags as string[] | undefined) ?? [], pinned: false, auto: false, size: text.length, updatedAt: iso(0), updatedBy: 'owner', body: text,
      };
      pages = [...pages, page];
      return json(page);
    }
    if (method === 'POST' && path === '/api/kb/sync') return json({ ok: true });
    const one = /^\/api\/kb\/(\d+)(\/delete)?$/.exec(path);
    if (one === null) return null;
    const id = Number(one[1]);
    const page = pages.find((p) => p.id === id);
    if (page === undefined) return fail(404, 'not_found', 'No such page');
    if (one[2] !== undefined) {
      pages = pages.filter((p) => p.id !== id);
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const text = typeof body.body === 'string' ? body.body : page.body;
      const next: KbPageFullDTO = { ...page, ...(body as Partial<KbPageFullDTO>), body: text, size: text.length, auto: false, updatedAt: iso(0), updatedBy: 'owner' };
      pages = pages.map((p) => (p.id === id ? next : p));
      return json(next);
    }
    return json(page);
  };

  const jiraRoute = (method: string, path: string, query: URLSearchParams, body: Body): Response | null => {
    if (method === 'GET' && path === '/api/jira') return json({ sites: site === null ? [] : [site] });
    const office = /^\/api\/jira\/([a-z]+)\/(connection|disconnect|board)$/.exec(path);
    if (office !== null) {
      if (office[2] === 'connection') {
        if (String(body.token ?? '').includes('wrong')) return fail(400, 'jira_auth_failed', 'Jira refused the sign-in. Check the e-mail and the token.');
        site = { ...SITE, baseUrl: String(body.baseUrl), email: String(body.email), lastError: null, connectedAt: iso(0) };
        return json(site);
      }
      if (office[2] === 'disconnect') {
        site = null;
        return json({ ok: true });
      }
      if (site === null) return fail(409, 'jira_not_connected', 'Jira is not connected for this office.');
      return json(board((query.get('view') as JiraView | null) ?? 'sprint'));
    }
    const issue = /^\/api\/jira\/[a-z]+\/issues\/([A-Z0-9_]+-\d+)(?:\/(transition|comment|assign))?$/.exec(path);
    if (issue === null) return null;
    if (site === null) return fail(409, 'jira_not_connected', 'Jira is not connected for this office.');
    const key = issue[1] ?? '';
    const verb = issue[2];
    if (verb === 'transition') {
      return change(key, (t) => {
        const to = t.transitions.find((x) => x.id === body.transitionId)?.to ?? t.status.name;
        const moved = { ...t, status: { name: to, category: STATUS_OF[to] ?? 'todo' } };
        return { ...moved, transitions: detailOf(moved).transitions };
      });
    }
    if (verb === 'comment') return change(key, (t) => ({ ...t, comments: [...t.comments, { id: `c${String(Date.now())}`, author: 'Owner', at: iso(0), bodyMd: String(body.text) }] }));
    if (verb === 'assign') return change(key, (t) => ({ ...t, assignee: body.me === true ? 'Owner' : null }));
    if (method === 'PUT') {
      return change(key, (t) => ({
        ...t,
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        ...(typeof body.description === 'string' ? { descriptionMd: body.description } : {}),
        ...(typeof body.priority === 'string' ? { priority: body.priority } : {}),
        ...(Array.isArray(body.labels) ? { labels: body.labels as string[] } : {}),
      }));
    }
    seen = new Set([...seen, key]);
    const found = details[key];
    return found === undefined ? fail(404, 'not_found', 'No such ticket') : json({ ...found, hasNews: false });
  };

  return {
    handle(method, path, query, body) {
      if (method === 'GET' && path === '/api/library') return json(LIBRARY);
      if (method === 'POST' && path === '/api/library/refresh') return json({ ok: true });
      if (method === 'GET' && path === '/api/manager/memory') return json({ files: MEMORY.map((m) => ({ name: m.name, size: m.content.length })) });
      if (method === 'GET' && path === '/api/manager/memory/file') {
        const file = MEMORY.find((m) => m.name === query.get('name'));
        return file === undefined ? fail(404, 'not_found', 'No such file') : json(file);
      }
      if (method === 'POST' && path === '/api/delegate') return json({ runId: 'run-demo', items: [], manager: 'sent' });
      if (method === 'POST' && path === '/api/board') {
        nextId += 1;
        return json({ id: nextId, title: String(body.title), details: String(body.details ?? ''), project: body.project ?? null, server: body.server ?? null,
          source: body.source ?? 'web', sourceRef: body.sourceRef ?? null, state: 'open', today: false, priority: 0, auto: false, runId: null, sessionId: null,
          result: null, createdAt: iso(0), updatedAt: iso(0), doneAt: null, dueAt: null, snoozeUntil: null });
      }
      if (method === 'POST' && path === '/api/sessions') return json({ id: 'A90', actor: 'owner', channel: 'web', kind: 'session.start', tier: 0, summary: 'start', status: 'done', createdAt: iso(0), decidedAt: iso(0), result: 'started', error: null });
      return kbRoute(method, path, query, body) ?? jiraRoute(method, path, query, body);
    },
  };
}
