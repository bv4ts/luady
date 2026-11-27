import { DEFAULT_SETTINGS } from '@luady/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type LuadyApi } from '../../src/api/client.js';
import { ApiError } from '../../src/api/errors.js';
import type { FetchLike } from '../../src/api/http.js';
import {
  CREATION_OPTIONS, NOW, REQUEST_OPTIONS, accounts, action, activityItem, chat, detail, fileRead, item, luadyStatus, me, notice,
  overview, passkey, presence, project, question, server, session,
} from '../fixtures.js';
import { STEP_C_CASES } from './step-c-cases.js';
import { WAVE2_CASES } from './wave2-cases.js';
import { ROOM_CASES } from './rooms-cases.js';
import { hostDto } from '../room-fixtures.js';

interface Recorded { url: string; method: string; body: unknown; csrf: string | undefined }

function client(...bodies: unknown[]) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url, method: String(init.method), csrf: headers['X-Hub-CSRF'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(bodies.shift() ?? null), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { api: createApiClient({ fetch }), calls, fetch };
}

const SID = 'cedar:cc-meadow-hr:0.0';
const ESID = encodeURIComponent(SID);
const PIN = '123456';
const NOW_PLUS_HOUR = '2026-10-09T13:00:00.000Z';
const FILE_ID = '00000000-0000-4000-8000-000000000001';

interface RouteCase { name: string; call: (api: LuadyApi) => Promise<unknown>; method: string; url: string; body?: unknown; response: unknown }

