import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginResultDTOSchema, LoginStartDTOSchema, type AccountDTO, type AccountsDTO, type ChatMessageDTO, type MeDTO, type OverviewDTO, type QuestionDTO } from '@luady/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPreview, type Preview } from '../main.ts';
import { authFrame, pageKeyAfterLogin, signedIn } from './sign-in.ts';

const hubRequire = createRequire(new URL('../../packages/hub/package.json', import.meta.url));
const WebSocket = hubRequire('ws') as typeof import('ws').default;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await sleep(100);
    value = await read();
  }
  return value;
}

let preview: Preview;
let cookie = '';
let csrf = '';
/** The page key of the sign-in: sent on every /api call and as a socket's first message. */
let pageKey = '';

const browserOrigin = (): string => `http://localhost:${preview.port}`;
const publicOrigin = (): string => `https://localhost:${preview.port}`;
const signed = (): Record<string, string> => signedIn({ cookie, pageKey });
const authed = (): Record<string, string> => ({ ...signed(), 'x-hub-csrf': csrf, origin: browserOrigin() });
const overview = async (): Promise<OverviewDTO> => (await fetch(`${preview.url}/api/overview`, { headers: signed() })).json() as Promise<OverviewDTO>;
const sessionState = (o: OverviewDTO, id: string): string | undefined => o.sessions.find((s) => s.id === id)?.state;
const accounts = async (): Promise<AccountsDTO> => (await fetch(`${preview.url}/api/accounts`, { headers: signed() })).json() as Promise<AccountsDTO>;
const claudeIds = (list: AccountsDTO): string[] => list.accounts.filter((a) => a.provider === 'claude').map((a) => a.id);
const account = (list: AccountsDTO, id: string): AccountDTO | undefined => list.accounts.find((a) => a.id === id);

async function run(scenario: string, args: readonly string[]): Promise<Response> {
  return fetch(`${preview.url}/__preview/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicOrigin() },
    body: JSON.stringify({ scenario, args }),
  });
}

function firstFrame(headers: Record<string, string>, key?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${preview.port}/ws`, { headers });
    if (key !== undefined) socket.once('open', () => socket.send(authFrame(key)));
    socket.once('message', (data) => {
      resolve(JSON.parse(String(data)));
      socket.close();
    });
    socket.once('unexpected-response', (request, response) => {
      request.destroy();
      reject(new Error(`refused with HTTP ${response.statusCode}`));
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed before a frame')));
  });
}

