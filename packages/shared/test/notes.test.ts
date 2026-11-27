import { describe, expect, it } from 'vitest';
import {
  CreateNoteBodySchema,
  NOTE_ID_RE,
  NoteDTOSchema,
  NoteListDTOSchema,
  NoteTranscriptDTOSchema,
  UpdateNoteBodySchema,
} from '../src/notes.js';

const note = {
  id: 'm:3f2a9c1e7b4d',
  kind: 'meeting',
  title: 'Weekly sync',
  at: '2026-11-15T06:00:00.000Z',
  project: 'orchard',
  people: 'Sara, Omar',
  gist: 'Checkout bug first',
  summary: 'We agreed to fix checkout first.',
  actionItems: '- Fix checkout',
  ownerNotes: null,
  link: 'https://wisprflow.ai/m/3f2a',
  hasTranscript: true,
  editable: false,
};

describe('NoteDTOSchema', () => {
  it('parses a meeting and a typed note', () => {
    expect(NoteDTOSchema.parse(note)).toEqual(note);
    const typed = { ...note, id: 'n:4', kind: 'note', people: null, gist: null, actionItems: null, link: null, hasTranscript: false, editable: true };
    expect(NoteDTOSchema.parse(typed)).toEqual(typed);
    expect(NoteListDTOSchema.parse({ items: [note, typed] }).items).toHaveLength(2);
  });

  it('rejects an id that is neither m: nor n:, and an unknown kind', () => {
    expect(NoteDTOSchema.safeParse({ ...note, id: 'x:1' }).success).toBe(false);
    expect(NoteDTOSchema.safeParse({ ...note, kind: 'email' }).success).toBe(false);
  });

  it('NOTE_ID_RE takes meeting ids and positive note numbers only', () => {
    expect(['m:abc', 'm:3f2a-9c1e', 'n:1', 'n:120'].every((id) => NOTE_ID_RE.test(id))).toBe(true);
    expect(['n:0', 'n:x', 'm:', 'm:a/b', '4', 'n:1 '].some((id) => NOTE_ID_RE.test(id))).toBe(false);
  });
});

describe('note bodies', () => {
  it('CreateNoteBodySchema accepts a body alone and a full body', () => {
    expect(CreateNoteBodySchema.parse({ body: 'Stand-up: login done' })).toEqual({ body: 'Stand-up: login done' });
    const full = { title: 'Stand-up', body: 'Login done', project: 'orchard', discuss: true };
    expect(CreateNoteBodySchema.parse(full)).toEqual(full);
  });

  it.each([
    ['an empty body', { body: '' }],
    ['a 20001-character body', { body: 'x'.repeat(20001) }],
    ['a 201-character title', { title: 'x'.repeat(201), body: 'x' }],
    ['a 61-character project', { body: 'x', project: 'x'.repeat(61) }],
    ['an unknown key', { body: 'x', kind: 'meeting' }],
  ])('CreateNoteBodySchema rejects %s', (_label, body) => {
    expect(CreateNoteBodySchema.safeParse(body).success).toBe(false);
  });

  it('UpdateNoteBodySchema clears the project and rejects unknown keys', () => {
    expect(UpdateNoteBodySchema.parse({ project: null })).toEqual({ project: null });
    expect(UpdateNoteBodySchema.safeParse({ discuss: true }).success).toBe(false);
    expect(UpdateNoteBodySchema.safeParse({ body: '' }).success).toBe(false);
  });

  it('NoteTranscriptDTOSchema parses a part and the last part', () => {
    expect(NoteTranscriptDTOSchema.parse({ text: 'Hello', nextStart: 12000 })).toEqual({ text: 'Hello', nextStart: 12000 });
    expect(NoteTranscriptDTOSchema.parse({ text: '', nextStart: null }).nextStart).toBeNull();
    expect(NoteTranscriptDTOSchema.safeParse({ text: '', nextStart: -1 }).success).toBe(false);
  });
});
