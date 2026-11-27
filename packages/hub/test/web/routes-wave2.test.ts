import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WEB_PREFS, FleetHistoryDTOSchema, LinkDTOSchema, LinkListDTOSchema, RecapDTOSchema, ScheduleItemDTOSchema, ScheduleListDTOSchema,
  TimelineDTOSchema, WebPrefsDTOSchema, WinsDTOSchema, type WsServerMessage,
} from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { ValidationError } from '../../src/core/errors.js';
import { createFleetHistoryService } from '../../src/fleet-history/index.js';
import { createLinksService } from '../../src/links/index.js';
import { createPrefsService } from '../../src/prefs/index.js';
import { createRecapService } from '../../src/recap/index.js';
import { createTimelineService } from '../../src/timeline/index.js';
import { createWinsService } from '../../src/wins/index.js';
import { fanOut } from '../../src/web/ws.js';
import { ISO, call, harnessFactory, sampleLink, type Harness } from './helpers.js';

const harness = harnessFactory();
const SINCE = '2026-10-09T08:00:00+04:00';

/** The real services behind the routes, built from the harness deps. */
async function real(): Promise<Harness> {
  const probe = await harness();
  const { db, bus, clock, log, questions, fleet, accounts, sessions } = probe.deps;
  return harness({
    recap: createRecapService({ db, clock, log, questions }),
    fleetHistory: createFleetHistoryService({ bus, clock, log, fleet, accounts }),
    wins: createWinsService({ db, clock, log }),
    timeline: createTimelineService({ db, clock, log, sessions }),
    links: createLinksService({ db, bus, clock, log }),
    prefs: createPrefsService({ db, bus, clock, log }),
    bus,
  });
}

