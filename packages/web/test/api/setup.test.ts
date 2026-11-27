import { describe, expect, it, vi } from 'vitest';
import { PAGE_KEY_HEADER, type SetupStateDTO } from '@luady/shared';
import type { FetchLike } from '../../src/api/http.js';
import { createSetupApi } from '../../src/api/setup.js';

const STATE: SetupStateDTO = { step: 'rooms', claimed: true, authMode: 'local', remote: false, skipped: [] };
const KEY = 'p'.repeat(43);
const TOKEN = 't'.repeat(43);

function recording(answer: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch, calls };
}

const headersOf = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

describe('the setup API', () => {
  it('reads the state with a plain GET: no CSRF token, and no page key before a sign-in', async () => {
    const { fetch, calls } = recording(STATE);
    const api = createSetupApi({ csrf: () => 'csrf-1', fetch, pageKey: () => null });
    expect(await api.state()).toEqual(STATE);
    expect(calls[0]?.url).toBe('/api/setup/state');
    expect(calls[0]?.init.method).toBe('GET');
    expect(headersOf(calls[0]!.init)['X-Hub-CSRF']).toBeUndefined();
    expect(headersOf(calls[0]!.init)[PAGE_KEY_HEADER]).toBeUndefined();
  });

  it('sends a step with the CSRF token read at that moment and the page key', async () => {
    const { fetch, calls } = recording(STATE);
    let csrf: string | null = null;
    const api = createSetupApi({ csrf: () => csrf, fetch, pageKey: () => KEY });
    csrf = 'csrf-2';
    expect(await api.step({ step: 'rooms', action: 'skip' })).toEqual(STATE);
    expect(calls[0]?.url).toBe('/api/setup/step');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ step: 'rooms', action: 'skip' });
    expect(headersOf(calls[0]!.init)).toMatchObject({ 'X-Hub-CSRF': 'csrf-2', [PAGE_KEY_HEADER]: KEY });
  });

  it('finishes with an empty body', async () => {
    const { fetch, calls } = recording({ ...STATE, step: 'done' });
    const api = createSetupApi({ csrf: () => 'csrf-3', fetch, pageKey: () => KEY });
    expect((await api.finish()).step).toBe('done');
    expect(calls[0]?.url).toBe('/api/setup/finish');
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('signs in with a login token and returns the page key; a malformed body never leaves the page', async () => {
    const { fetch, calls } = recording({ pageKey: KEY });
    const api = createSetupApi({ csrf: () => null, fetch, pageKey: () => null });
    expect(await api.login({ token: TOKEN, pin: '482915' })).toEqual({ pageKey: KEY });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ token: TOKEN, pin: '482915' });
    await expect(api.login({ token: 'short' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.step({ step: 'pin' as 'rooms', action: 'done' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(1);
  });

  it('refuses an answer that is not a state', async () => {
    const { fetch } = recording({ step: 'claim', claimed: false, authMode: 'local', remote: false, skipped: [], owner: 'Robin' });
    const api = createSetupApi({ csrf: () => null, fetch, pageKey: () => null });
    // Extra fields are dropped by the schema; only the five are kept.
    expect(Object.keys(await api.state()).sort()).toEqual(['authMode', 'claimed', 'remote', 'skipped', 'step']);
    const broken = recording({ step: 'elsewhere' });
    await expect(createSetupApi({ csrf: () => null, fetch: broken.fetch, pageKey: () => null }).state()).rejects.toMatchObject({ code: 'bad_response' });
  });
});
