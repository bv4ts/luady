import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_KEY_HEADER } from '@luady/shared';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/core/contracts.js';
import { CONNECT_STATE_TTL_MS } from '../../src/google/connect-flow.js';
import { createSessionStore, SESSION_COOKIE } from '../../src/web/auth/sessions.js';
import { createFakeClock } from '../helpers/fakes.js';
import { FIXTURE_PIN } from '../helpers/claimed.js';
import { openTestChat, testChatDecl } from '../helpers/chat-addon.js';
import { everythingConfig, startWiring, type WiringRun } from '../wire/wiring-harness.js';

/** Google and Wispr connected from the website, with the state bound to the session. */
const PUBLIC = fileURLToPath(new URL('../../../web/public/', import.meta.url));
const PIN = '246810';
const T0 = '2026-11-21T08:00:00.000Z';
const OWNER = '447700900001';

let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  vi.restoreAllMocks();
});

/** Google's token answer: a refresh token and an ID token naming the account (built here, never a real value). */
function stubGoogle(): void {
  const claims = Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url');
  const idToken = ['e30', claims, 'sig'].join('.');
  const refresh = ['test', 'refresh', 'value'].join('-');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ refresh_token: refresh, id_token: idToken }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

interface Browser { readonly cookie: string; readonly pageKey?: string; readonly csrf?: string }
type Hub = WiringRun & { clock: ReturnType<typeof createFakeClock>; owner: Browser; other: Browser };