describe('startPreview', () => {
  it('refuses a production environment before it touches a database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luady-preview-refused-'));
    try {
      await expect(startPreview({ env: { NODE_ENV: 'production' }, dir })).rejects.toThrow(/preview-refused/);
      expect(existsSync(join(dir, 'data', 'hub.db'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a running preview', () => {
  beforeAll(async () => {
    preview = await startPreview({ port: await freePort(), env: {} });
  }, 60_000);

  afterAll(async () => {
    await preview?.stop();
  });

  it('signs the browser in through the one-time link of this run, and only once', async () => {
    const link = preview.loginUrl();
    expect(link.startsWith(`${preview.url}/__preview/login?t=`)).toBe(true);
    expect(new URL(link).searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await fetch(`${preview.url}/__preview/login`, { redirect: 'manual' })).status).toBe(403);
    const res = await fetch(link, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect((await fetch(link, { redirect: 'manual' })).status).toBe(403);
    expect(preview.loginUrl()).not.toBe(link);
    const sid = res.headers.getSetCookie().find((line) => line.startsWith('hub_sid='));
    expect(sid).toBeDefined();
    cookie = (sid ?? '').split(';')[0] ?? '';
    pageKey = await pageKeyAfterLogin(preview.url, cookie);
    const me = await fetch(`${preview.url}/api/me`, { headers: signed() });
    expect(me.status).toBe(200);
    const body = (await me.json()) as MeDTO;
    expect(body.pinSet).toBe(true);
    csrf = body.csrf;
  });

  it('serves the built website', async () => {
    const res = await fetch(`${preview.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<div id="root">/);
  });

  it('is a finished install: the website opens on the office, not in the setup wizard', async () => {
    const res = await fetch(`${preview.url}/api/setup/state`, { headers: { origin: `https://localhost:${preview.port}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step: 'done', claimed: true });
  });

  it('shows the seeded fleet and still asks for a session', async () => {
    expect((await fetch(`${preview.url}/api/overview`)).status).toBe(401);
    const o = await until(overview, (v) => v.sessions.length === 25 && v.questions.length === 2, 5_000);
    expect(o.servers.map((s) => `${s.name}:${s.status}`)).toEqual(['cedar:online', 'birch:online', 'ash:online', 'local:online']);
    // The classic four, imported once from config.rooms into the rooms table.
    expect(o.rooms.map((r) => `${r.position}:${r.name}:${r.host}`)).toEqual(['0:Orchard:birch', '1:Harbor:ash', '2:Meadow:cedar', '3:Private Projects:local']);
    const rooms = (await (await fetch(`${preview.url}/api/rooms`, { headers: signed() })).json()) as { items: Array<{ id: string }> };
    expect(rooms.items.map((r) => r.id)).toEqual(['birch', 'ash', 'cedar', 'local']);
    expect(o.sessions).toHaveLength(25);
    expect(o.questions).toHaveLength(2);
    expect(sessionState(o, 'birch:cc-app-backend:0.0')).toBe('working');
  });

  it('runs a scenario and answers its question through the real route', async () => {
    expect((await run('ask', ['cedar/meadow-vat'])).status).toBe(200);
    const o = await until(overview, (v) => v.questions.length === 3, 5_000);
    const question = o.questions.find((q) => q.sessionId === 'cedar:cc-meadow-vat:0.0') as QuestionDTO;
    const ask = question.questions[0]!;
    const res = await fetch(`${preview.url}/api/questions/${question.qid}/answer`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { [ask.question]: ask.options[0]!.label } }),
    });
    expect(res.status).toBe(200);
    const after = await until(overview, (v) => v.questions.length === 2, 5_000);
    expect(after.questions.map((q) => q.qid)).not.toContain(question.qid);
  });

  it('refuses a scenario on a session that does not exist and keeps running', async () => {
    const res = await run('work', ['nope/none']);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Known:');
    expect((await fetch(`${preview.url}/api/overview`, { headers: signed() })).status).toBe(200);
  });

  it('opens the live WebSocket only with a session', async () => {
    await expect(firstFrame({ cookie, origin: browserOrigin() }, pageKey)).resolves.toMatchObject({ type: 'hello' });
    await expect(firstFrame({ origin: browserOrigin() })).rejects.toThrow();
  });

  it('lets the owner talk to Luady and get the preview answer', async () => {
    const res = await fetch(`${preview.url}/api/manager/messages`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    const read = async (): Promise<ChatMessageDTO[]> =>
      ((await (await fetch(`${preview.url}/api/manager/messages`, { headers: signed() })).json()) as { items: ChatMessageDTO[] }).items;
    const items = await until(read, (list) => list.some((m) => m.role === 'manager'), 15_000);
    expect(items.find((m) => m.role === 'manager')?.text).toBe('Preview Luady: got it.');
  }, 30_000);

  it('keeps the seeded red question as a notice on the website (no add-on is attached)', async () => {
    const read = async () => ((await (await fetch(`${preview.url}/api/notices`, { headers: signed() })).json()) as { items: Array<{ text: string }> }).items;
    const items = await until(read, (list) => list.some((i) => i.text.includes('#')), 5_000);
    expect(items.some((i) => i.text.includes('#'))).toBe(true);
  });

  it('keeps an ended session ended through a reconciliation, and shows a started one', async () => {
    expect((await run('end', ['cedar/meadow-share'])).status).toBe(200);
    const ended = await until(overview, (v) => sessionState(v, 'cedar:cc-meadow-share:0.0') === 'ended', 5_000);
    expect(sessionState(ended, 'cedar:cc-meadow-share:0.0')).toBe('ended');
    await sleep(20_000);
    expect(sessionState(await overview(), 'cedar:cc-meadow-share:0.0')).toBe('ended');
    expect((await run('start', ['ash', 'newthing'])).status).toBe(200);
    const started = await until(overview, (v) => sessionState(v, 'ash:cc-newthing:0.0') !== undefined, 5_000);
    expect(sessionState(started, 'ash:cc-newthing:0.0')).toBe('idle');
  }, 40_000);

  it('groups the hosts by account: cedar, birch, ash, and local with the self host as Luady\'s own, plus Codex', async () => {
    expect((await fetch(`${preview.url}/api/accounts`)).status).toBe(401);
    const list = await until(accounts, (a) => claudeIds(a).length === 4, 10_000);
    expect(claudeIds(list)).toEqual(['claude:org_luady', 'claude:org_team_b', 'claude:org_team_a', 'claude:org_max']);
    const luady = list.accounts[0];
    expect(luady).toMatchObject({ isManager: true, plan: 'max', orgName: 'Luady' });
    expect(luady?.hosts.map((h) => h.host)).toEqual(['hq', 'local']);
    expect(list.accounts.at(-1)).toMatchObject({ id: 'codex', provider: 'codex' });
    // No chat channel: the preview attaches no add-on.
    expect(list.connections.map((c) => c.id)).toEqual(['google', 'imap', 'wispr', 'jira']);
  });

  it('shows plan limits after a meter reading, and "does not report" after five readings without any', async () => {
    expect((await run('limits', ['cedar', '62', '41'])).status).toBe(200);
    const withLimits = await until(accounts, (a) => account(a, 'claude:org_max')?.limits.reported === 'yes', 5_000);
    expect(account(withLimits, 'claude:org_max')?.limits).toMatchObject({ reported: 'yes', fiveHour: { usedPct: 62 }, sevenDay: { usedPct: 41 } });
    expect((await run('no-limits', ['birch'])).status).toBe(200);
    const none = await until(accounts, (a) => account(a, 'claude:org_team_a')?.limits.reported === 'no', 5_000);
    expect(account(none, 'claude:org_team_a')?.limits).toEqual({ reported: 'no', fiveHour: null, sevenDay: null, updatedAt: expect.any(String) });
  });

  it('starts a sign-in on a signed-in host only with the PIN, and takes its code: a wrong one is refused, the preview code signs in', async () => {
    const post = (path: string, body: object) => fetch(`${preview.url}/api/accounts/${path}`, {
      method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post('cedar/login', {})).status).toBe(428);
    const started = LoginStartDTOSchema.parse(await (await post('cedar/login', { pin: '123456' })).json());
    expect(new URL(started.url).hostname).toBe('luady-preview.claude.ai');
    const wrong = LoginResultDTOSchema.parse(await (await post('cedar/code', { code: 'wrong-code-99' })).json());
    expect(wrong).toMatchObject({ ok: false, message: 'Invalid code' });
    const right = LoginResultDTOSchema.parse(await (await post('cedar/code', { code: 'preview-code-1234' })).json());
    expect(right).toMatchObject({ ok: true, loggedIn: true });
    const again = LoginResultDTOSchema.parse(await (await post('cedar/code', { code: 'preview-code-1234' })).json());
    expect(again.message).toMatch(/^No sign-in is waiting/);
  });

  it('signs a host out only with the PIN', async () => {
    const post = (body: object) => fetch(`${preview.url}/api/accounts/ash/logout`, {
      method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({})).status).toBe(400);
    expect((await post({ pin: '000000' })).status).toBe(403);
    const done = await post({ pin: '123456' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ kind: 'account.logout', status: 'done' });
    const list = await accounts();
    expect(list.accounts.find((a) => a.id === 'claude:host:ash')?.hosts[0]).toMatchObject({ host: 'ash', loggedIn: false });
  });

  it('a sign-in on another account is reported once, on the website', async () => {
    const post = (path: string, body: object) => fetch(`${preview.url}/api/accounts/${path}`, {
      method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await post('birch/login', { pin: '123456' });
    expect(LoginResultDTOSchema.parse(await (await post('birch/code', { code: 'preview-code-5678' })).json())).toMatchObject({ ok: true });
    const read = async () => ((await (await fetch(`${preview.url}/api/notices`, { headers: signed() })).json()) as { items: Array<{ text: string }> }).items;
    const items = await until(read, (list) => list.some((i) => i.text.startsWith('🔐 birch is now signed in')), 5_000);
    expect(items.filter((i) => i.text.startsWith('🔐 birch is now signed in')).map((i) => i.text)).toEqual([
      '🔐 birch is now signed in to Other Org (pro). If that was not you, sign it out.',
    ]);
  });

  it('a chat message sent while Luady is signed out is kept, and reaches Luady after the sign-in', async () => {
    const post = (path: string, body: object) => fetch(`${preview.url}/api/${path}`, {
      method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post('accounts/hq/logout', { pin: '123456' })).status).toBe(200);
    const sent = await post('manager/messages', { text: 'are you there while signed out?' });
    expect(await sent.json()).toEqual({ ok: true, held: true });
    const read = async (): Promise<ChatMessageDTO[]> =>
      ((await (await fetch(`${preview.url}/api/manager/messages?limit=10`, { headers: signed() })).json()) as { items: ChatMessageDTO[] }).items;
    const held = await until(read, (list) => list.at(-1)?.text === 'are you there while signed out?', 5_000);
    expect(held.at(-1)).toMatchObject({ role: 'owner', channel: 'web', text: 'are you there while signed out?' });
    expect(((await (await fetch(`${preview.url}/api/manager/status`, { headers: signed() })).json()) as { queued: number }).queued).toBe(1);
    await post('accounts/hq/login', {});
    expect(LoginResultDTOSchema.parse(await (await post('accounts/hq/code', { code: 'preview-code-1234' })).json())).toMatchObject({ ok: true, brainRestarted: true });
    const answered = await until(read, (list) => list.at(-1)?.role === 'manager', 20_000);
    expect(answered.at(-1)).toMatchObject({ role: 'manager', text: 'Preview Luady: got it.' });
  }, 40_000);

  it('names the port and the --port flag when the port is taken, before it opens a database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luady-preview-busy-'));
    try {
      const second = startPreview({ port: preview.port, env: {}, dir });
      await expect(second).rejects.toThrow(`Port ${preview.port} is in use. Try: npm run preview -- --port ${preview.port + 1}`);
      expect(existsSync(join(dir, 'data', 'hub.db'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('stops once, and a second stop does nothing', async () => {
    await expect(preview.stop()).resolves.toBeUndefined();
    await expect(preview.stop()).resolves.toBeUndefined();
  });
});
