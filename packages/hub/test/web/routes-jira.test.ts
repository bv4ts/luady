import { describe, expect, it, vi } from 'vitest';
import { JiraBoardDTOSchema, JiraIssueDetailDTOSchema, JiraSiteDTOSchema, JiraSitesDTOSchema } from '@luady/shared';
import { PinInvalidError } from '../../src/core/errors.js';
import { createJiraService } from '../../src/jira/index.js';
import { TOKEN, createFakeJira } from '../jira/fake-jira.js';
import { call, harnessFactory } from './helpers.js';

const harness = harnessFactory();
const CONNECT = { baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', token: 'test-token-0abcdef', pin: '123456' };

describe('/api/jira connection', () => {
  it('lists sites, connects with the PIN (checked first) and disconnects with it', async () => {
    const h = await harness();
    const session = h.login();
    expect(JiraSitesDTOSchema.parse((await call(h, 'GET', '/api/jira', undefined, { session })).json())).toEqual({ sites: [] });

    const connected = await call(h, 'PUT', '/api/jira/birch/connection', CONNECT, { session });
    expect(connected.statusCode).toBe(200);
    expect(JiraSiteDTOSchema.parse(connected.json()).server).toBe('birch');
    expect(h.deps.pin.verify).toHaveBeenCalledWith('123456', 'web');
    expect(h.deps.jira.connect).toHaveBeenCalledWith('birch', { baseUrl: CONNECT.baseUrl, email: CONNECT.email, token: CONNECT.token });
    expect(connected.body).not.toContain(CONNECT.token);

    expect((await call(h, 'POST', '/api/jira/birch/disconnect', { pin: '123456' }, { session })).json()).toEqual({ ok: true });
    expect(h.deps.jira.disconnect).toHaveBeenCalledWith('birch');
  });

  it('a wrong PIN stops the connect before the service runs', async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.verify).mockRejectedValueOnce(new PinInvalidError(2));
    const res = await call(h, 'PUT', '/api/jira/birch/connection', CONNECT, { session: h.login() });
    expect(res.statusCode).toBe(403);
    expect(h.deps.jira.connect).not.toHaveBeenCalled();
  });

  it('refuses another host, an unknown office, a missing PIN, no CSRF token and no session', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'PUT', '/api/jira/birch/connection', { ...CONNECT, baseUrl: 'https://evil.example.com' }, { session })).statusCode).toBe(400);
    // Jira is per room: a key that is no room id is refused.
    expect((await call(h, 'PUT', '/api/jira/Luady!/connection', CONNECT, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/jira/birch/disconnect', {}, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/jira/birch/connection', CONNECT, { session, csrf: null })).statusCode).toBe(403);
    expect((await call(h, 'GET', '/api/jira')).statusCode).toBe(401);
    expect(h.deps.pin.verify).not.toHaveBeenCalled();
    expect(h.deps.jira.connect).not.toHaveBeenCalled();
  });
});