function headers(run: WiringRun, who: Browser, json = false): Record<string, string> {
  return {
    host: new URL(run.config.publicOrigin).host, origin: run.config.publicOrigin, 'cf-access-jwt-assertion': 'test-jwt', cookie: who.cookie,
    ...(who.pageKey === undefined ? {} : { [PAGE_KEY_HEADER]: who.pageKey }),
    ...(who.csrf === undefined ? {} : { 'x-hub-csrf': who.csrf }),
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

/** `withChat`: the test chat add-on is declared too (the chat's /google command). */
async function hub(withChat = false): Promise<Hub> {
  const clock = createFakeClock(T0);
  let db: Db | null = null;
  const config = withChat ? { ...everythingConfig(), addons: [testChatDecl(OWNER)] } : everythingConfig();
  const run = await startWiring({ clock }, config, false, (seeded) => {
    db = seeded;
  });
  running = run.app;
  // The wiring harness hands over a set-up install; this suite's own PIN replaces the fixture's.
  await run.app.services.pin.set(PIN, { currentPin: FIXTURE_PIN });
  copyFileSync(join(PUBLIC, 'connect-return.html'), join(run.config.webDir, 'connect-return.html'));
  if (db === null) throw new Error('no database');
  const second = createSessionStore({ db, clock: { now: () => new Date(T0) } }).create();
  const browser = async (cookie: string, pageKey: string): Promise<Browser> => {
    const me = await run.app.web.inject({ method: 'GET', url: '/api/me', headers: headers(run, { cookie, pageKey }) });
    return { cookie, pageKey, csrf: me.json<{ csrf: string }>().csrf };
  };
  return {
    ...run, clock,
    owner: await browser(run.cookie, run.pageKey),
    other: await browser(`${SESSION_COOKIE}=${encodeURIComponent(run.app.web.signCookie(second.sid))}`, second.pageKey),
  };
}

const start = (run: Hub, body: object) =>
  run.app.web.inject({ method: 'POST', url: '/api/connect/google', headers: headers(run, run.owner, true), payload: body });
const finish = (run: Hub, who: Browser, state: string) =>
  run.app.web.inject({ method: 'POST', url: '/api/connect/google/finish', headers: headers(run, who, true), payload: { code: 'the-code', state } });
const callback = (run: Hub, query: string) =>
  run.app.web.inject({ method: 'GET', url: `/api/google/callback?${query}`, headers: { host: new URL(run.config.publicOrigin).host } });
const stateOf = (url: string): string => new URL(url).searchParams.get('state') ?? '';

describe('connecting Google from the website', () => {
  it('needs the PIN: none or a wrong one gives 403; the right one gives the consent link', async () => {
    const run = await hub();
    expect((await start(run, {})).statusCode).toBe(403);
    expect((await start(run, { pin: '000000' })).statusCode).toBe(403);
    const ok = await start(run, { pin: PIN, label: 'work' });
    expect(ok.statusCode).toBe(200);
    const url = new URL(ok.json<{ url: string }>().url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`${run.config.publicOrigin}/api/google/callback`);
  });

  it('the callback serves the static return page, with no inline script, and finishes nothing', async () => {
    const run = await hub();
    stubGoogle();
    const state = stateOf((await start(run, { pin: PIN })).json<{ url: string }>().url);
    const page = await callback(run, `code=the-code&state=${state}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    const scripts = [...page.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toContain('src="/connect-return.js"');
    expect(scripts[0]?.[2]?.trim()).toBe('');
    expect(page.body).not.toMatch(/\son[a-z]+=/i);
    expect(page.body).not.toContain('the-code');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const script = readFileSync(join(PUBLIC, 'connect-return.js'), 'utf8');
    expect(script).toContain("'/api/connect/' + service + '/finish'");
    expect(script).not.toMatch(/innerHTML|eval\(|document\.write/);
  });

  it('finish without the page key gives 401, from another session 403, and works once only', async () => {
    const run = await hub();
    stubGoogle();
    const state = stateOf((await start(run, { pin: PIN })).json<{ url: string }>().url);
    expect((await finish(run, { cookie: run.owner.cookie, ...(run.owner.csrf === undefined ? {} : { csrf: run.owner.csrf }) }, state)).statusCode).toBe(401);
    expect((await finish(run, run.other, state)).statusCode).toBe(403);
    const done = await finish(run, run.owner, state);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ ok: true, message: 'owner@example.com is connected as "personal".' });
    expect((await finish(run, run.owner, state)).statusCode).toBe(409);
    // A used website state can never come back as a chat link on the callback.
    expect((await callback(run, `code=the-code&state=${state}`)).statusCode).toBe(400);
  });

  it('a state lives 10 minutes: after that neither finish nor the callback takes it', async () => {
    const run = await hub();
    stubGoogle();
    const state = stateOf((await start(run, { pin: PIN })).json<{ url: string }>().url);
    run.clock.advance(CONNECT_STATE_TTL_MS + 1000);
    expect((await finish(run, run.owner, state)).statusCode).toBe(409);
    expect((await callback(run, `code=the-code&state=${state}`)).statusCode).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('the chat /google link comes from the same builder and still finishes on its callback', async () => {
    const run = await hub(true);
    stubGoogle();
    const chat = await openTestChat(run.app, run.config.dataDir, {
      capabilities: {
        text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
        replyQuote: true, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
      },
    });
    const frames = chat.frames;
    const say = (frame: object): void => chat.receive(frame);
    say({ t: 'incoming', msgId: 'in-1', from: OWNER, text: '/google', ts: 1_795_000_000 });
    await vi.waitFor(() => expect(frames.some((f) => f.t === 'send')).toBe(true));
    const text = String(frames.find((f) => f.t === 'send')?.text);
    const link = /\/api\/google\/connect\?t=[A-Za-z0-9_-]+/.exec(text)?.[0] ?? '';
    expect(link).not.toBe('');
    const redirect = await run.app.web.inject({ method: 'GET', url: link, headers: { host: new URL(run.config.publicOrigin).host } });
    expect(redirect.statusCode).toBe(302);
    const state = stateOf(String(redirect.headers.location));
    const done = await callback(run, `code=the-code&state=${state}`);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('owner@example.com is connected as &quot;personal&quot;.'.replace(/&quot;/g, '"'));
    expect((await run.app.web.inject({ method: 'GET', url: link, headers: { host: new URL(run.config.publicOrigin).host } })).statusCode).toBe(401);
  });
});
