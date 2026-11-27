import { isJiraSiteUrl } from '@luady/shared';
import { JiraError, JiraNotFoundError, jiraDetail, scrub } from './errors.js';

/**
 * Jira Cloud over HTTPS with Basic sign-in (e-mail and API token). Requests go only to the connected
 * `https://<name>.atlassian.net` site, or to `https://api.atlassian.com/ex/jira/<cloudId>` when the site refuses the
 * token (a scoped token needs that form). Both are checked before every request; redirects are refused.
 */

export type FetchFn = typeof globalThis.fetch;

export const JIRA_TIMEOUT_MS = 15_000;
export const JIRA_GATEWAY_ORIGIN = 'https://api.atlassian.com';
const GATEWAY_HOST = 'api.atlassian.com';
const CLOUD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^\/rest\/api\/3\/[A-Za-z0-9/_.-]+$/;

export interface JiraCredentials {
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
  /** Set once the gateway form worked for this site (remembered in jira_sites.cloud_id). */
  readonly cloudId: string | null;
}

export interface JiraClientDeps {
  readonly fetch: FetchFn;
  readonly timeoutMs?: number;
  /** The site refused the token and the gateway form worked: remember the cloud id. */
  readonly onGateway?: (cloudId: string) => void;
}

export type Query = Readonly<Record<string, string | number | undefined>>;

export interface JiraHttp {
  get(path: string, query?: Query): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  /** The cloud id in use now (null = the classic site address). */
  cloudId(): string | null;
}

/** `https://name.atlassian.net` without a trailing slash; throws when it is anything else. */
export function siteOrigin(baseUrl: string): string {
  if (!isJiraSiteUrl(baseUrl)) throw new JiraError('site');
  return baseUrl.replace(/\/$/, '');
}

export function isCloudId(value: string): boolean {
  return CLOUD_ID_RE.test(value);
}

/** True only for https URLs on the site's own host or on api.atlassian.com under /ex/jira/<cloudId>/. */
export function isAllowedJiraUrl(url: string, site: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return false;
  if (parsed.host === new URL(site).host) return true;
  return parsed.host === GATEWAY_HOST && /^\/ex\/jira\/[0-9a-fA-F-]{36}\//.test(parsed.pathname);
}

function withQuery(path: string, query: Query | undefined): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export function createJiraClient(creds: JiraCredentials, deps: JiraClientDeps): JiraHttp {
  const site = siteOrigin(creds.baseUrl);
  const authorization = `Basic ${Buffer.from(`${creds.email}:${creds.token}`, 'utf8').toString('base64')}`;
  const secrets = [creds.token, authorization, authorization.slice('Basic '.length)];
  const timeoutMs = deps.timeoutMs ?? JIRA_TIMEOUT_MS;
  let cloudId = creds.cloudId !== null && isCloudId(creds.cloudId) ? creds.cloudId : null;

  const base = (): string => (cloudId === null ? site : `${JIRA_GATEWAY_ORIGIN}/ex/jira/${cloudId}`);

  async function send(url: string, init: RequestInit, signed: boolean): Promise<Response> {
    if (!isAllowedJiraUrl(url, site)) throw new JiraError('site');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (signed) headers.authorization = authorization;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await deps.fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new JiraError(isAbort(err) ? 'timeout' : 'unreachable');
    }
  }

  /** The site's cloud id from `/_edge/tenant_info` (asked without the token). */
  async function lookUpCloudId(): Promise<string | null> {
    const res = await send(`${site}/_edge/tenant_info`, { method: 'GET' }, false);
    if (!res.ok) return null;
    const body = await readJson(res);
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).cloudId : undefined;
    return typeof id === 'string' && isCloudId(id) ? id : null;
  }

  async function fail(res: Response): Promise<never> {
    const status = res.status;
    if (status === 401) throw new JiraError('auth');
    if (status === 403) throw new JiraError('forbidden');
    if (status === 404) throw new JiraNotFoundError();
    if (status === 429) throw new JiraError('busy');
    if (status >= 500) throw new JiraError('server');
    const detail = jiraDetail(await readJson(res).catch(() => null), secrets);
    throw new JiraError('bad', detail === '' ? undefined : scrub(`Jira did not accept that change: ${detail}`, secrets));
  }

  async function request(method: string, path: string, query?: Query, body?: unknown): Promise<unknown> {
    if (!PATH_RE.test(path)) throw new JiraError('site');
    const init: RequestInit = { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const target = withQuery(path, query);
    let res = await send(`${base()}${target}`, init, true);
    if (res.status === 401 && cloudId === null) {
      const found = await lookUpCloudId();
      if (found !== null) {
        const retry = await send(`${JIRA_GATEWAY_ORIGIN}/ex/jira/${found}${target}`, init, true);
        if (retry.status !== 401) {
          cloudId = found;
          deps.onGateway?.(found);
        }
        res = retry;
      }
    }
    if (!res.ok) return fail(res);
    const parsed = await readJson(res);
    if (parsed === undefined) throw new JiraError('unreadable');
    return parsed;
  }

  return {
    get: (path, query) => request('GET', path, query),
    post: (path, body) => request('POST', path, undefined, body),
    put: (path, body) => request('PUT', path, undefined, body),
    cloudId: () => cloudId,
  };
}
