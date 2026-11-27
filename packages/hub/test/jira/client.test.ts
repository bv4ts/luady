import { describe, expect, it, vi } from 'vitest';
import { getFieldIds, getMyself, searchIssues } from '../../src/jira/api.js';
import { createJiraClient, isAllowedJiraUrl } from '../../src/jira/client.js';
import { JIRA_MESSAGES, JiraError, scrub } from '../../src/jira/errors.js';
import { AUTH, CLOUD_ID, EMAIL, FLAGGED_FIELD, GATEWAY, SITE, SPRINT_FIELD, TOKEN, createFakeJira, issue } from './fake-jira.js';

const creds = (over: Partial<{ baseUrl: string; cloudId: string | null }> = {}) => ({ baseUrl: SITE, email: EMAIL, token: TOKEN, cloudId: null, ...over });

/** Everything an error could leak through: its message, its text, its JSON and its stack. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return [err.message, String(err), JSON.stringify(err), err.stack ?? ''].join('\n');
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('Jira client: addresses and sign-in', () => {
  it('uses the classic site address with Basic sign-in', async () => {
    const jira = createFakeJira();
    const http = createJiraClient(creds(), { fetch: jira.fetch });
    await expect(getMyself(http)).resolves.toEqual({ accountId: 'acc-1', displayName: 'Owner' });
    expect(jira.calls).toEqual([{ method: 'GET', url: `${SITE}/rest/api/3/myself`, auth: AUTH, body: undefined }]);
    expect(http.cloudId()).toBeNull();
  });

  it('falls back to api.atlassian.com/ex/jira/<cloudId> when the site refuses a scoped token, and remembers it', async () => {
    const jira = createFakeJira({ mode: 'scoped' });
    const onGateway = vi.fn();
    const http = createJiraClient(creds(), { fetch: jira.fetch, onGateway });
    await getMyself(http);
    expect(jira.calls.map((c) => [c.url, c.auth])).toEqual([
      [`${SITE}/rest/api/3/myself`, AUTH],
      [`${SITE}/_edge/tenant_info`, null],
      [`${GATEWAY}/rest/api/3/myself`, AUTH],
    ]);
    expect(onGateway).toHaveBeenCalledWith(CLOUD_ID);
    expect(http.cloudId()).toBe(CLOUD_ID);
    await getMyself(http);
    expect(jira.calls.at(-1)?.url).toBe(`${GATEWAY}/rest/api/3/myself`);
  });

  it('a remembered cloud id goes straight to the gateway', async () => {
    const jira = createFakeJira({ mode: 'scoped' });
    await getMyself(createJiraClient(creds({ cloudId: CLOUD_ID }), { fetch: jira.fetch }));
    expect(jira.calls.map((c) => c.url)).toEqual([`${GATEWAY}/rest/api/3/myself`]);
  });

  it('a refused token is an owner-readable jira_auth error without the token or the header', async () => {
    const jira = createFakeJira({ mode: 'refused' });
    const err = await caught(getMyself(createJiraClient(creds(), { fetch: jira.fetch })));
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).code).toBe('jira_auth');
    expect((err as JiraError).message).toBe(JIRA_MESSAGES.auth);
    const text = errorText(err);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(AUTH.slice(6));
  });

  it('stops after the time limit', async () => {
    const jira = createFakeJira({ mode: 'hang' });
    const err = await caught(getMyself(createJiraClient(creds(), { fetch: jira.fetch, timeoutMs: 20 })));
    expect((err as JiraError).kind).toBe('timeout');
    expect((err as JiraError).message).toBe('Jira did not answer in time.');
  });

  it('refuses any site that is not https://<name>.atlassian.net before a request is made', async () => {
    const jira = createFakeJira();
    for (const baseUrl of ['https://evil.example.com', 'http://orchard-demo.atlassian.net', 'https://orchard-demo.atlassian.net.evil.com', 'https://a.atlassian.net/x']) {
      expect(() => createJiraClient(creds({ baseUrl }), { fetch: jira.fetch })).toThrow(JiraError);
    }
    expect(jira.calls).toHaveLength(0);
  });

  it('a stored cloud id that is not a cloud id is ignored', async () => {
    const jira = createFakeJira();
    await getMyself(createJiraClient(creds({ cloudId: '../../evil' }), { fetch: jira.fetch }));
    expect(jira.calls[0]?.url).toBe(`${SITE}/rest/api/3/myself`);
  });

  it('only the site host and the gateway path are allowed', () => {
    expect(isAllowedJiraUrl(`${SITE}/rest/api/3/myself`, SITE)).toBe(true);
    expect(isAllowedJiraUrl(`${GATEWAY}/rest/api/3/myself`, SITE)).toBe(true);
    expect(isAllowedJiraUrl('https://api.atlassian.com/other/rest/api/3/myself', SITE)).toBe(false);
    expect(isAllowedJiraUrl('https://other.atlassian.net/rest/api/3/myself', SITE)).toBe(false);
    expect(isAllowedJiraUrl(`https://x:y@orchard-demo.atlassian.net/rest`, SITE)).toBe(false);
    expect(isAllowedJiraUrl('http://orchard-demo.atlassian.net/rest', SITE)).toBe(false);
    expect(isAllowedJiraUrl('not a url', SITE)).toBe(false);
  });

  it('asks fetch to refuse redirects and to stop at the time limit', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accountId: 'a' }), { status: 200 }));
    await getMyself(createJiraClient(creds(), { fetch: fetchFn as unknown as typeof fetch }));
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('Jira client: errors never carry the token', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'notFound'],
    [429, 'busy'],
    [503, 'server'],
  ] as const)('HTTP %s', async (status, kind) => {
    const jira = createFakeJira({ fail: { path: '/rest/api/3/myself', status, body: { errorMessages: [`echo ${TOKEN} ${AUTH}`] } } });
    const err = await caught(getMyself(createJiraClient(creds(), { fetch: jira.fetch })));
    expect((err as Error).message).toBe(JIRA_MESSAGES[kind]);
    expect(errorText(err)).not.toContain(TOKEN);
  });

  it("a refused change says Jira's reason, with any secret cut out", async () => {
    const jira = createFakeJira({ fail: { path: '/rest/api/3/myself', status: 400, body: { errorMessages: [`Bad value ${TOKEN}`], errors: { priority: 'Unknown priority' } } } });
    const err = await caught(getMyself(createJiraClient(creds(), { fetch: jira.fetch })));
    expect((err as Error).message).toBe('Jira did not accept that change: Bad value [hidden] Unknown priority');
  });

  it('a network failure is "Could not reach Jira." even when the cause names the token', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new TypeError(`fetch failed for ${AUTH}`);
    };
    const err = await caught(getMyself(createJiraClient(creds(), { fetch: fetchFn as unknown as typeof fetch })));
    expect((err as Error).message).toBe('Could not reach Jira.');
    expect(errorText(err)).not.toContain(AUTH.slice(6));
    expect((err as Error).cause).toBeUndefined();
  });

  it('an unreadable answer', async () => {
    const fetchFn = async (): Promise<Response> => new Response('<html>', { status: 200 });
    await expect(getMyself(createJiraClient(creds(), { fetch: fetchFn as unknown as typeof fetch }))).rejects.toThrow(JIRA_MESSAGES.unreadable);
  });

  it('scrub removes each secret', () => {
    expect(scrub(`a ${TOKEN} b ${AUTH}`, [TOKEN, AUTH])).toBe('a [hidden] b [hidden]');
  });
});

describe('Jira API: search paging and the field lookup', () => {
  it('follows nextPageToken up to the limit, naming the fields', async () => {
    const jira = createFakeJira({ issues: Array.from({ length: 130 }, (_v, i) => issue(`ORC-${i + 1}`)), pageSize: 40 });
    const http = createJiraClient(creds(), { fetch: jira.fetch });
    const found = await searchIssues(http, 'assignee = currentUser()', ['summary', 'status'], 100);
    expect(found).toHaveLength(100);
    expect(found[99]?.key).toBe('ORC-100');
    const urls = jira.calls.map((c) => new URL(c.url));
    expect(urls.every((u) => u.pathname === '/rest/api/3/search/jql' && u.searchParams.get('fields') === 'summary,status')).toBe(true);
    expect(urls.map((u) => u.searchParams.get('nextPageToken'))).toEqual([null, '40', '80']);
  });

  it('stops on the last page', async () => {
    const jira = createFakeJira({ issues: [issue('ORC-1'), issue('ORC-2'), issue('ORC-3')] });
    const found = await searchIssues(createJiraClient(creds(), { fetch: jira.fetch }), 'x = 1', ['summary'], 100);
    expect(found.map((i) => i.key)).toEqual(['ORC-1', 'ORC-2', 'ORC-3']);
    expect(jira.calls).toHaveLength(1);
  });

  it('skips issues whose key is not a ticket key', async () => {
    const jira = createFakeJira({ issues: [issue('ORC-1'), { key: 'bad key', fields: {} }] });
    const found = await searchIssues(createJiraClient(creds(), { fetch: jira.fetch }), 'x = 1', ['summary'], 10);
    expect(found.map((i) => i.key)).toEqual(['ORC-1']);
  });

  it('finds the sprint and flagged fields', async () => {
    const jira = createFakeJira();
    await expect(getFieldIds(createJiraClient(creds(), { fetch: jira.fetch }))).resolves.toEqual({ sprint: SPRINT_FIELD, flagged: FLAGGED_FIELD });
  });
});
