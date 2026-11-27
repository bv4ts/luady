import { z } from 'zod';
import {
  CreateNoteBodySchema, LIMITS, NoteIdSchema, UpdateNoteBodySchema, type NoteDTO, type NoteListDTO, type NoteTranscriptDTO,
} from '@luady/shared';
import { NotFoundError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { EmptyBodySchema } from '../schemas.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

const NoteParamsSchema = z.strictObject({ id: NoteIdSchema });
const NotesQuerySchema = z.strictObject({
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.noteListMax).default(LIMITS.noteListDefault),
});
const TranscriptQuerySchema = z.strictObject({ start: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) });

/** Meeting notes and typed notes; meetings are read-only (409 on edit and delete). */
export const noteRoutes: RouteModule = (app, ctx) => {
  const { notes } = ctx.deps;
  const noteId = (params: unknown): string => parseParams(NoteParamsSchema, params).id;
  app.get('/api/notes', async (request): Promise<NoteListDTO> => {
    const { query, limit } = parseQuery(NotesQuerySchema, request.query);
    const items = await notes.list({ limit, ...(query === undefined || query.trim() === '' ? {} : { query: query.trim() }) });
    return { items, newCount: notes.newCount() };
  });
  app.get('/api/notes/:id', async (request): Promise<NoteDTO> => {
    const id = noteId(request.params);
    const note = await notes.get(id);
    if (note === null) throw new NotFoundError(`No note ${id}`);
    return note;
  });
  app.post('/api/notes', async (request): Promise<NoteDTO> => notes.create(parseBody(CreateNoteBodySchema, request.body)));
  app.put('/api/notes/:id', async (request): Promise<NoteDTO> =>
    notes.update(noteId(request.params), parseBody(UpdateNoteBodySchema, request.body)));
  app.post('/api/notes/:id/delete', async (request): Promise<{ ok: true }> => {
    const id = noteId(request.params);
    parseBody(EmptyBodySchema, request.body);
    await notes.remove(id);
    return { ok: true };
  });
  app.post('/api/notes/:id/opened', async (request): Promise<{ ok: true }> => {
    const id = noteId(request.params);
    parseBody(EmptyBodySchema, request.body);
    await notes.opened(id);
    return { ok: true };
  });
  app.get('/api/notes/:id/transcript', async (request): Promise<NoteTranscriptDTO> => {
    const id = noteId(request.params);
    const { start } = parseQuery(TranscriptQuerySchema, request.query);
    return notes.transcript(id, start);
  });
};
