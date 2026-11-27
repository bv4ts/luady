import { describe, expect, it, vi } from 'vitest';
import { ActivityListDTOSchema, SessionDetailDTOSchema } from '@luady/shared';
import { createActionService } from '../../src/actions/service.js';
import { createBus } from '../../src/core/bus.js';
import { KitTooOldError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createTicketStore } from '../../src/security/tickets.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { call, fakeFleet, fakePin, fakeSessions, fakeChannel, harnessFactory, sampleActivity, sampleDetail, SESSION_ID } from './helpers.js';

const harness = harnessFactory();
const BASE = `/api/sessions/${SESSION_ID}`;

describe('GET /api/activity', () => {
  it("returns the activity service's snapshot", async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/activity', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(ActivityListDTOSchema.parse(res.json())).toEqual({ items: [sampleActivity()] });
  });

  it('needs an app session', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/activity');
    expect(res.statusCode).toBe(401);
    expect(h.deps.activity.snapshot).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id/activity', () => {
  it("returns the session's detail", async () => {
    const h = await harness();
    const res = await call(h, 'GET', `${BASE}/activity`, undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(SessionDetailDTOSchema.parse(res.json())).toEqual(sampleDetail());
    expect(h.deps.activity.detail).toHaveBeenCalledWith(SESSION_ID);
  });

  it('answers 404 for an unknown session', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/sessions/cedar:cc-nope:0.0/activity', undefined, { session: h.login() });
    expect(res.statusCode).toBe(404);
    expect(h.deps.activity.detail).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/pause and /resume', () => {
  it.each([['pause', 'session.pause'], ['resume', 'session.resume']])('%s is an owner web action without a PIN', async (path, kind) => {
    const h = await harness();
    const res = await call(h, 'POST', `${BASE}/${path}`, {}, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind, status: 'done' });
    expect(h.deps.actions.request).toHaveBeenCalledWith({ kind, actor: 'owner', channel: 'web', params: { sessionId: SESSION_ID } });
  });

  it('needs the CSRF header', async () => {
    const h = await harness();
    const res = await call(h, 'POST', `${BASE}/pause`, {}, { session: h.login(), csrf: null });
    expect(res.statusCode).toBe(403);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });

  it('refuses a body, and an unknown session, before any action is created', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', `${BASE}/pause`, { pin: '123456' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/sessions/cedar:cc-nope:0.0/resume', {}, { session })).statusCode).toBe(404);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });

  it('a kit-1 server answers 409 kit_too_old', async () => {
    const h = await harness();
    const message = "cedar's kit is older than 2.0.0 and cannot pause. Update the kit on cedar first.";
    vi.mocked(h.deps.actions.request).mockRejectedValueOnce(new KitTooOldError(message));
    const res = await call(h, 'POST', `${BASE}/pause`, {}, { session: h.login() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'kit_too_old', message } });
  });
});

describe('POST /api/sessions/:id/resume says what happened', () => {
  it.for([
    [{ wasHit: true, sent: true }, 'resumed'],
    [{ wasHit: false, sent: false }, 'pause lifted; the agent was still working'],
    [{ wasHit: true, sent: false }, 'pause lifted; the agent was idle'],
  ] as const)('kit %j → %s', async ([kit, text]) => {
    const db = openMemoryDb();
    const bus = createBus();
    const clock = createFakeClock();
    const actions = createActionService({
      db, bus, clock, log: silentLogger(), fleet: fakeFleet(), sessions: fakeSessions(), pin: fakePin(), channel: fakeChannel(),
      tickets: createTicketStore(clock), pauses: { pause: vi.fn(), resume: vi.fn(async () => ({ ...kit })) },
    });
    const h = await harness({ db, bus, clock, actions });
    const res = await call(h, 'POST', `${BASE}/resume`, {}, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'session.resume', status: 'done', result: text, resume: kit });
  });
});
