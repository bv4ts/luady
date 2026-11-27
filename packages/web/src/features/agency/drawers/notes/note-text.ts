import { LIMITS, type BoardItemDTO, type ChatMessageDTO, type CreateBoardItemBody, type CreateNoteBody, type NoteDTO } from '@luady/shared';
import { isNoUpdate } from '../../../luady/no-update.js';

/** The text a note is sent to Luady with when the owner adds no words of their own. */
export const DISCUSS_TEXT = 'Please read this note, tell me what you think, and put the to-dos you see on the board.';

/** Action items, one per line, without list marks ("- ", "* ", "1. ", "[ ] "). */
export function actionItemsOf(text: string | null): readonly string[] {
  if (text === null) return [];
  return text.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ xX]?\]\s*)?/, '').trim())
    .filter((line) => line !== '');
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const sourceOf = (note: Pick<NoteDTO, 'kind'>): 'meeting' | 'note' => (note.kind === 'meeting' ? 'meeting' : 'note');

/** A card for one action item of a note ("Make it a task"). */
export function taskFromItem(note: Pick<NoteDTO, 'id' | 'kind' | 'title' | 'project'>, item: string): CreateBoardItemBody {
  return {
    title: cut(item, LIMITS.boardTitleMax),
    details: cut(`From the ${note.kind === 'meeting' ? 'meeting' : 'note'} "${note.title}".${item.length > LIMITS.boardTitleMax ? `\n\n${item}` : ''}`, LIMITS.boardDetailsMax),
    source: sourceOf(note), sourceRef: note.id,
    ...(note.project === null || note.project === '' ? {} : { project: cut(note.project, LIMITS.boardProjectMax) }),
  };
}

/** A card for the whole note: its title, and the summary and action items as details. */
export function taskFromNote(note: Pick<NoteDTO, 'id' | 'kind' | 'title' | 'project' | 'summary' | 'actionItems'>): CreateBoardItemBody {
  const items = actionItemsOf(note.actionItems);
  const parts = [note.summary.trim(), items.length === 0 ? '' : `Action items:\n${items.map((item) => `- ${item}`).join('\n')}`].filter((part) => part !== '');
  return {
    title: cut(note.title.trim() === '' ? 'Follow up on a note' : note.title.trim(), LIMITS.boardTitleMax),
    details: cut(parts.join('\n\n'), LIMITS.boardDetailsMax),
    source: sourceOf(note), sourceRef: note.id,
    ...(note.project === null || note.project === '' ? {} : { project: cut(note.project, LIMITS.boardProjectMax) }),
  };
}

/** A card's source reference names this note (`m:abc`, `n:7`, or the bare meeting id Luady may pass). */
export function cardIsFromNote(card: Pick<BoardItemDTO, 'source' | 'sourceRef'>, noteId: string): boolean {
  if (card.sourceRef === null || (card.source !== 'note' && card.source !== 'meeting')) return false;
  return card.sourceRef === noteId || `m:${card.sourceRef}` === noteId || `n:${card.sourceRef}` === noteId;
}

/** The cards made from a note, newest first. */
export function cardsFromNote(cards: readonly BoardItemDTO[], noteId: string): readonly BoardItemDTO[] {
  return cards.filter((card) => cardIsFromNote(card, noteId)).toSorted((a, b) => b.id - a.id);
}

/**
 * "Luady's answer": his first reply after the newest owner message that carries this note. Null while there is
 * no such message or he has not answered yet.
 */
export function luadyAnswer(messages: readonly ChatMessageDTO[], noteId: string): { readonly asked: ChatMessageDTO; readonly answer: ChatMessageDTO | null } | null {
  const sorted = messages.toSorted((a, b) => a.ts.localeCompare(b.ts));
  const askedAt = sorted.findLastIndex((message) => message.role === 'owner' && message.about?.kind === 'note' && message.about.id === noteId);
  const asked = sorted[askedAt];
  if (asked === undefined) return null;
  return { asked, answer: sorted.slice(askedAt + 1).find((message) => message.role === 'manager' && !isNoUpdate(message.text)) ?? null };
}

/** The new-note form → the request body; an error text when it cannot be sent. */
export function newNoteBody(form: { title: string; project: string; body: string }, discuss: boolean): CreateNoteBody | string {
  const body = form.body.trim();
  if (body === '') return 'Paste or type the note first.';
  if (body.length > LIMITS.noteBodyMax) return `Keep the note under ${String(LIMITS.noteBodyMax)} characters.`;
  const title = form.title.trim();
  const project = form.project.trim();
  if (title.length > LIMITS.noteTitleMax) return `Keep the title under ${String(LIMITS.noteTitleMax)} characters.`;
  if (project.length > LIMITS.noteProjectMax) return `Keep the project under ${String(LIMITS.noteProjectMax)} characters.`;
  return { body, ...(title === '' ? {} : { title }), ...(project === '' ? {} : { project }), ...(discuss ? { discuss: true } : {}) };
}
