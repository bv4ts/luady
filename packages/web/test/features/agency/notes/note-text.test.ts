import { describe, expect, it } from 'vitest';
import {
  actionItemsOf, cardsFromNote, luadyAnswer, newNoteBody, taskFromItem, taskFromNote,
} from '../../../../src/features/agency/drawers/notes/note-text.js';
import { chat } from '../../../fixtures.js';
import { card, note } from '../board/board-fixtures.js';

describe('note text', () => {
  it('reads action items without list marks', () => {
    expect(actionItemsOf('- One\n* Two\n1. Three\n2) Four\n- [ ] Five\n\n  ')).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
    expect(actionItemsOf(null)).toEqual([]);
  });

  it('makes a card from one action item and from the whole note', () => {
    const meeting = note('m:abc', { title: 'Weekly sync', project: 'orchard-web', summary: 'We agreed.', actionItems: '- Ship it\n- Test it' });
    expect(taskFromItem(meeting, 'Ship it')).toEqual({
      title: 'Ship it', details: 'From the meeting "Weekly sync".', source: 'meeting', sourceRef: 'm:abc', project: 'orchard-web',
    });
    expect(taskFromNote(meeting)).toEqual({
      title: 'Weekly sync', details: 'We agreed.\n\nAction items:\n- Ship it\n- Test it', source: 'meeting', sourceRef: 'm:abc', project: 'orchard-web',
    });
    const typed = note('n:4', { title: '', summary: '' });
    expect(taskFromNote(typed)).toEqual({ title: 'Follow up on a note', details: '', source: 'note', sourceRef: 'n:4' });
    expect(taskFromItem(typed, 'x'.repeat(400)).title).toHaveLength(300);
  });

  it('finds the cards made from a note, whatever form the reference takes', () => {
    const cards = [
      card(1, { source: 'meeting', sourceRef: 'abc' }), card(2, { source: 'meeting', sourceRef: 'm:abc' }),
      card(3, { source: 'note', sourceRef: 'n:4' }), card(4, { source: 'web', sourceRef: 'm:abc' }),
    ];
    expect(cardsFromNote(cards, 'm:abc').map((c) => c.id)).toEqual([2, 1]);
    expect(cardsFromNote(cards, 'n:4').map((c) => c.id)).toEqual([3]);
  });

  it("finds Luady's answer: his first reply after the newest message about the note", () => {
    const about = { kind: 'note' as const, id: 'n:4', label: 'Stand-up' };
    const messages = [
      chat({ id: 'a', role: 'owner', ts: '2026-11-15T09:00:00Z', about }),
      chat({ id: 'b', role: 'manager', ts: '2026-11-15T09:01:00Z', text: 'Old answer' }),
      chat({ id: 'c', role: 'owner', ts: '2026-11-15T10:00:00Z', about }),
      chat({ id: 'e', role: 'manager', ts: '2026-11-15T10:02:00Z', text: 'Second' }),
      chat({ id: 'd', role: 'manager', ts: '2026-11-15T10:01:00Z', text: 'New answer' }),
    ];
    expect(luadyAnswer(messages, 'n:4')?.answer?.text).toBe('New answer');
    expect(luadyAnswer(messages.slice(0, 3), 'n:4')).toMatchObject({ asked: { id: 'c' }, answer: null });
    expect(luadyAnswer(messages, 'n:9')).toBeNull();
  });

  it("Luady's answer is never his NO_UPDATE to a background turn", () => {
    const about = { kind: 'note' as const, id: 'n:4', label: 'Stand-up' };
    const messages = [
      chat({ id: 'a', role: 'owner', text: 'Read this', ts: '2026-11-15T10:00:00.000Z', about }),
      chat({ id: 'b', role: 'manager', text: 'NO_UPDATE', ts: '2026-11-15T10:00:01.000Z' }),
      chat({ id: 'c', role: 'manager', text: 'Read it: ship the fee fix first.', ts: '2026-11-15T10:00:02.000Z' }),
    ];
    expect(luadyAnswer(messages, 'n:4')?.answer?.id).toBe('c');
  });

  it('a new note needs text; title, project and discuss only when given', () => {
    expect(newNoteBody({ title: '', project: '', body: '  ' }, false)).toBe('Paste or type the note first.');
    expect(newNoteBody({ title: '', project: '', body: 'Stand-up' }, false)).toEqual({ body: 'Stand-up' });
    expect(newNoteBody({ title: ' Sync ', project: 'web', body: 'Text' }, true)).toEqual({ body: 'Text', title: 'Sync', project: 'web', discuss: true });
    expect(newNoteBody({ title: '', project: 'p'.repeat(61), body: 'Text' }, false)).toMatch(/project/);
  });
});