describe('/api/jira board and tickets', () => {
  it('reads a board view (sprint by default) and a ticket, marking it seen', async () => {
    const h = await harness();
    const session = h.login();
    expect(JiraBoardDTOSchema.parse((await call(h, 'GET', '/api/jira/birch/board', undefined, { session })).json()).view).toBe('sprint');
    expect(h.deps.jira.board).toHaveBeenLastCalledWith('birch', 'sprint', false);
    await call(h, 'GET', '/api/jira/birch/board?view=attention&refresh=1', undefined, { session });
    expect(h.deps.jira.board).toHaveBeenLastCalledWith('birch', 'attention', true);
    expect(JiraIssueDetailDTOSchema.parse((await call(h, 'GET', '/api/jira/birch/issues/ORC-123', undefined, { session })).json()).key).toBe('ORC-123');
    expect(h.deps.jira.issue).toHaveBeenCalledWith('birch', 'ORC-123', { seen: true });
  });

  it('moves, comments, edits and assigns, each answering the fresh ticket', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/jira/birch/issues/ORC-123/transition', { transitionId: '31' }, { session })).statusCode).toBe(200);
    expect(h.deps.jira.transition).toHaveBeenCalledWith('birch', 'ORC-123', '31');
    await call(h, 'POST', '/api/jira/birch/issues/ORC-123/comment', { text: 'On it' }, { session });
    expect(h.deps.jira.comment).toHaveBeenCalledWith('birch', 'ORC-123', 'On it');
    await call(h, 'PUT', '/api/jira/birch/issues/ORC-123', { summary: 'Login fails on Safari' }, { session });
    expect(h.deps.jira.edit).toHaveBeenCalledWith('birch', 'ORC-123', { summary: 'Login fails on Safari' });
    await call(h, 'POST', '/api/jira/birch/issues/ORC-123/assign', { me: true }, { session });
    expect(h.deps.jira.assign).toHaveBeenCalledWith('birch', 'ORC-123', true);
  });

  it('refuses a bad key, an unknown view, an empty comment and no CSRF token', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/jira/birch/issues/orc-123', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/jira/birch/board?view=all', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/jira/birch/issues/ORC-1/comment', { text: '' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/jira/birch/issues/ORC-1/assign', { me: true }, { session, csrf: null })).statusCode).toBe(403);
    expect(h.deps.jira.comment).not.toHaveBeenCalled();
  });

  it('with the real service and a fake Jira: 409 jira_not_connected, a connect that hides the token, a refused sign-in', async () => {
    const probe = await harness();
    const { db, bus, clock, log } = probe.deps;
    const fake = createFakeJira();
    const h = await harness({ jira: createJiraService({ db, bus, clock, log, secret: 'x'.repeat(32), fetch: fake.fetch }) });
    const session = h.login();
    expect((await call(h, 'GET', '/api/jira', undefined, { session })).json()).toEqual({ sites: [] });
    const board = await call(h, 'GET', '/api/jira/birch/board', undefined, { session });
    expect(board.statusCode).toBe(409);
    expect(board.json()).toMatchObject({ error: { code: 'jira_not_connected' } });
    expect((await call(h, 'GET', '/api/jira/birch/issues/ORC-1', undefined, { session })).statusCode).toBe(409);
    expect((await call(h, 'POST', '/api/jira/birch/issues/ORC-1/comment', { text: 'x' }, { session })).statusCode).toBe(409);
    expect(fake.calls).toHaveLength(0);

    const real = { ...CONNECT, token: TOKEN };
    const connected = await call(h, 'PUT', '/api/jira/birch/connection', real, { session });
    expect(connected.statusCode).toBe(200);
    expect(connected.body).not.toContain(TOKEN);
    expect((await call(h, 'GET', '/api/jira', undefined, { session })).body).not.toContain(TOKEN);
    const opened = await call(h, 'GET', '/api/jira/birch/board?view=mine', undefined, { session });
    expect(JiraBoardDTOSchema.parse(opened.json()).issues.map((i) => i.key)).toEqual(['ORC-1', 'ORC-2']);
    expect(JiraIssueDetailDTOSchema.parse((await call(h, 'GET', '/api/jira/birch/issues/ORC-2', undefined, { session })).json()).key).toBe('ORC-2');
    expect((await call(h, 'GET', '/api/jira/birch/issues/ORC-77', undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'POST', '/api/jira/birch/disconnect', { pin: '123456' }, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'GET', '/api/jira/birch/board', undefined, { session })).statusCode).toBe(409);
  });

  it('a refused token answers 409 jira_auth in plain words, without the token', async () => {
    const probe = await harness();
    const { db, bus, clock, log } = probe.deps;
    const fake = createFakeJira({ mode: 'refused' });
    const h = await harness({ jira: createJiraService({ db, bus, clock, log, secret: 'x'.repeat(32), fetch: fake.fetch }) });
    const res = await call(h, 'PUT', '/api/jira/birch/connection', { ...CONNECT, token: TOKEN }, { session: h.login() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'jira_auth', message: 'Jira refused the sign-in. The token may have expired.' } });
    expect(res.body).not.toContain(TOKEN);
  });
});
