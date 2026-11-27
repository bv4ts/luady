import { describe, expect, it } from 'vitest';
import {
  BoardItemDTOSchema, BoardItemDetailDTOSchema, BoardListDTOSchema, DelegateResultDTOSchema, MissionListDTOSchema, SaidListDTOSchema,
} from '@luady/shared';
import { createBoardService } from '../../src/board/index.js';
import { createSaidService } from '../../src/said/index.js';
import { JiraNotConnectedError } from '../../src/core/errors.js';
import { call, harnessFactory, sampleCard, type Harness } from './helpers.js';

const harness = harnessFactory();

/** The real board and speech feed behind the routes, built from the harness deps. */
async function real(): Promise<Harness> {
  const probe = await harness();
  const { db, bus, clock, log, sessions, luady, projects } = probe.deps;
  const missions = { isManaged: () => false, views: () => [], view: () => null };
  const todos = { refreshToday: async () => undefined };
  const jira = { issue: async () => { throw new JiraNotConnectedError(); } };
  const notes = { get: async () => null };
  return harness({
    board: createBoardService({ db, bus, clock, log, sessions, missions, luady, projects, todos, jira, notes }),
    said: createSaidService({ bus, clock, log, sessions }),
    luady,
  });
}

describe('/api/board', () => {
  it('lists, adds, opens, edits and deletes cards through the board service', async () => {
    const h = await harness();
    const session = h.login();
    expect(BoardListDTOSchema.parse((await call(h, 'GET', '/api/board', undefined, { session })).json())).toEqual({ items: [sampleCard()] });

    const added = await call(h, 'POST', '/api/board', { title: 'Fix the checkout total', project: 'orchard', server: 'birch' }, { session });
    expect(added.statusCode).toBe(200);
    expect(BoardItemDTOSchema.parse(added.json()).id).toBe(12);
    expect(h.deps.board.add).toHaveBeenCalledWith({ title: 'Fix the checkout total', project: 'orchard', server: 'birch', source: 'web' }, 'owner');

    const detail = await call(h, 'GET', '/api/board/12', undefined, { session });
    expect(BoardItemDetailDTOSchema.parse(detail.json()).item.id).toBe(12);
    expect((await call(h, 'GET', '/api/board/99', undefined, { session })).statusCode).toBe(404);

    const edited = await call(h, 'PUT', '/api/board/12', { state: 'done' }, { session });
    expect(BoardItemDTOSchema.parse(edited.json()).state).toBe('done');
    expect(h.deps.board.update).toHaveBeenCalledWith(12, { state: 'done' }, 'owner');

    const removed = await call(h, 'POST', '/api/board/12/delete', {}, { session });
    expect(removed.json()).toEqual({ ok: true });
    expect(h.deps.board.remove).toHaveBeenCalledWith(12, 'owner');
  });

  it('keeps the source a card names', async () => {
    const h = await harness();
    await call(h, 'POST', '/api/board', { title: 'ORC-1 Login', source: 'jira', sourceRef: 'birch:ORC-1' }, { session: h.login() });
    expect(h.deps.board.add).toHaveBeenCalledWith({ title: 'ORC-1 Login', source: 'jira', sourceRef: 'birch:ORC-1' }, 'owner');
  });

  it('refuses no session (401), no CSRF token (403), bad bodies and ids (400)', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/board')).statusCode).toBe(401);
    expect((await call(h, 'POST', '/api/board', { title: 'x' }, { session, csrf: null })).statusCode).toBe(403);
    expect((await call(h, 'POST', '/api/board', { title: 'x', state: 'done' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/board/12', { state: 'running' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/board/abc', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/board/12/delete', { really: true }, { session })).statusCode).toBe(400);
    expect(h.deps.board.add).not.toHaveBeenCalled();
    expect(h.deps.board.update).not.toHaveBeenCalled();
  });

  it('with the real board: add, open, edit, Run, and the errors the board answers', async () => {
    const h = await real();
    const session = h.login();
    expect((await call(h, 'GET', '/api/board', undefined, { session })).json()).toEqual({ items: [] });
    expect((await call(h, 'GET', '/api/board/1', undefined, { session })).statusCode).toBe(404);
    const add = await call(h, 'POST', '/api/board', { title: 'Fix the total', project: 'orchard', server: 'birch' }, { session });
    expect(BoardItemDTOSchema.parse(add.json())).toMatchObject({ id: 1, source: 'web', state: 'open' });
    expect(BoardItemDetailDTOSchema.parse((await call(h, 'GET', '/api/board/1', undefined, { session })).json()).events).toHaveLength(1);
    expect((await call(h, 'PUT', '/api/board/1', { today: true, priority: 1 }, { session })).json()).toMatchObject({ today: true, priority: 1 });
    expect((await call(h, 'PUT', '/api/board/9', { today: true }, { session })).statusCode).toBe(404);
    const run = await call(h, 'POST', '/api/delegate', { what: [{ kind: 'todo', id: 1 }], to: { kind: 'auto' } }, { session });
    expect(DelegateResultDTOSchema.parse(run.json())).toMatchObject({ items: [{ id: 1, state: 'queued' }] });
    expect(h.deps.luady.postEvent).toHaveBeenCalledWith(expect.stringContaining('Run from the board'), 'Event');
    const ticket = await call(h, 'POST', '/api/delegate', { what: [{ kind: 'jira', server: 'birch', key: 'ORC-1' }], to: { kind: 'auto' } }, { session });
    expect(ticket.statusCode).toBe(409);
    expect(ticket.json()).toMatchObject({ error: { code: 'jira_not_connected' } });
    expect((await call(h, 'POST', '/api/delegate', { what: [{ kind: 'note', id: 'n:3' }], to: { kind: 'auto' } }, { session })).statusCode).toBe(404);
    expect((await call(h, 'PUT', '/api/board/1', { state: 'done' }, { session })).json()).toMatchObject({ state: 'done' });
    expect((await call(h, 'POST', '/api/board/1/delete', {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'GET', '/api/missions', undefined, { session })).json()).toEqual({ items: [] });
    expect((await call(h, 'GET', '/api/said', undefined, { session })).json()).toEqual({ items: [] });
  });
});

describe('/api/delegate, /api/missions and /api/said', () => {
  it('delegates a valid body and returns the result', async () => {
    const h = await harness();
    const body = { what: [{ kind: 'todo', id: 12 }, { kind: 'jira', server: 'birch', key: 'ORC-123' }], to: { kind: 'server', server: 'birch' } };
    const res = await call(h, 'POST', '/api/delegate', body, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(DelegateResultDTOSchema.parse(res.json()).runId).toBe('r_1');
    // The request passed the owner's session and page key, so the manager gets it as the owner's own request.
    expect(h.deps.board.delegate).toHaveBeenCalledWith(body, { ownerOnWebsite: true });
  });

  it('refuses an empty list, a bad ticket key and a missing CSRF token', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/delegate', { what: [], to: { kind: 'auto' } }, { session })).statusCode).toBe(400);
    const badKey = { what: [{ kind: 'jira', server: 'birch', key: 'orc-1' }], to: { kind: 'auto' } };
    expect((await call(h, 'POST', '/api/delegate', badKey, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/delegate', { what: [{ kind: 'todo', id: 1 }], to: { kind: 'auto' } }, { session, csrf: null })).statusCode).toBe(403);
    expect(h.deps.board.delegate).not.toHaveBeenCalled();
  });

  it('lists missions and what agents said, behind the session', async () => {
    const h = await harness();
    const session = h.login();
    expect(MissionListDTOSchema.parse((await call(h, 'GET', '/api/missions', undefined, { session })).json())).toEqual({ items: [] });
    expect(SaidListDTOSchema.parse((await call(h, 'GET', '/api/said', undefined, { session })).json())).toEqual({ items: [] });
    expect((await call(h, 'GET', '/api/missions')).statusCode).toBe(401);
    expect((await call(h, 'GET', '/api/said')).statusCode).toBe(401);
    expect((await call(h, 'POST', '/api/delegate', { what: [{ kind: 'todo', id: 1 }], to: { kind: 'auto' } })).statusCode).toBe(401);
  });
});
