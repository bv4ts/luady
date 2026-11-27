import { describe, expect, it } from 'vitest';
import { NoteDTOSchema, NoteListDTOSchema, NoteTranscriptDTOSchema } from '@luady/shared';
import { createNotesService } from '../../src/notes/index.js';
import { call, harnessFactory, sampleNote } from './helpers.js';

const harness = harnessFactory();

describe('/api/notes', () => {
  it('lists with a query and a limit, 50 by default', async () => {
    const h = await harness();
    const session = h.login();
    const res = await call(h, 'GET', '/api/notes', undefined, { session });
    expect(NoteListDTOSchema.parse(res.json())).toEqual({ items: [sampleNote()], newCount: 0 });
    expect(h.deps.notes.list).toHaveBeenLastCalledWith({ limit: 50 });
    await call(h, 'GET', '/api/notes?query=%20stand-up%20&limit=200', undefined, { session });
    expect(h.deps.notes.list).toHaveBeenLastCalledWith({ limit: 200, query: 'stand-up' });
    await call(h, 'GET', '/api/notes?query=', undefined, { session });
    expect(h.deps.notes.list).toHaveBeenLastCalledWith({ limit: 50 });
    expect((await call(h, 'GET', '/api/notes?limit=201', undefined, { session })).statusCode).toBe(400);
  });

  it('opens, creates, edits, deletes and pages a transcript', async () => {
    const h = await harness();
    const session = h.login();
    expect(NoteDTOSchema.parse((await call(h, 'GET', '/api/notes/n%3A4', undefined, { session })).json()).id).toBe('n:4');
    expect((await call(h, 'GET', '/api/notes/n%3A5', undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'GET', '/api/notes/x%3A5', undefined, { session })).statusCode).toBe(400);

    const created = await call(h, 'POST', '/api/notes', { body: 'Stand-up: login done', discuss: true }, { session });
    expect(created.statusCode).toBe(200);
    expect(h.deps.notes.create).toHaveBeenCalledWith({ body: 'Stand-up: login done', discuss: true });

    await call(h, 'PUT', '/api/notes/n%3A4', { project: null }, { session });
    expect(h.deps.notes.update).toHaveBeenCalledWith('n:4', { project: null });

    expect((await call(h, 'POST', '/api/notes/n%3A4/delete', {}, { session })).json()).toEqual({ ok: true });
    expect(h.deps.notes.remove).toHaveBeenCalledWith('n:4');

    const part = await call(h, 'GET', '/api/notes/m%3Aabc12345/transcript?start=12000', undefined, { session });
    expect(NoteTranscriptDTOSchema.parse(part.json())).toEqual({ text: 'Hello', nextStart: null });
    expect(h.deps.notes.transcript).toHaveBeenCalledWith('m:abc12345', 12000);
  });

  it('marks a note opened (empty body, CSRF, a note id)', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/notes/m%3Aabc12345/opened', {}, { session })).json()).toEqual({ ok: true });
    expect(h.deps.notes.opened).toHaveBeenCalledWith('m:abc12345');
    expect((await call(h, 'POST', '/api/notes/x%3A5/opened', {}, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/notes/m%3Aabc12345/opened', { at: 1 }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/notes/m%3Aabc12345/opened', {}, { session, csrf: null })).statusCode).toBe(403);
    expect(h.deps.notes.opened).toHaveBeenCalledTimes(1);
  });

  it('refuses no session, no CSRF token and bad bodies', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/notes')).statusCode).toBe(401);
    expect((await call(h, 'POST', '/api/notes', { body: 'x' }, { session, csrf: null })).statusCode).toBe(403);
    expect((await call(h, 'POST', '/api/notes', { body: '' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/notes/n%3A4', { kind: 'meeting' }, { session })).statusCode).toBe(400);
    expect(h.deps.notes.create).not.toHaveBeenCalled();
  });

  it('with the real notes: create, list, edit, delete, and a typed note has no transcript (409)', async () => {
    const probe = await harness();
    const { db, bus, clock, log, luady } = probe.deps;
    const meetings = { get: async () => 'x' };
    const h = await harness({ notes: createNotesService({ db, bus, clock, log, luady, meetings }), luady });
    const session = h.login();
    expect((await call(h, 'GET', '/api/notes', undefined, { session })).json()).toEqual({ items: [], newCount: 0 });
    expect((await call(h, 'GET', '/api/notes/n%3A1', undefined, { session })).statusCode).toBe(404);
    const created = await call(h, 'POST', '/api/notes', { body: 'Stand-up: login done', discuss: true }, { session });
    expect(NoteDTOSchema.parse(created.json())).toMatchObject({ id: 'n:1', title: 'Stand-up: login done', editable: true });
    expect(h.deps.luady.postOwnerMessage).toHaveBeenCalledWith(expect.any(String), 'web', expect.objectContaining({ kind: 'note', id: 'n:1' }));
    expect(NoteListDTOSchema.parse((await call(h, 'GET', '/api/notes?query=login', undefined, { session })).json()).items).toHaveLength(1);
    expect((await call(h, 'PUT', '/api/notes/n%3A1', { title: 'Plan' }, { session })).json()).toMatchObject({ title: 'Plan' });
    expect((await call(h, 'PUT', '/api/notes/m%3Aabc', { title: 'x' }, { session })).statusCode).toBe(409);
    expect((await call(h, 'GET', '/api/notes/n%3A1/transcript', undefined, { session })).statusCode).toBe(409);
    expect((await call(h, 'POST', '/api/notes/n%3A1/delete', {}, { session })).json()).toEqual({ ok: true });
    expect((await call(h, 'POST', '/api/notes/n%3A1/delete', {}, { session })).statusCode).toBe(404);
  });
});
