import { describe, expect, it, vi } from 'vitest';
import { OverviewDTOSchema } from '@luady/shared';
import { CtlError, KitTooOldError, PinInvalidError, PinLockedError, SessionPausedError } from '../../src/core/errors.js';
import { definedOnly } from '../../src/web/owner-action.js';
import {
  call,
  harnessFactory,
  LUADY_STATUS,
  PENDING_ACTION,
  sampleItem,
  sampleQuestion,
  sampleServer,
  sampleSession,
  SESSION_ID,
  SYSTEM_SESSION,
} from './helpers.js';

const harness = harnessFactory();
const PIN = '123456';
const BASE = `/api/sessions/${SESSION_ID}`;
const owner = { actor: 'owner', channel: 'web' } as const;

describe('GET /api/overview', () => {
  it('aggregates servers, non-system sessions, pending questions and actions, Luady and the chat status', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/overview', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(OverviewDTOSchema.parse(res.json())).toEqual({
      servers: [sampleServer()],
      sessions: [sampleSession()],
      questions: [sampleQuestion()],
      actions: [PENDING_ACTION],
      manager: LUADY_STATUS,
      selfHost: 'hq',
      rooms: [],
      channels: [],
    });
  });
});

describe('session reads', () => {
  it('lists sessions', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/sessions', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([sampleSession(), SYSTEM_SESSION]);
  });

  it('pages the transcript: an empty cursor is null and the limit defaults to 50', async () => {
    const h = await harness();
    const session = h.login();
    const first = await call(h, 'GET', `${BASE}/transcript?cursor=&limit=20`, undefined, { session });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ items: [sampleItem('u1')], nextCursor: null });
    expect(h.deps.sessions.transcript).toHaveBeenLastCalledWith(SESSION_ID, null, 20);
    await call(h, 'GET', `${BASE}/transcript?cursor=older-1`, undefined, { session });
    expect(h.deps.sessions.transcript).toHaveBeenLastCalledWith(SESSION_ID, 'older-1', 50);
  });

  it('rejects a transcript limit above 200 with 400', async () => {
    const h = await harness();
    const res = await call(h, 'GET', `${BASE}/transcript?limit=500`, undefined, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
    expect(h.deps.sessions.transcript).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown session', async () => {
    const h = await harness();
    const session = h.login();
    const res = await call(h, 'POST', '/api/sessions/cedar:cc-nope:0.0/send', { text: 'hi' }, { session });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Unknown session: cedar:cc-nope:0.0' } });
    const transcript = await call(h, 'GET', '/api/sessions/cedar:cc-nope:0.0/transcript', undefined, { session });
    expect(transcript.statusCode).toBe(404);
  });
});

describe('session actions', () => {
  it('starts a session as an owner web action without undefined params', async () => {
    const h = await harness();
    const res = await call(
      h,
      'POST',
      '/api/sessions',
      { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: 'run the tests' },
      { session: h.login() },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'session.start', status: 'done' });
    expect(h.deps.actions.request).toHaveBeenCalledWith({
      kind: 'session.start',
      ...owner,
      params: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: 'run the tests' },
    });
    const params = vi.mocked(h.deps.actions.request).mock.calls[0]?.[0].params ?? {};
    expect(Object.keys(params)).toEqual(['server', 'cwd', 'prompt']);
    expect(Object.keys(definedOnly({ a: 1, b: undefined }))).toEqual(['a']);
  });

  it('rejects a start outside /home/dev/projects with 400', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/sessions', { server: 'cedar', cwd: '/etc' }, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });

  it('send and interrupt are tier-0 actions without a PIN', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', `${BASE}/send`, { text: 'continue please' }, { session })).statusCode).toBe(200);
    expect(h.deps.actions.request).toHaveBeenLastCalledWith({
      kind: 'session.send',
      ...owner,
      params: { sessionId: SESSION_ID, text: 'continue please' },
    });
    expect((await call(h, 'POST', `${BASE}/interrupt`, {}, { session })).statusCode).toBe(200);
    expect(h.deps.actions.request).toHaveBeenLastCalledWith({
      kind: 'session.interrupt',
      ...owner,
      params: { sessionId: SESSION_ID },
    });
  });

  it('stop, restart and delete pass the PIN from the body', async () => {
    const h = await harness();
    const session = h.login();
    await call(h, 'POST', `${BASE}/stop`, { pin: PIN }, { session });
    expect(h.deps.actions.request).toHaveBeenLastCalledWith({
      kind: 'session.stop',
      ...owner,
      params: { sessionId: SESSION_ID, force: false },
      pin: PIN,
    });
    await call(h, 'POST', `${BASE}/stop`, { pin: PIN, force: true }, { session });
    expect(h.deps.actions.request).toHaveBeenLastCalledWith({
      kind: 'session.stop',
      ...owner,
      params: { sessionId: SESSION_ID, force: true },
      pin: PIN,
    });
    await call(h, 'POST', `${BASE}/restart`, { pin: PIN }, { session });
    expect(h.deps.actions.request).toHaveBeenLastCalledWith({
      kind: 'session.restart',
      ...owner,
      params: { sessionId: SESSION_ID },
      pin: PIN,
    });
    await call(h, 'POST', `${BASE}/delete`, { pin: PIN }, { session });
    expect(h.deps.actions.request).toHaveBeenLastCalledWith({
      kind: 'session.delete',
      ...owner,
      params: { sessionId: SESSION_ID },
      pin: PIN,
    });
  });

  it('a tier-1 session route without a PIN is 400 and creates no action', async () => {
    const h = await harness();
    const session = h.login();
    for (const path of ['stop', 'restart', 'delete']) {
      const res = await call(h, 'POST', `${BASE}/${path}`, {}, { session });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation' } });
    }
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });

  it('maps PIN and fleet errors from the action service to 403, 423 and 502', async () => {
    const h = await harness();
    const session = h.login();
    const request = vi.mocked(h.deps.actions.request);
    request.mockRejectedValueOnce(new PinInvalidError(1));
    const wrong = await call(h, 'POST', `${BASE}/stop`, { pin: '000000' }, { session });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 1 } });
    request.mockRejectedValueOnce(new PinLockedError('2026-10-09T12:15:00.000Z'));
    const locked = await call(h, 'POST', `${BASE}/restart`, { pin: PIN }, { session });
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toEqual({
      error: { code: 'pin_locked', message: 'PIN locked until 2026-10-09T12:15:00.000Z', until: '2026-10-09T12:15:00.000Z' },
    });
    request.mockRejectedValueOnce(new CtlError('failed', 'tmux is not running', 1));
    const ctl = await call(h, 'POST', `${BASE}/delete`, { pin: PIN }, { session });
    expect(ctl.statusCode).toBe(502);
    expect(ctl.json()).toEqual({ error: { code: 'failed', message: 'tmux is not running' } });
  });

  it('a paused session refuses send with 409 session_paused', async () => {
    const h = await harness();
    vi.mocked(h.deps.actions.request).mockRejectedValueOnce(new SessionPausedError('cedar · meadow-hr is paused. Resume it first.'));
    const res = await call(h, 'POST', `${BASE}/send`, { text: 'continue' }, { session: h.login() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'session_paused', message: 'cedar · meadow-hr is paused. Resume it first.' } });
  });

  it('a mutating session route without CSRF is 403', async () => {
    const h = await harness();
    const res = await call(h, 'POST', `${BASE}/send`, { text: 'hi' }, { session: h.login(), csrf: null });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'forbidden', message: 'CSRF token missing or invalid' } });
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });
});
