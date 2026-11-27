import { z } from 'zod';
import { LIMITS } from './limits.js';

/** A note id: `m:<meeting id>` (Wispr Flow) or `n:<number>` (typed or pasted by the owner). */
export const NOTE_ID_RE = /^(?:m:[A-Za-z0-9._-]{1,64}|n:[1-9]\d{0,11})$/;
export const NoteIdSchema = z.string().regex(NOTE_ID_RE);

export const NOTE_KINDS = ['meeting', 'note'] as const;
export const NoteKindSchema = z.enum(NOTE_KINDS);
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * A meeting note or a typed note. `editable`: typed notes only (a meeting answers 409 to edits and deletes).
 * `isNew`: a meeting the owner has not opened yet (POST /api/notes/:id/opened clears it); a typed note is never new,
 * the owner wrote it. Absent (an older hub) = not new. In a list the summary is cut to LIMITS.noteListSummaryMax characters.
 */
export const NoteDTOSchema = z.object({
  id: NoteIdSchema,
  kind: NoteKindSchema,
  title: z.string(),
  at: z.string(),
  project: z.string().nullable(),
  people: z.string().nullable(),
  gist: z.string().nullable(),
  summary: z.string(),
  actionItems: z.string().nullable(),
  ownerNotes: z.string().nullable(),
  link: z.string().nullable(),
  hasTranscript: z.boolean(),
  editable: z.boolean(),
  isNew: z.boolean().optional(),
});
export type NoteDTO = z.infer<typeof NoteDTOSchema>;

/** Newest first. `newCount`: every note not opened yet, over all notes (not only this page or search); absent = an older hub. */
export const NoteListDTOSchema = z.object({ items: z.array(NoteDTOSchema), newCount: z.number().int().min(0).optional() });
export type NoteListDTO = z.infer<typeof NoteListDTOSchema>;

/** A new typed note. `discuss`: send it to Luady as an owner message about the note once it is saved. */
export const CreateNoteBodySchema = z.strictObject({
  title: z.string().max(LIMITS.noteTitleMax).optional(),
  body: z.string().min(1).max(LIMITS.noteBodyMax),
  project: z.string().max(LIMITS.noteProjectMax).optional(),
  discuss: z.boolean().optional(),
});
export type CreateNoteBody = z.infer<typeof CreateNoteBodySchema>;

export const UpdateNoteBodySchema = z.strictObject({
  title: z.string().max(LIMITS.noteTitleMax).optional(),
  body: z.string().min(1).max(LIMITS.noteBodyMax).optional(),
  project: z.string().max(LIMITS.noteProjectMax).nullable().optional(),
});
export type UpdateNoteBody = z.infer<typeof UpdateNoteBodySchema>;

/** One part of a meeting's transcript, read live from Wispr Flow; `nextStart` null = this was the last part. */
export const NoteTranscriptDTOSchema = z.object({ text: z.string(), nextStart: z.number().int().min(0).nullable() });
export type NoteTranscriptDTO = z.infer<typeof NoteTranscriptDTOSchema>;