const cases: RouteCase[] = [
  { name: 'me', call: (a) => a.me(), method: 'GET', url: '/api/me', response: me() },
  { name: 'passkeyRegisterOptions', call: (a) => a.passkeyRegisterOptions({ setupCode: 'SETUP-CODE-1' }), method: 'POST', url: '/api/auth/passkey/register/options', body: { setupCode: 'SETUP-CODE-1' }, response: CREATION_OPTIONS },
  { name: 'passkeyRegisterVerify', call: (a) => a.passkeyRegisterVerify({ response: { id: 'cred-1' }, label: 'iPhone' }), method: 'POST', url: '/api/auth/passkey/register/verify', body: { response: { id: 'cred-1' }, label: 'iPhone' }, response: { ok: true } },
  { name: 'passkeyLoginOptions', call: (a) => a.passkeyLoginOptions(), method: 'POST', url: '/api/auth/passkey/login/options', body: {}, response: REQUEST_OPTIONS },
  { name: 'passkeyLoginVerify', call: (a) => a.passkeyLoginVerify({ response: { id: 'cred-1' } }), method: 'POST', url: '/api/auth/passkey/login/verify', body: { response: { id: 'cred-1' } }, response: { ok: true, csrf: 'csrf-2' } },
  { name: 'logout', call: (a) => a.logout(), method: 'POST', url: '/api/auth/logout', body: {}, response: { ok: true } },
  { name: 'setPin', call: (a) => a.setPin({ newPin: '654321', currentPin: PIN }), method: 'POST', url: '/api/auth/pin', body: { newPin: '654321', currentPin: PIN }, response: { ok: true } },
  { name: 'passkeys', call: (a) => a.passkeys(), method: 'GET', url: '/api/auth/passkeys', response: { items: [passkey(), passkey({ id: 'cred-2', lastUsedAt: null })] } },
  { name: 'deletePasskey', call: (a) => a.deletePasskey('cred/1+x', { pin: PIN }), method: 'POST', url: '/api/auth/passkeys/cred%2F1%2Bx/delete', body: { pin: PIN }, response: { ok: true } },
  { name: 'overview', call: (a) => a.overview(), method: 'GET', url: '/api/overview', response: overview() },
  { name: 'sessions', call: (a) => a.sessions(), method: 'GET', url: '/api/sessions', response: [session()] },
  { name: 'transcript', call: (a) => a.transcript(SID, null), method: 'GET', url: `/api/sessions/${ESID}/transcript?limit=50`, response: { items: [item()], nextCursor: 'c1' } },
  { name: 'transcript (cursor)', call: (a) => a.transcript(SID, 'c1', 20), method: 'GET', url: `/api/sessions/${ESID}/transcript?cursor=c1&limit=20`, response: { items: [], nextCursor: null } },
  { name: 'createSession', call: (a) => a.createSession({ server: 'cedar', cwd: '/home/dev/projects/meadow-hr', name: 'hr-fix', prompt: 'Fix login' }), method: 'POST', url: '/api/sessions', body: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', name: 'hr-fix', prompt: 'Fix login' }, response: action({ kind: 'session.start', tier: 0, status: 'done' }) },
  { name: 'sendToSession', call: (a) => a.sendToSession(SID, { text: 'run the tests' }), method: 'POST', url: `/api/sessions/${ESID}/send`, body: { text: 'run the tests' }, response: action() },
  { name: 'interruptSession', call: (a) => a.interruptSession(SID), method: 'POST', url: `/api/sessions/${ESID}/interrupt`, body: {}, response: action() },
  { name: 'stopSession', call: (a) => a.stopSession(SID, { pin: PIN, force: false }), method: 'POST', url: `/api/sessions/${ESID}/stop`, body: { pin: PIN, force: false }, response: action() },
  { name: 'restartSession', call: (a) => a.restartSession(SID, { pin: PIN }), method: 'POST', url: `/api/sessions/${ESID}/restart`, body: { pin: PIN }, response: action() },
  { name: 'deleteSession', call: (a) => a.deleteSession(SID, { pin: PIN }), method: 'POST', url: `/api/sessions/${ESID}/delete`, body: { pin: PIN }, response: action() },
  { name: 'questions', call: (a) => a.questions(), method: 'GET', url: '/api/questions?state=pending', response: [question()] },
  { name: 'answerQuestion', call: (a) => a.answerQuestion('ABCDEFGH', { answers: { 'Which database?': 'Postgres' } }), method: 'POST', url: '/api/questions/ABCDEFGH/answer', body: { answers: { 'Which database?': 'Postgres' } }, response: question({ state: 'answered' }) },
  { name: 'answerQuestion (permission)', call: (a) => a.answerQuestion('Q2W3E4R5', { behavior: 'deny', message: 'not now' }), method: 'POST', url: '/api/questions/Q2W3E4R5/answer', body: { behavior: 'deny', message: 'not now' }, response: question({ qid: 'Q2W3E4R5', state: 'answered' }) },
  { name: 'releaseQuestion', call: (a) => a.releaseQuestion('ABCDEFGH'), method: 'POST', url: '/api/questions/ABCDEFGH/release', body: {}, response: question({ state: 'released' }) },
  { name: 'actions', call: (a) => a.actions({ status: 'failed', limit: 20 }), method: 'GET', url: '/api/actions?status=failed&limit=20', response: [action({ status: 'failed' })] },
  { name: 'actions (default)', call: (a) => a.actions(), method: 'GET', url: '/api/actions?limit=100', response: [] },
  { name: 'confirmAction', call: (a) => a.confirmAction('A7', { pin: PIN }), method: 'POST', url: '/api/actions/A7/confirm', body: { pin: PIN }, response: action({ status: 'done' }) },
  { name: 'denyAction', call: (a) => a.denyAction('A7'), method: 'POST', url: '/api/actions/A7/deny', body: {}, response: action({ status: 'denied' }) },
  { name: 'actionText', call: (a) => a.actionText('A7'), method: 'GET', url: '/api/actions/A7/text', response: { text: 'the whole message' } },
  { name: 'luadyMessages', call: (a) => a.luadyMessages(null), method: 'GET', url: '/api/manager/messages?limit=50', response: { items: [chat()], nextCursor: null } },
  { name: 'sendToLuady', call: (a) => a.sendToLuady({ text: 'hi' }), method: 'POST', url: '/api/manager/messages', body: { text: 'hi' }, response: { ok: true } },
  { name: 'luadyStatus', call: (a) => a.luadyStatus(), method: 'GET', url: '/api/manager/status', response: luadyStatus() },
  { name: 'memoryFiles', call: (a) => a.memoryFiles(), method: 'GET', url: '/api/manager/memory', response: { files: [{ name: 'USER.md', size: 120 }] } },
  { name: 'memoryFile', call: (a) => a.memoryFile('journal/2026-10-08.md'), method: 'GET', url: '/api/manager/memory/file?name=journal%2F2026-10-08.md', response: { name: 'journal/2026-10-08.md', content: '# Day' } },
  { name: 'servers', call: (a) => a.servers(), method: 'GET', url: '/api/servers', response: [server()] },
  { name: 'projects', call: (a) => a.projects('birch'), method: 'GET', url: '/api/servers/birch/projects', response: [project({ server: 'birch' })] },
  { name: 'exec', call: (a) => a.exec('cedar', { command: 'df -h' }), method: 'POST', url: '/api/servers/cedar/exec', body: { command: 'df -h' }, response: action({ kind: 'server.exec', tier: 0, status: 'done' }) },
  { name: 'readFile', call: (a) => a.readFile('cedar', '/home/dev/.claude/settings.json'), method: 'GET', url: '/api/servers/cedar/file?path=%2Fhome%2Fdev%2F.claude%2Fsettings.json', response: fileRead() },
  { name: 'writeFile', call: (a) => a.writeFile('cedar', { path: '/home/dev/.claude/CLAUDE.md', content: '# Rules', pin: PIN }), method: 'PUT', url: '/api/servers/cedar/file', body: { path: '/home/dev/.claude/CLAUDE.md', content: '# Rules', pin: PIN }, response: action() },
  { name: 'updateClaude', call: (a) => a.updateClaude('ash', { pin: PIN }), method: 'POST', url: '/api/servers/ash/update-claude', body: { pin: PIN }, response: action() },
  { name: 'settings', call: (a) => a.settings(), method: 'GET', url: '/api/settings', response: DEFAULT_SETTINGS },
  { name: 'updateSettings', call: (a) => a.updateSettings({ away: true }), method: 'PUT', url: '/api/settings', body: { away: true }, response: { ...DEFAULT_SETTINGS, away: true } },
  { name: 'openTerminal', call: (a) => a.openTerminal({ server: 'cedar', target: 'cc-meadow-hr:0.0', pin: PIN }), method: 'POST', url: '/api/terminal/open', body: { server: 'cedar', target: 'cc-meadow-hr:0.0', pin: PIN }, response: { ticket: 'f'.repeat(64) } },
  { name: 'activity', call: (a) => a.activity(), method: 'GET', url: '/api/activity', response: { items: [activityItem()] } },
  { name: 'sessionActivity', call: (a) => a.sessionActivity(SID), method: 'GET', url: `/api/sessions/${ESID}/activity`, response: detail() },
  { name: 'pauseSession', call: (a) => a.pauseSession(SID), method: 'POST', url: `/api/sessions/${ESID}/pause`, body: {}, response: action({ kind: 'session.pause', tier: 0, status: 'done', result: 'paused' }) },
  { name: 'resumeSession', call: (a) => a.resumeSession(SID), method: 'POST', url: `/api/sessions/${ESID}/resume`, body: {}, response: action({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed' }) },
  { name: 'resumeSession with what the resume did', call: (a) => a.resumeSession(SID), method: 'POST', url: `/api/sessions/${ESID}/resume`, body: {}, response: { ...action({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed' }), resume: { wasHit: true, sent: true } } },
  { name: 'notices', call: (a) => a.notices(), method: 'GET', url: '/api/notices?limit=100', response: { items: [notice()] } },
  { name: 'notices (limit)', call: (a) => a.notices(20), method: 'GET', url: '/api/notices?limit=20', response: { items: [] } },
  { name: 'presence', call: (a) => a.presence(), method: 'GET', url: '/api/presence', response: presence() },
  { name: 'setPresence', call: (a) => a.setPresence({ chat: true }), method: 'PUT', url: '/api/presence', body: { chat: true }, response: presence({ mode: 'chat', forcedUntil: NOW_PLUS_HOUR }) },
  { name: 'accounts', call: (a) => a.accounts(), method: 'GET', url: '/api/accounts', response: accounts() },
  { name: 'refreshAccount', call: (a) => a.refreshAccount('cedar'), method: 'POST', url: '/api/accounts/cedar/refresh', body: {}, response: accounts() },
  { name: 'loginAccount', call: (a) => a.loginAccount('birch'), method: 'POST', url: '/api/accounts/birch/login', body: {}, response: { host: 'birch', url: 'https://claude.ai/oauth/authorize?x=1', expiresAt: NOW } },
  { name: 'loginAccount with a PIN', call: (a) => a.loginAccount('birch', { pin: '246813' }), method: 'POST', url: '/api/accounts/birch/login', body: { pin: '246813' }, response: { host: 'birch', url: 'https://claude.ai/oauth/authorize?x=1', expiresAt: NOW } },
  { name: 'submitLoginCode', call: (a) => a.submitLoginCode('birch', { code: 'abcd-1234#efgh' }), method: 'POST', url: '/api/accounts/birch/code', body: { code: 'abcd-1234#efgh' }, response: { host: 'birch', ok: true, message: 'Signed in', loggedIn: true, expiresAt: NOW, brainRestarted: false } },
  { name: 'logoutAccount', call: (a) => a.logoutAccount('hq', { pin: PIN }), method: 'POST', url: '/api/accounts/hq/logout', body: { pin: PIN }, response: action({ kind: 'account.logout', status: 'done' }) },
  { name: 'logoutAccount (codex)', call: (a) => a.logoutAccount('codex', { pin: PIN }), method: 'POST', url: '/api/accounts/codex/logout', body: { pin: PIN }, response: action({ kind: 'account.logout', status: 'done' }) },
  { name: 'codexLogin', call: (a) => a.codexLogin(), method: 'POST', url: '/api/accounts/codex/login', body: {}, response: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', expiresAt: NOW } },
  ...STEP_C_CASES,
  ...WAVE2_CASES,
  ...ROOM_CASES,
  // The hosts routes live on the main client too (`api.hosts`; the grant header is in http.test.ts).
  { name: 'hosts list', call: (a) => a.hosts.list(), method: 'GET', url: '/api/hosts', response: [hostDto()] },
  { name: 'hosts key', call: (a) => a.hosts.key(), method: 'GET', url: '/api/hosts/key', response: { publicKey: 'ssh-ed25519 AAAA', line: 'ssh-ed25519 AAAA luady-fleet' } },
  { name: 'hosts grant', call: (a) => a.hosts.grant('mars', PIN), method: 'POST', url: '/api/hosts/mars/grant', body: { pin: PIN }, response: { grant: 'g', expiresAt: NOW } },
  { name: 'hosts scan', call: (a) => a.hosts.scan('mars', 'g'), method: 'POST', url: '/api/hosts/mars/scan', body: {}, response: { fingerprint: 'SHA256:x', keyType: 'ssh-ed25519', compare: 'ssh-keygen -lf x' } },
  { name: 'hosts kit', call: (a) => a.hosts.kit('mars', 'install', 'g'), method: 'POST', url: '/api/hosts/mars/kit', body: { mode: 'install' }, response: { job: 'j1', state: 'running', summary: null, error: null } },
  { name: 'hosts update', call: (a) => a.hosts.update('mars', { pin: PIN, port: 2222 }), method: 'PUT', url: '/api/hosts/mars', body: { pin: PIN, port: 2222 }, response: hostDto({ port: 2222 }) },
  // The channels routes as well (`api.channels`; the download's page key is in channels.test.ts).
  { name: 'channels list', call: (a) => a.channels.list(), method: 'GET', url: '/api/channels', response: [] },
  { name: 'channels action', call: (a) => a.channels.action('test-channel', { action: 'ping' }), method: 'POST', url: '/api/channels/test-channel/action', body: { action: 'ping' }, response: { ok: true } },
  { name: 'channels connect', call: (a) => a.channels.connect('google', { pin: PIN, label: 'work' }), method: 'POST', url: '/api/connect/google', body: { pin: PIN, label: 'work' }, response: { url: 'https://accounts.example.com/x' } },
  { name: 'channels download', call: (a) => a.channels.download({ id: FILE_ID, name: 'a.pdf', mime: 'application/pdf', size: 4 }), method: 'GET', url: `/api/files/${FILE_ID}`, response: null },
];

describe('createApiClient', () => {
  it('covers every route function', () => {
    const tested = new Set(cases.map((c) => c.name.split(' ')[0]));
    const routes = Object.keys(createApiClient()).filter((key) => key !== 'csrf');
    expect(routes.filter((route) => !tested.has(route))).toEqual([]);
  });

  it.each(cases)('$name → $method $url', async ({ call, method, url, body, response }) => {
    const { api, calls } = client(response);
    await call(api);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method, url });
    expect(calls[0]?.body).toEqual(body);
  });

  it('me() stores the CSRF token that later writes send', async () => {
    const { api, calls } = client(me({ csrf: 'csrf-me' }), { ok: true });
    await api.me();
    await api.sendToLuady({ text: 'hello' });
    expect(calls[1]?.csrf).toBe('csrf-me');
    expect(api.csrf()).toBe('csrf-me');
  });

  it('login replaces the CSRF token and logout clears it', async () => {
    const { api, calls } = client({ ok: true, csrf: 'csrf-login' }, { ok: true }, { ok: true });
    await api.passkeyLoginVerify({ response: { id: 'cred-1' } });
    await api.logout();
    await api.sendToLuady({ text: 'after logout' });
    expect(calls[1]?.csrf).toBe('csrf-login');
    expect(calls[2]?.csrf).toBeUndefined();
  });

  it('rejects invalid request bodies before calling the hub', async () => {
    const { api, fetch } = client();
    // The projects folder is the hub's to check (each host has its own); an empty folder never leaves the page.
    await expect(api.createSession({ server: 'cedar', cwd: '' })).rejects.toMatchObject({ code: 'invalid_request', status: 0 });
    await expect(api.stopSession(SID, { pin: '12' })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates responses with the shared schemas', async () => {
    const { api } = client([{ ...session(), state: 'sleeping' }]);
    await expect(api.sessions()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses a sign-in code that is too short without calling the hub, and never echoes it', async () => {
    const { api, fetch } = client();
    const attempt = api.submitLoginCode('cedar', { code: 'abc1234' });
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' });
    await attempt.catch((err: unknown) => expect(String((err as Error).message)).not.toContain('abc1234'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates the presence body and the live-activity responses', async () => {
    const { api, fetch } = client({ items: [{ sessionId: 'x', tool: 'typing', paused: false, helpers: 0, contextPct: null, lastStepAt: null }] });
    await expect(api.setPresence({ chat: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.activity()).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('optional live-activity answer fields, read defensively', () => {
  const answer = (body: unknown) => createApiClient({ fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });

  it('a resume answer without the field (an older hub) or with a malformed one still parses, without it', async () => {
    const plain = action({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed' });
    expect((await answer(plain).resumeSession(SID)).resume).toBeUndefined();
    expect((await answer({ ...plain, resume: { wasHit: 'yes' } }).resumeSession(SID)).resume).toBeUndefined();
    expect((await answer({ ...plain, resume: { wasHit: false, sent: false } }).resumeSession(SID)).resume).toEqual({ wasHit: false, sent: false });
  });

  it('a chat send answer says held only when the hub says held: true', async () => {
    expect((await answer({ ok: true }).sendToLuady({ text: 'hi' })).held).toBe(false);
    expect((await answer({ ok: true, held: true }).sendToLuady({ text: 'hi' })).held).toBe(true);
    expect((await answer({ ok: true, held: 'yes' }).sendToLuady({ text: 'hi' })).held).toBe(false);
  });
});
