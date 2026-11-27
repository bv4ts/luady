import {
  RELATED, SPRINT, STATUS_CATEGORY, TICKETS, TRANSITIONS, doc, type AdfDoc, type FakeComment, type FakeTicket, type JiraStatus,
} from './jira-data.ts';

/**
 * A Jira Cloud site for the preview hub, behind the hub's `jiraFetch`. It answers the calls of
 * packages/hub/src/jira/{client,api}.ts and refuses every other host, so nothing ever leaves the machine.
 * Only the made-up preview token signs in; any other answers 401.
 */

export const PREVIEW_JIRA_SITE = 'https://luady-preview.atlassian.net';
export const PREVIEW_JIRA_EMAIL = 'owner@preview.invalid';
/** Not a secret: a made-up constant only this fake accepts. */
export const PREVIEW_JIRA_TOKEN = 'preview-jira-token-0000';
export const PREVIEW_JIRA_CLOUD_ID = '00000000-0000-4000-8000-00000000c0de';
export const PREVIEW_ACCOUNT_ID = '712020:preview-owner';
const OWNER_NAME = 'Preview Owner';
const SPRINT_FIELD = 'customfield_10020';
const FLAGGED_FIELD = 'customfield_10021';
const GATEWAY_PREFIX = `/ex/jira/${PREVIEW_JIRA_CLOUD_ID}`;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const PAGE_MAX = 100;

interface Live extends Omit<FakeTicket, 'ageMin' | 'comments' | 'dueInDays'> {
  readonly updatedMs: number;
  readonly createdMs: number;
  readonly dueDate: string | null;
  readonly comments: readonly FakeComment[];
  readonly assignee: string | null;
}

