import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, isApiError, userMessage } from '../../src/api/errors.js';
import { createHttp, type FetchLike } from '../../src/api/http.js';
import { createApiClient } from '../../src/api/client.js';
import { HOST_GRANT_HEADER, PAGE_KEY_HEADER } from '@luady/shared';

const Ok = z.object({ ok: z.literal(true) });

function respond(status: number, body: unknown, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'Content-Type': contentType } });
}

function recorder(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch, calls };
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

const headersOf = (init: RequestInit | undefined): Record<string, string> => (init?.headers ?? {}) as Record<string, string>;

describe('createHttp', () => {
  it('sends same-origin JSON requests and the CSRF token only on writes', async () => {
    const { fetch, calls } = recorder(respond(200, { ok: true }), respond(200, { ok: true }));
    const http = createHttp({ fetch });
    http.setCsrf('csrf-1');
    await http.request('GET', '/api/settings', Ok);
    await http.request('POST', '/api/sessions/x/interrupt', Ok, {});
    const [get, post] = calls;
    expect(get?.init.credentials).toBe('same-origin');
    expect(get?.init.redirect).toBe('manual');
    expect(headersOf(get?.init)['X-Hub-CSRF']).toBeUndefined();
    expect(post?.init.method).toBe('POST');
    expect(headersOf(post?.init)['X-Hub-CSRF']).toBe('csrf-1');
    expect(headersOf(post?.init)['Content-Type']).toBe('application/json');
    expect(post?.init.body).toBe('{}');
  });

  it('turns the hub error body into a typed ApiError', async () => {
    const { fetch } = recorder(respond(409, { error: { code: 'question_closed', message: 'Question #ABCDEFGH was already answered' } }));
    const err = await caught(createHttp({ fetch }).request('POST', '/api/questions/ABCDEFGH/answer', Ok, { answers: {} }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('question_closed');
    expect(err.message).toBe('Question #ABCDEFGH was already answered');
    expect(isApiError(err, 'question_closed')).toBe(true);
  });

  it('keeps PIN details the hub adds to the error body', async () => {
    const { fetch } = recorder(respond(403, { error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 2 } }));
    const err = await caught(createHttp({ fetch }).request('POST', '/api/actions/A7/confirm', Ok, { pin: '000000' }));
    expect(err.details.remaining).toBe(2);
  });

  it('falls back to http_<status> when the error body is not JSON', async () => {
    const { fetch } = recorder(respond(502, '<html>Bad gateway</html>', 'text/html'));
    const err = await caught(createHttp({ fetch }).request('GET', '/api/overview', Ok));
    expect(err.code).toBe('http_502');
    expect(userMessage(err)).toMatch(/restarting/);
  });

  it('rejects a response that fails schema validation', async () => {
    const { fetch } = recorder(respond(200, { ok: 'yes' }));
    const err = await caught(createHttp({ fetch }).request('GET', '/api/settings', Ok));
    expect(err.code).toBe('bad_response');
    expect(err.status).toBe(200);
  });

  it('reports network failures', async () => {
    const { fetch } = recorder(new TypeError('Failed to fetch'));
    const err = await caught(createHttp({ fetch }).request('GET', '/api/overview', Ok));
    expect(err.status).toBe(0);
    expect(err.code).toBe('network');
  });

  it('treats a redirect as an expired Cloudflare Access login', async () => {
    const redirect = { type: 'opaqueredirect', status: 0, ok: false, text: async () => '' } as unknown as Response;
    const { fetch } = recorder(redirect);
    const err = await caught(createHttp({ fetch }).request('GET', '/api/overview', Ok));
    expect(err.code).toBe('access_expired');
  });
});

describe('userMessage', () => {
  it('turns errors into friendly text', () => {
    expect(userMessage(new ApiError(401, 'auth', 'no session'))).toMatch(/sign in again/i);
    expect(userMessage(new ApiError(403, 'forbidden', 'Forbidden'))).toMatch(/Reload the page/);
    expect(userMessage(new ApiError(429, 'rate_limited', 'slow down'))).toBe('Too many requests. Wait a moment and try again.');
    expect(userMessage(new ApiError(500, 'internal', 'boom'))).toMatch(/unexpected error/i);
    expect(userMessage(new ApiError(502, 'failed', 'ssh timeout'))).toBe('The server command failed: ssh timeout');
    expect(userMessage(new ApiError(409, 'refused', 'Session is busy'))).toBe('Session is busy');
    expect(userMessage(new Error('plain'))).toBe('plain');
    expect(userMessage('weird')).toBe('Something went wrong. Try again.');
  });
});

describe('per-request headers (the hosts routes of the main client)', () => {
  it('sends a request\'s own headers next to the page key and CSRF token, which they never replace', async () => {
    const { fetch, calls } = recorder(respond(200, { ok: true }));
    const http = createHttp({ fetch, pageKey: () => 'k'.repeat(43) });
    http.setCsrf('csrf-1');
    await http.request('POST', '/api/x', Ok, {}, { 'x-extra': 'one', 'X-Hub-CSRF': 'forged', [PAGE_KEY_HEADER]: 'forged' });
    expect(headersOf(calls[0]?.init)).toMatchObject({ 'x-extra': 'one', 'X-Hub-CSRF': 'csrf-1', [PAGE_KEY_HEADER]: 'k'.repeat(43) });
  });

  it('api.hosts sends a host\'s grant in its own header, and only on the routes that take one', async () => {
    const host = {
      id: 'mars', kind: 'ssh', host: 'mars.example.invalid', user: 'dev', port: 22, source: 'web', state: 'pinned', fingerprint: null,
      link: 'online', lastError: null, kitVersion: null, kitAlias: null, claudeVersion: null, claudeSignedIn: null, projectsRoot: null,
      homeDir: null, terminal: true, fromAddr: null, createdAt: '2026-11-21T08:00:00.000Z', updatedAt: '2026-11-21T08:00:00.000Z',
    };
    const { fetch, calls } = recorder(respond(200, host), respond(200, [host]));
    const api = createApiClient({ fetch, pageKey: () => null });
    await api.hosts.pin('mars', 'SHA256:x', 'grant-1');
    await api.hosts.list();
    expect(calls.map((c) => c.url)).toEqual(['/api/hosts/mars/pin', '/api/hosts']);
    expect(headersOf(calls[0]?.init)[HOST_GRANT_HEADER]).toBe('grant-1');
    expect(headersOf(calls[1]?.init)).not.toHaveProperty(HOST_GRANT_HEADER);
  });
});
