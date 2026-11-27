/** A fake Jira Cloud site behind an injected `fetch`. Never talks to the network. */

export const SITE = 'https://orchard-demo.atlassian.net';
export const CLOUD_ID = '00000000-0000-4000-8000-00000000c10d';
export const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
export const EMAIL = 'owner@example.com';
export const TOKEN = 'test-token-0-secret-token-value';
export const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
export const SPRINT_FIELD = 'customfield_10020';
export const FLAGGED_FIELD = 'customfield_10021';

export interface FakeCall {
  readonly method: string;
  readonly url: string;
  readonly auth: string | null;
  readonly body: unknown;
}

export interface FakeIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface FakeJiraOptions {
  /** classic: the site takes the token; scoped: only the gateway does; refused: nobody does; hang: never answers. */
  mode?: 'classic' | 'scoped' | 'refused' | 'hang';
  issues?: FakeIssue[];
  sprintIssues?: FakeIssue[];
  /** Page size the fake uses for search, whatever maxResults says. */
  pageSize?: number;
  /** Status and body for one path (overrides everything else). */
  fail?: { path: string; status: number; body?: unknown };
}

export function issue(key: string, over: Record<string, unknown> = {}): FakeIssue {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      labels: [],
      updated: '2026-11-15T08:00:00.000+0000',
      parent: null,
      [SPRINT_FIELD]: [{ id: 1, name: 'Sprint 7', state: 'active', endDate: '2026-11-20T12:00:00.000Z' }],
      [FLAGGED_FIELD]: null,
      ...over,
    },
  };
}

export const TRANSITIONS = [
  { id: '11', name: 'Start progress', to: { name: 'In Progress' } },
  { id: '21', name: 'Done', to: { name: 'Done' } },
  { id: '31', name: 'Send to review', to: { name: 'In Review' } },
  { id: '41', name: 'Approve', to: { name: 'In Review' } },
];

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(name);
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

export function createFakeJira(opts: FakeJiraOptions = {}) {
  const mode = opts.mode ?? 'classic';
  const calls: FakeCall[] = [];
  const state = { issues: opts.issues ?? [issue('ORC-1'), issue('ORC-2')], sprintIssues: opts.sprintIssues, comments: [] as unknown[] };

  function accepts(url: URL, auth: string | null): boolean {
    if (auth !== AUTH || mode === 'refused') return false;
    const gateway = url.host === 'api.atlassian.com';
    return mode === 'classic' ? !gateway : gateway;
  }

  function search(url: URL): Response {
    const jql = url.searchParams.get('jql') ?? '';
    const pool = jql.includes('openSprints()') ? (state.sprintIssues ?? state.issues) : state.issues;
    const size = opts.pageSize ?? Number(url.searchParams.get('maxResults') ?? 50);
    const start = Number(url.searchParams.get('nextPageToken') ?? '0');
    const page = pool.slice(start, start + size);
    const next = start + size < pool.length ? String(start + size) : undefined;
    return json({ issues: page, ...(next === undefined ? { isLast: true } : { nextPageToken: next, isLast: false }) });
  }

  function route(method: string, path: string, url: URL, body: unknown): Response {
    if (opts.fail !== undefined && path === opts.fail.path) return json(opts.fail.body ?? { errorMessages: ['nope'] }, opts.fail.status);
    if (path === '/rest/api/3/myself') return json({ accountId: 'acc-1', displayName: 'Owner' });
    if (path === '/rest/api/3/field') {
      return json([
        { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
        { id: SPRINT_FIELD, name: 'Sprint', custom: true, schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
        { id: FLAGGED_FIELD, name: 'Flagged', custom: true, schema: { type: 'array', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' } },
      ]);
    }
    if (path === '/rest/api/3/search/jql') return search(url);
    const m = /^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)(\/\w+)?$/.exec(path);
    const found = m === null ? undefined : state.issues.find((i) => i.key === m[1]);
    if (m === null || found === undefined) return json({ errorMessages: ['Issue does not exist'] }, 404);
    const tail = m[2] ?? '';
    if (tail === '/transitions') {
      if (method === 'GET') return json({ transitions: TRANSITIONS });
      const id = (body as { transition?: { id?: string } } | undefined)?.transition?.id;
      const move = TRANSITIONS.find((t) => t.id === id);
      if (move === undefined) return json({ errorMessages: ['No such transition'] }, 400);
      found.fields = { ...found.fields, status: { name: move.to.name, statusCategory: { key: move.to.name === 'Done' ? 'done' : 'indeterminate' } } };
      return json(null, 204);
    }
    if (tail === '/comment') {
      state.comments.push(body);
      return json({ id: '100' }, 201);
    }
    if (tail === '/assignee') return json(null, 204);
    if (method === 'PUT') return json(null, 204);
    return json({
      key: found.key,
      fields: {
        ...found.fields,
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The login button fails.' }] }] },
        reporter: { displayName: 'Sara' },
        assignee: { displayName: 'Owner' },
        created: '2026-11-10T08:00:00.000+0000',
        duedate: '2026-11-21',
        subtasks: [{ key: 'ORC-9', fields: { summary: 'Write the test', status: { name: 'To Do' } } }],
        comment: { comments: [{ id: '7', author: { displayName: 'Sara' }, created: '2026-11-12T08:00:00.000+0000', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seen on Safari', marks: [{ type: 'strong' }] }] }] } }] },
      },
    });
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = headerOf(init, 'authorization');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: url.toString(), auth, body });
    if (mode === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')));
      });
    }
    if (url.pathname === '/_edge/tenant_info') return json({ cloudId: CLOUD_ID });
    if (!accepts(url, auth)) return json({ message: `Client must be authenticated. You sent ${auth ?? 'nothing'}` }, 401);
    const path = url.host === 'api.atlassian.com' ? url.pathname.replace(`/ex/jira/${CLOUD_ID}`, '') : url.pathname;
    return route(method, path, url, body);
  };

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, state };
}