describe('recap, fleet history, wins and timeline', () => {
  it('recap needs a readable since and passes it on as a time', async () => {
    const h = await harness();
    const session = h.login();
    const res = await call(h, 'GET', `/api/recap?since=${encodeURIComponent(SINCE)}`, undefined, { session });
    expect(RecapDTOSchema.parse(res.json()).since).toBe('2026-10-09T04:00:00.000Z');
    expect(h.deps.recap.recap).toHaveBeenCalledWith(new Date(SINCE));
    expect((await call(h, 'GET', '/api/recap', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/recap?since=yesterday', undefined, { session })).statusCode).toBe(400);
  });

  it('fleet history, wins (7 days by default, 1 to 30) and the timeline (today in owner time by default)', async () => {
    const h = await harness();
    const session = h.login();
    expect(FleetHistoryDTOSchema.parse((await call(h, 'GET', '/api/fleet/history', undefined, { session })).json()).servers).toHaveLength(1);
    expect(WinsDTOSchema.parse((await call(h, 'GET', '/api/wins', undefined, { session })).json())).toEqual({ items: [], byServer: {} });
    expect(h.deps.wins.wins).toHaveBeenLastCalledWith(7);
    await call(h, 'GET', '/api/wins?days=30', undefined, { session });
    expect(h.deps.wins.wins).toHaveBeenLastCalledWith(30);
    expect((await call(h, 'GET', '/api/wins?days=31', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/wins?days=0', undefined, { session })).statusCode).toBe(400);
    // The harness clock stands at 2026-10-09T12:00Z, which is 4 PM in the fixed zone the tests run in.
    expect(TimelineDTOSchema.parse((await call(h, 'GET', '/api/timeline', undefined, { session })).json()).day).toBe('2026-10-09');
    await call(h, 'GET', '/api/timeline?day=2026-10-08', undefined, { session });
    expect(h.deps.timeline.day).toHaveBeenLastCalledWith('2026-10-08');
    expect((await call(h, 'GET', '/api/timeline?day=08-10-2026', undefined, { session })).statusCode).toBe(400);
  });

  it('recap, fleet history, wins, timeline, schedules, links and prefs all need the owner session', async () => {
    const h = await harness();
    for (const url of ['/api/recap?since=2026-10-09T00:00:00Z', '/api/fleet/history', '/api/wins', '/api/timeline', '/api/schedules', '/api/links', '/api/prefs']) {
      expect((await call(h, 'GET', url)).statusCode, url).toBe(401);
    }
  });
});

describe('/api/schedules (on the scheduler)', () => {
  it('lists, adds and cancels', async () => {
    const h = await harness();
    const session = h.login();
    expect(ScheduleListDTOSchema.parse((await call(h, 'GET', '/api/schedules', undefined, { session })).json()).items).toHaveLength(1);
    const added = await call(h, 'POST', '/api/schedules', { when: ' 0 9 * * 1-5 ', task: 'Morning check' }, { session });
    expect(ScheduleItemDTOSchema.parse(added.json())).toMatchObject({ id: 'S2', when: '0 9 * * 1-5' });
    expect(h.deps.scheduler.add).toHaveBeenCalledWith('0 9 * * 1-5', 'Morning check');
    expect((await call(h, 'POST', '/api/schedules/S1/cancel', {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'POST', '/api/schedules/S9/cancel', {}, { session })).statusCode).toBe(404);
  });

  it('a when the scheduler cannot read is a 400; bad bodies and a missing CSRF token are refused', async () => {
    const h = await harness();
    const session = h.login();
    vi.mocked(h.deps.scheduler.add).mockImplementationOnce(() => { throw new ValidationError('That time is already in the past'); });
    expect((await call(h, 'POST', '/api/schedules', { when: '2020-01-01T09:00:00+04:00', task: 'Too late' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/schedules', { when: '9am', task: 'Morning check' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/schedules', { when: '0 9 * * *', task: 'go', id: 'S1' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/schedules', { when: '0 9 * * *', task: 'Morning check' }, { session, csrf: null })).statusCode).toBe(403);
    expect((await call(h, 'POST', '/api/schedules/S1/cancel', { now: true }, { session })).statusCode).toBe(400);
  });
});

describe('/api/links and /api/prefs', () => {
  it('lists, adds, changes and removes links', async () => {
    const h = await harness();
    const session = h.login();
    expect(LinkListDTOSchema.parse((await call(h, 'GET', '/api/links', undefined, { session })).json())).toEqual({ items: [sampleLink()] });
    const body = { server: 'cedar', label: 'GitHub', url: 'https://github.com/meadow' };
    expect(LinkDTOSchema.parse((await call(h, 'POST', '/api/links', body, { session })).json()).id).toBe(1);
    expect(h.deps.links.create).toHaveBeenCalledWith(body);
    await call(h, 'PUT', '/api/links/1', { position: 2 }, { session });
    expect(h.deps.links.update).toHaveBeenCalledWith(1, { position: 2 });
    expect((await call(h, 'POST', '/api/links/1/delete', {}, { session })).json()).toEqual({ ok: true });
    expect(h.deps.links.remove).toHaveBeenCalledWith(1);
  });

  it('refuses http and javascript links, a long label, a bad id and a missing CSRF token', async () => {
    const h = await harness();
    const session = h.login();
    for (const url of ['http://github.com', 'javascript:alert(1)']) {
      expect((await call(h, 'POST', '/api/links', { server: 'birch', label: 'x', url }, { session })).statusCode, url).toBe(400);
    }
    expect((await call(h, 'POST', '/api/links', { server: 'birch', label: 'x'.repeat(41), url: 'https://x.example' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/links/abc', { position: 1 }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/links', { server: 'birch', label: 'x', url: 'https://x.example' }, { session, csrf: null })).statusCode).toBe(403);
    expect(h.deps.links.create).not.toHaveBeenCalled();
  });

  it('reads and changes the preferences', async () => {
    const h = await harness();
    const session = h.login();
    expect(WebPrefsDTOSchema.parse((await call(h, 'GET', '/api/prefs', undefined, { session })).json())).toEqual(DEFAULT_WEB_PREFS);
    expect((await call(h, 'PUT', '/api/prefs', { dayNight: false }, { session })).json()).toEqual({ ...DEFAULT_WEB_PREFS, dayNight: false });
    expect(h.deps.prefs.update).toHaveBeenCalledWith({ dayNight: false });
    expect((await call(h, 'PUT', '/api/prefs', { sound: { volume: 2 } }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/prefs', { theme: 'dark' }, { session })).statusCode).toBe(400);
  });
});

describe('with the real services', () => {
  it('reads answer from the hub\'s own data, links and prefs change and say so', async () => {
    const h = await real();
    const session = h.login();
    const changed: string[] = [];
    h.deps.bus.on('links.changed', () => changed.push('links'));
    h.deps.bus.on('prefs.changed', () => changed.push('prefs'));
    const recap = RecapDTOSchema.parse((await call(h, 'GET', `/api/recap?since=${encodeURIComponent(SINCE)}`, undefined, { session })).json());
    expect(recap).toMatchObject({ finished: [], failed: [], meetings: [], cards: { added: 0, done: 0 }, until: ISO });
    expect(FleetHistoryDTOSchema.safeParse((await call(h, 'GET', '/api/fleet/history', undefined, { session })).json()).success).toBe(true);
    expect((await call(h, 'GET', '/api/wins', undefined, { session })).json()).toEqual({ items: [], byServer: {} });
    expect((await call(h, 'GET', '/api/timeline?day=2026-10-09', undefined, { session })).json()).toEqual({ day: '2026-10-09', items: [] });
    const create = await call(h, 'POST', '/api/links', { server: 'birch', label: 'Jira', url: 'https://orchard-demo.atlassian.net' }, { session });
    expect(LinkDTOSchema.parse(create.json())).toEqual({ id: 1, server: 'birch', label: 'Jira', url: 'https://orchard-demo.atlassian.net', position: 0 });
    expect((await call(h, 'POST', '/api/links', { server: 'birch', label: 'x', url: 'http://x.example' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/links/1', { label: 'Board' }, { session })).json()).toMatchObject({ label: 'Board' });
    expect((await call(h, 'PUT', '/api/links/9', { label: 'y' }, { session })).statusCode).toBe(404);
    expect(LinkListDTOSchema.parse((await call(h, 'GET', '/api/links', undefined, { session })).json()).items).toHaveLength(1);
    expect((await call(h, 'POST', '/api/links/1/delete', {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'PUT', '/api/prefs', { dayNight: false }, { session })).json()).toEqual({ ...DEFAULT_WEB_PREFS, dayNight: false });
    expect((await call(h, 'GET', '/api/prefs', undefined, { session })).json()).toEqual({ ...DEFAULT_WEB_PREFS, dayNight: false });
    expect(changed).toEqual(['links', 'links', 'links', 'prefs']);
  });
});

describe('fanOut for schedules, links and prefs', () => {
  it('forwards schedules.changed, links.changed and prefs.changed to every client', () => {
    const bus = createBus();
    const sent: WsServerMessage[] = [];
    const offs = fanOut(bus, (message) => sent.push(message));
    bus.emit('schedules.changed', { at: ISO });
    bus.emit('links.changed', { at: ISO });
    bus.emit('prefs.changed', { at: ISO });
    expect(sent).toEqual([{ type: 'schedules.changed', at: ISO }, { type: 'links.changed', at: ISO }, { type: 'prefs.changed', at: ISO }]);
    offs.forEach((off) => off());
  });
});
