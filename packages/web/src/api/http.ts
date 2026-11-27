import type { z } from 'zod';
import { PAGE_KEY_HEADER } from '@luady/shared';
import { readPageKey } from '../auth/page-key.js';
import { ApiError, errorFromResponse } from './errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface HttpOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** The page key to send on every request; the stored one by default. */
  pageKey?: () => string | null;
}

export interface Http {
  /** `headers`: extra headers of this one request (a host grant, say); they never replace the page key or CSRF. */
  request<S extends z.ZodType>(method: HttpMethod, path: string, schema: S, body?: unknown, headers?: Readonly<Record<string, string>>): Promise<z.output<S>>;
  /** A GET whose answer is bytes (a file the hub keeps): the same headers and refusals as `request`, the body as a Blob. */
  blob(path: string): Promise<Blob>;
  setCsrf(token: string | null): void;
  csrf(): string | null;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Returns undefined for an empty or non-JSON body; callers turn that into http_<status> or bad_response. */
async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw new ApiError(res.status, 'network', 'The connection dropped while Luady was answering. Try again.', {}, cause);
  }
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createHttp(options: HttpOptions = {}): Http {
  const doFetch = options.fetch ?? defaultFetch;
  const baseUrl = options.baseUrl ?? '';
  const pageKey = options.pageKey ?? readPageKey;
  let csrfToken: string | null = null;

  async function send(
    method: HttpMethod, path: string, body: unknown, extra: Readonly<Record<string, string>>, accept = 'application/json',
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extra, Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['X-Hub-CSRF'] = csrfToken;
    const key = pageKey();
    if (key !== null) headers[PAGE_KEY_HEADER] = key;
    try {
      return await doFetch(baseUrl + path, {
        method, headers, credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new ApiError(0, 'network', 'Cannot reach Luady. Check your connection and try again.', {}, cause);
    }
  }

  /** A redirect means Cloudflare Access wants a new sign-in: never followed, always reported. */
  function refuseRedirect(res: Response): void {
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new ApiError(res.status, 'access_expired', 'Your Cloudflare Access login expired. Reload the page to sign in again.');
    }
  }

  async function request<S extends z.ZodType>(
    method: HttpMethod, path: string, schema: S, body?: unknown, headers: Readonly<Record<string, string>> = {},
  ): Promise<z.output<S>> {
    const res = await send(method, path, body, headers);
    refuseRedirect(res);
    const payload = await readJson(res);
    if (!res.ok) throw errorFromResponse(res.status, payload);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const route = `${method} ${path.split('?')[0] ?? path}`;
      throw new ApiError(res.status, 'bad_response', `Luady sent an unexpected response for ${route}.`, {}, parsed.error);
    }
    return parsed.data;
  }

  async function blob(path: string): Promise<Blob> {
    const res = await send('GET', path, undefined, {}, '*/*');
    refuseRedirect(res);
    if (!res.ok) throw errorFromResponse(res.status, await readJson(res));
    try {
      return await res.blob();
    } catch (cause) {
      throw new ApiError(res.status, 'network', 'The connection dropped while Luady was answering. Try again.', {}, cause);
    }
  }

  return {
    request,
    blob,
    setCsrf: (token) => {
      csrfToken = token;
    },
    csrf: () => csrfToken,
  };
}
