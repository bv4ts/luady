import {
  CreateNoteBodySchema, NoteDTOSchema, NoteListDTOSchema, NoteTranscriptDTOSchema, UpdateNoteBodySchema,
} from '@luady/shared';
import type { z } from 'zod';
import { OkSchema } from './schemas.js';
import { EMPTY, checked, query, seg, type Verbs } from './verbs.js';

export type CreateNoteInput = z.input<typeof CreateNoteBodySchema>;
export type UpdateNoteInput = z.input<typeof UpdateNoteBodySchema>;

/** Meeting notes and typed notes. */
export function noteRoutes({ get, post, put }: Verbs) {
  const note = (id: string): string => `/api/notes/${seg(id)}`;
  return {
    notes: (filter: { query?: string; limit?: number } = {}) =>
      get(`/api/notes${query({ query: filter.query, limit: filter.limit })}`, NoteListDTOSchema),
    note: (id: string) => get(note(id), NoteDTOSchema),
    createNote: async (body: CreateNoteInput) => post('/api/notes', NoteDTOSchema, checked(CreateNoteBodySchema, body)),
    updateNote: async (id: string, body: UpdateNoteInput) => put(note(id), NoteDTOSchema, checked(UpdateNoteBodySchema, body)),
    deleteNote: (id: string) => post(`${note(id)}/delete`, OkSchema, EMPTY),
    /** The owner opened it: a meeting stops showing "NEW" on every device. */
    markNoteOpened: (id: string) => post(`${note(id)}/opened`, OkSchema, EMPTY),
    noteTranscript: (id: string, start = 0) => get(`${note(id)}/transcript${query({ start })}`, NoteTranscriptDTOSchema),
  };
}
