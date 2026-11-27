import { PAGE_KEY_HEADER, PAGE_KEY_STORAGE } from '@luady/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../src/api/client.js';
import { me } from '../fixtures.js';

afterEach(() => {
  localStorage.clear();
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The client's injected fetch: `/api/me` signs in (and sets the CSRF token), every other path answers `body`. */
function recordingFetch(body: unknown, status = 200) {
  return vi.fn(async (input: string, _init: RequestInit) => (input === '/api/me' ? jsonResponse(me({ csrf: 'csrf-1' })) : jsonResponse(body, status)));
}

const FILE = { id: '00000000-0000-4000-8000-000000000001', name: 'a.pdf', mime: 'application/pdf', size: 4 };

describe('the channels API on the main client', () => {
  it('lists channels and posts a panel action with the signed-in CSRF token and the page key', async () => {
    localStorage.setItem(PAGE_KEY_STORAGE, 'k'.repeat(43));
    const fetch = recordingFetch({ ok: true });
    const api = createApiClient({ fetch });
    await api.me();
    await api.channels.action('test-channel', { action: 'unlink', pin: '123456' });
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(url).toBe('/api/channels/test-channel/action');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['X-Hub-CSRF']).toBe('csrf-1');
    expect((init?.headers as Record<string, string>)[PAGE_KEY_HEADER]).toBe('k'.repeat(43));
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'unlink', pin: '123456' });
    const list = createApiClient({ fetch: recordingFetch([]) });
    await expect(list.channels.list()).resolves.toEqual([]);
  });

  it('accepts only an https provider link from connect', async () => {
    const api = createApiClient({ fetch: recordingFetch({ url: 'javascript:alert(1)' }) });
    await expect(api.channels.connect('google', { pin: '123456' })).rejects.toMatchObject({ code: 'bad_response' });
    const ok = createApiClient({ fetch: recordingFetch({ url: 'https://accounts.example.com/x?state=s' }) });
    await expect(ok.channels.connect('google', { pin: '123456', label: 'work' })).resolves.toEqual({ url: 'https://accounts.example.com/x?state=s' });
  });

  it('downloads a file through the same fetch with the page key, and reports a refusal or a lost connection as an error', async () => {
    localStorage.setItem(PAGE_KEY_STORAGE, 'p'.repeat(43));
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response('%PDF', { status: 200 }));
    await expect((await createApiClient({ fetch }).channels.download(FILE)).text()).resolves.toBe('%PDF');
    expect(fetch).toHaveBeenCalledWith(`/api/files/${FILE.id}`, expect.objectContaining({
      method: 'GET', headers: expect.objectContaining({ [PAGE_KEY_HEADER]: 'p'.repeat(43) }),
    }));
    const refused = createApiClient({ fetch: async () => jsonResponse({ error: { code: 'page_key_required', message: 'Sign in again on this page' } }, 401) });
    await expect(refused.channels.download(FILE)).rejects.toMatchObject({ status: 401, code: 'page_key_required' });
    const offline = createApiClient({ fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(offline.channels.download(FILE)).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('never uses the browser fetch: every channels route goes through the fetch the client was given', async () => {
    const browser = vi.fn(async () => Promise.reject(new Error('the browser fetch was used')));
    vi.stubGlobal('fetch', browser);
    const given = vi.fn(async (input: string, _init: RequestInit) => {
      if (input === '/api/channels') return jsonResponse([]);
      if (input.startsWith('/api/connect/')) return jsonResponse({ url: 'https://accounts.example.com/x' });
      return input.startsWith('/api/files/') ? new Response('%PDF') : jsonResponse({ ok: true });
    });
    const api = createApiClient({ fetch: given });
    await api.channels.list();
    await api.channels.action('test-channel', { action: 'ping' });
    await api.channels.connect('wispr', { pin: '123456' });
    await api.channels.download(FILE);
    expect(given.mock.calls.map(([url]) => url)).toEqual(['/api/channels', '/api/channels/test-channel/action', '/api/connect/wispr', `/api/files/${FILE.id}`]);
    expect(browser).not.toHaveBeenCalled();
  });
});
