import { describe, expect, it } from 'vitest';
import { NoticeListDTOSchema, PresenceDTOSchema } from '@luady/shared';
import { call, harnessFactory, PRESENCE_AWAY, sampleNotice } from './helpers.js';

const harness = harnessFactory();

describe('GET /api/notices', () => {
  it('returns the notice list, 50 by default', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/notices', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(NoticeListDTOSchema.parse(res.json())).toEqual({ items: [sampleNotice()] });
    expect(h.deps.notices.list).toHaveBeenCalledWith(50);
  });

  it('takes a limit from 1 to 200', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/notices?limit=200', undefined, { session })).statusCode).toBe(200);
    expect(h.deps.notices.list).toHaveBeenCalledWith(200);
    expect((await call(h, 'GET', '/api/notices?limit=0', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/notices?limit=201', undefined, { session })).statusCode).toBe(400);
  });

  it('needs an app session', async () => {
    const h = await harness();
    expect((await call(h, 'GET', '/api/notices')).statusCode).toBe(401);
    expect(h.deps.notices.list).not.toHaveBeenCalled();
  });
});

describe('/api/presence', () => {
  it('GET returns where updates go now', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/presence', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(PresenceDTOSchema.parse(res.json())).toEqual(PRESENCE_AWAY);
  });

  it('PUT forces the chat for an hour, or clears it', async () => {
    const h = await harness();
    const session = h.login();
    const forced = await call(h, 'PUT', '/api/presence', { chat: true }, { session });
    expect(forced.statusCode).toBe(200);
    expect(PresenceDTOSchema.parse(forced.json()).forcedUntil).toBe('2026-10-09T13:00:00.000Z');
    const cleared = await call(h, 'PUT', '/api/presence', { chat: false }, { session });
    expect(cleared.json()).toEqual(PRESENCE_AWAY);
    expect(h.deps.presence.force).toHaveBeenNthCalledWith(1, true);
    expect(h.deps.presence.force).toHaveBeenNthCalledWith(2, false);
  });

  it('refuses a missing session (401), a missing CSRF token (403) and a bad body (400)', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/presence')).statusCode).toBe(401);
    expect((await call(h, 'PUT', '/api/presence', { chat: true })).statusCode).toBe(401);
    expect((await call(h, 'PUT', '/api/presence', { chat: true }, { session, csrf: null })).statusCode).toBe(403);
    expect((await call(h, 'PUT', '/api/presence', { chat: 'yes' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/presence', { chat: true, extra: 1 }, { session })).statusCode).toBe(400);
    expect(h.deps.presence.force).not.toHaveBeenCalled();
  });
});