export interface FakeJira {
  readonly fetch: typeof globalThis.fetch;
  /** What the owner types into the connect form in the preview. */
  readonly connectInput: { readonly baseUrl: string; readonly email: string; readonly token: string };
  ticket(key: string): Live | undefined;
  /** A teammate's comment arrives (the ticket gets a news dot). */
  touch(key: string, author: string, text: string): void;
  /** Every request the hub made, as `METHOD path` (tests read it). */
  calls(): readonly string[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number): Response => new Response(null, { status });
const iso = (ms: number): string => new Date(ms).toISOString();

function liveTickets(now: number): Map<string, Live> {
  return new Map(TICKETS.map((t) => {
    const { ageMin, dueInDays, comments, ...rest } = t;
    const updatedMs = now - ageMin * MIN_MS;
    const live: Live = {
      ...rest, updatedMs, createdMs: updatedMs - 3 * DAY_MS, dueDate: dueInDays === null ? null : iso(now + dueInDays * DAY_MS).slice(0, 10),
      comments: comments.map((c) => ({ ...c, createdMs: now + c.createdMs })), assignee: t.mine ? OWNER_NAME : 'Sara Haddad',
    };
    return [t.key, live];
  }));
}

function statusObject(status: JiraStatus): Record<string, unknown> {
  return { name: status, statusCategory: { key: STATUS_CATEGORY[status] } };
}

function sprintValue(now: number): Record<string, unknown>[] {
  return [{
    id: SPRINT.id, name: SPRINT.name, state: SPRINT.state,
    startDate: iso(now - SPRINT.startedDaysAgo * DAY_MS), endDate: iso(now + SPRINT.daysLeft * DAY_MS),
  }];
}

function fieldsOf(t: Live, now: number): Record<string, unknown> {
  const parent = t.parent === null ? null : { key: t.parent, fields: { summary: RELATED[t.parent]?.summary ?? '' } };
  return {
    summary: t.summary, status: statusObject(t.status), issuetype: { name: t.type }, priority: { name: t.priority }, labels: [...t.labels],
    updated: iso(t.updatedMs), created: iso(t.createdMs), parent, duedate: t.dueDate,
    description: t.description, reporter: { displayName: 'Omar Khalil' }, assignee: t.assignee === null ? null : { displayName: t.assignee },
    subtasks: t.subtasks.map((key) => ({ key, fields: { summary: RELATED[key]?.summary ?? key, status: { name: RELATED[key]?.status ?? 'To Do' } } })),
    comment: { comments: t.comments.map((c) => ({ id: c.id, author: { displayName: c.author }, created: iso(c.createdMs), body: c.body })) },
    [SPRINT_FIELD]: t.inSprint ? sprintValue(now) : null,
    [FLAGGED_FIELD]: t.flagged ? [{ value: 'Impediment' }] : null,
  };
}

/** The two board queries the hub sends, and a key list or `text ~` for Luady's own JQL; anything else is "mine, open". */
function matches(jql: string, t: Live): boolean {
  if (!t.mine && /currentUser\(\)/.test(jql)) return false;
  const keys = /key\s*(?:=|in)\s*\(?([A-Z0-9_\-,\s"]+)\)?/i.exec(jql);
  if (keys !== null) return keys[1]!.split(',').map((k) => k.replace(/"/g, '').trim()).includes(t.key);
  const words = /text\s*~\s*"([^"]+)"/i.exec(jql);
  if (words !== null) return `${t.summary} ${JSON.stringify(t.description)}`.toLowerCase().includes(words[1]!.toLowerCase());
  if (/openSprints\(\)/.test(jql)) return t.inSprint;
  return t.mine && t.status !== 'Done';
}

function adfText(body: unknown): AdfDoc {
  if (typeof body === 'object' && body !== null && (body as { type?: unknown }).type === 'doc') return body as AdfDoc;
  return doc();
}

export function createFakeJira(deps: { clock: () => Date }): FakeJira {
  const start = deps.clock().getTime();
  let tickets = liveTickets(start);
  let calls: readonly string[] = [];
  let nextComment = 20_000;
  const auth = `Basic ${Buffer.from(`${PREVIEW_JIRA_EMAIL}:${PREVIEW_JIRA_TOKEN}`, 'utf8').toString('base64')}`;
  const now = (): number => deps.clock().getTime();

  const change = (key: string, patch: Partial<Live>): void => {
    const t = tickets.get(key);
    if (t !== undefined) tickets = new Map([...tickets, [key, { ...t, ...patch, updatedMs: now() }]]);
  };

  function search(query: URLSearchParams): Response {
    const jql = query.get('jql') ?? '';
    const offset = Number(query.get('nextPageToken') ?? '0') || 0;
    const size = Math.min(Number(query.get('maxResults') ?? '50') || 50, PAGE_MAX);
    const found = [...tickets.values()].filter((t) => matches(jql, t)).sort((a, b) => b.updatedMs - a.updatedMs);
    const page = found.slice(offset, offset + size);
    const more = offset + size < found.length;
    return json(200, {
      issues: page.map((t) => ({ key: t.key, fields: fieldsOf(t, now()) })),
      ...(more ? { nextPageToken: String(offset + size), isLast: false } : { isLast: true }),
    });
  }

  function issueRoute(method: string, key: string, rest: string, body: unknown): Response {
    const t = tickets.get(key);
    if (t === undefined) return json(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (method === 'GET' && rest === '') return json(200, { key, fields: fieldsOf(t, now()) });
    if (method === 'GET' && rest === '/transitions') {
      return json(200, { transitions: TRANSITIONS.filter((tr) => tr.to !== t.status).map((tr) => ({ id: tr.id, name: tr.name, to: { name: tr.to } })) });
    }
    if (method === 'POST' && rest === '/transitions') {
      const id = (fields.transition as { id?: unknown } | undefined)?.id;
      const move = TRANSITIONS.find((tr) => tr.id === id && tr.to !== t.status);
      if (move === undefined) return json(400, { errorMessages: ['That move is not available for this ticket.'] });
      change(key, { status: move.to });
      return empty(204);
    }
    if (method === 'POST' && rest === '/comment') {
      nextComment += 1;
      const added: FakeComment = { id: String(nextComment), author: OWNER_NAME, createdMs: now(), body: adfText(fields.body) };
      change(key, { comments: [...t.comments, added] });
      return json(201, { id: added.id });
    }
    if (method === 'PUT' && rest === '') return editIssue(key, fields.fields);
    if (method === 'PUT' && rest === '/assignee') {
      const accountId = fields.accountId;
      change(key, { assignee: accountId === PREVIEW_ACCOUNT_ID ? OWNER_NAME : null, mine: accountId === PREVIEW_ACCOUNT_ID });
      return empty(204);
    }
    return json(404, { errorMessages: ['Not found.'] });
  }

  function editIssue(key: string, raw: unknown): Response {
    const f = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const patch: Partial<Live> = {
      ...(typeof f.summary === 'string' ? { summary: f.summary } : {}),
      ...('description' in f ? { description: f.description === null ? doc() : adfText(f.description) } : {}),
      ...(typeof (f.priority as { name?: unknown } | undefined)?.name === 'string' ? { priority: (f.priority as { name: Live['priority'] }).name } : {}),
      ...(Array.isArray(f.labels) ? { labels: f.labels.filter((l): l is string => typeof l === 'string') } : {}),
    };
    change(key, patch);
    return empty(204);
  }

  function route(method: string, path: string, query: URLSearchParams, body: unknown): Response {
    if (path === '/rest/api/3/myself') return json(200, { accountId: PREVIEW_ACCOUNT_ID, displayName: OWNER_NAME, emailAddress: PREVIEW_JIRA_EMAIL });
    if (path === '/rest/api/3/field') {
      return json(200, [
        { id: 'summary', name: 'Summary', custom: false },
        { id: SPRINT_FIELD, name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
        { id: FLAGGED_FIELD, name: 'Flagged', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' } },
      ]);
    }
    if (path === '/rest/api/3/search/jql' && method === 'GET') return search(query);
    const issue = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)(\/transitions|\/comment|\/assignee)?$/.exec(path);
    if (issue !== null) return issueRoute(method, issue[1]!, issue[2] ?? '', body);
    return json(404, { errorMessages: ['Not found.'] });
  }

  async function bodyOf(init: RequestInit | undefined): Promise<unknown> {
    if (typeof init?.body !== 'string') return undefined;
    try {
      return JSON.parse(init.body) as unknown;
    } catch {
      return undefined;
    }
  }

  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const site = new URL(PREVIEW_JIRA_SITE);
    const onGateway = url.host === 'api.atlassian.com' && url.pathname.startsWith(`${GATEWAY_PREFIX}/`);
    if (url.protocol !== 'https:' || (url.host !== site.host && !onGateway)) throw new TypeError('fetch failed: the preview reaches only its fake Jira');
    const path = onGateway ? url.pathname.slice(GATEWAY_PREFIX.length) : url.pathname;
    calls = [...calls, `${method} ${path}`];
    if (path === '/_edge/tenant_info') return json(200, { cloudId: PREVIEW_JIRA_CLOUD_ID });
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== auth) return json(401, { errorMessages: ['Client must be authenticated to access this resource.'] });
    return route(method, path, url.searchParams, await bodyOf(init));
  };

  return {
    fetch: fakeFetch,
    connectInput: { baseUrl: PREVIEW_JIRA_SITE, email: PREVIEW_JIRA_EMAIL, token: PREVIEW_JIRA_TOKEN },
    ticket: (key) => tickets.get(key),
    touch(key, author, value) {
      const t = tickets.get(key);
      if (t === undefined) return;
      nextComment += 1;
      const added: FakeComment = { id: String(nextComment), author, createdMs: now(), body: doc({ type: 'paragraph', content: [{ type: 'text', text: value }] }) };
      change(key, { comments: [...t.comments, added] });
    },
    calls: () => calls,
  };
}
