import { describe, expect, it } from 'vitest';
import { KbListDTOSchema, KbPageFullDTOSchema, LibraryDTOSchema } from '@luady/shared';
import { createKbService } from '../../src/kb/index.js';
import { createLibraryService } from '../../src/library/index.js';
import { call, harnessFactory, samplePage } from './helpers.js';

const harness = harnessFactory();

describe('/api/kb', () => {
  it('lists with filters, opens, creates, edits, deletes and syncs pages', async () => {
    const h = await harness();
    const session = h.login();
    expect(KbListDTOSchema.parse((await call(h, 'GET', '/api/kb', undefined, { session })).json()).items).toHaveLength(1);
    await call(h, 'GET', '/api/kb?scope=project&server=birch&project=orchard&query=deploy', undefined, { session });
    expect(h.deps.kb.list).toHaveBeenLastCalledWith({ scope: 'project', server: 'birch', project: 'orchard', query: 'deploy' });
    await call(h, 'GET', '/api/kb?scope=&server=', undefined, { session });
    expect(h.deps.kb.list).toHaveBeenLastCalledWith({});

    expect(KbPageFullDTOSchema.parse((await call(h, 'GET', '/api/kb/3', undefined, { session })).json())).toEqual(samplePage());
    expect((await call(h, 'GET', '/api/kb/4', undefined, { session })).statusCode).toBe(404);

    const body = { scope: 'office', server: 'cedar', title: 'Meadow', body: 'Laravel' };
    expect((await call(h, 'POST', '/api/kb', body, { session })).statusCode).toBe(200);
    expect(h.deps.kb.create).toHaveBeenCalledWith(body, 'owner');
    await call(h, 'PUT', '/api/kb/3', { pinned: true }, { session });
    expect(h.deps.kb.update).toHaveBeenCalledWith(3, { pinned: true }, 'owner');
    expect((await call(h, 'POST', '/api/kb/3/delete', {}, { session })).json()).toEqual({ ok: true });
    expect(h.deps.kb.remove).toHaveBeenCalledWith(3);

    expect((await call(h, 'POST', '/api/kb/sync', {}, { session })).json()).toEqual({ ok: true });
    expect(h.deps.kb.sync).toHaveBeenLastCalledWith(undefined);
    await call(h, 'POST', '/api/kb/sync', { server: 'ash' }, { session });
    expect(h.deps.kb.sync).toHaveBeenLastCalledWith('ash');
  });

  it('refuses no session, no CSRF token, a scope without its server and a bad filter', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/kb')).statusCode).toBe(401);
    expect((await call(h, 'POST', '/api/kb/sync', {}, { session, csrf: null })).statusCode).toBe(403);
    expect((await call(h, 'POST', '/api/kb', { scope: 'office', title: 'x', body: '' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/kb?scope=team', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/kb/sync', { server: 'hq' }, { session })).statusCode).toBe(400);
    expect(h.deps.kb.create).not.toHaveBeenCalled();
  });

  it('with the real service: create, list, search, edit, sync and delete', async () => {
    const probe = await harness();
    const { db, bus, clock, log, fleet, projects } = probe.deps;
    const h = await harness({ kb: createKbService({ db, bus, clock, log, fleet, projects }) });
    const session = h.login();
    expect((await call(h, 'GET', '/api/kb', undefined, { session })).json()).toMatchObject({ items: [] });
    const created = await call(h, 'POST', '/api/kb', { scope: 'office', server: 'cedar', title: 'Meadow', body: 'Laravel app' }, { session });
    const page = KbPageFullDTOSchema.parse(created.json());
    expect(page).toMatchObject({ slug: 'meadow', updatedBy: 'owner', body: 'Laravel app' });
    expect(KbListDTOSchema.parse((await call(h, 'GET', '/api/kb?query=laravel', undefined, { session })).json()).items).toHaveLength(1);
    expect((await call(h, 'PUT', `/api/kb/${page.id}`, { pinned: true }, { session })).json()).toMatchObject({ pinned: true });
    expect((await call(h, 'POST', '/api/kb/sync', {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'POST', `/api/kb/${page.id}/delete`, {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'GET', `/api/kb/${page.id}`, undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'PUT', '/api/kb/999', { body: 'x' }, { session })).statusCode).toBe(404);
  });
});

describe('/api/library', () => {
  it('returns the library and refreshes one office or all', async () => {
    const h = await harness();
    const session = h.login();
    expect(LibraryDTOSchema.parse((await call(h, 'GET', '/api/library', undefined, { session })).json())).toEqual({ offices: [], managerSkills: [] });
    expect((await call(h, 'POST', '/api/library/refresh', { server: 'birch' }, { session })).json()).toEqual({ ok: true });
    expect(h.deps.library.refresh).toHaveBeenCalledWith('birch');
    expect((await call(h, 'POST', '/api/library/refresh', { all: true }, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/library')).statusCode).toBe(401);
  });

  it('with the real service: the offices and a refresh', async () => {
    const probe = await harness();
    const { bus, clock, log, fleet, projects, sessions, board, kb, config } = probe.deps;
    const h = await harness({ library: createLibraryService({ bus, clock, log, fleet, projects, sessions, board, kb, brainDir: config.brainDir }) });
    const session = h.login();
    const dto = LibraryDTOSchema.parse((await call(h, 'GET', '/api/library', undefined, { session })).json());
    expect(dto.offices.map((o) => o.server)).toEqual(['cedar']);
    expect((await call(h, 'POST', '/api/library/refresh', {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'POST', '/api/library/refresh', {}, { session, csrf: null })).statusCode).toBe(403);
  });
});
