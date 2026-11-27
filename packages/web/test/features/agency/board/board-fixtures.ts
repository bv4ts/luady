import type { BoardEventDTO, BoardItemDTO, MissionDTO, NoteDTO } from '@luady/shared';

/** Fixtures for the board, notes and give tests. */
export const AT = '2026-11-15T09:00:00.000Z';
export const NOW = Date.parse('2026-11-15T12:00:00.000Z');

export function card(id: number, over: Partial<BoardItemDTO> = {}): BoardItemDTO {
  return {
    id, title: `Card ${String(id)}`, details: '', project: null, server: null, source: 'web', sourceRef: null, state: 'open', today: false,
    priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: AT, updatedAt: AT, doneAt: null, dueAt: null,
    snoozeUntil: null, ...over,
  };
}

export function mission(sessionId: string, over: Partial<MissionDTO> = {}): MissionDTO {
  return {
    sessionId, label: sessionId, title: 'Payroll export', phase: 'working', turns: 3, note: 'Change the date format.', lastText: 'Both files done.',
    openedAt: AT, idleSince: null, ...over,
  };
}

export function boardEvent(id: number, itemId: number, kind: BoardEventDTO['kind'], text: string): BoardEventDTO {
  return { id, itemId, at: AT, kind, text };
}

export function note(id: string, over: Partial<NoteDTO> = {}): NoteDTO {
  return {
    id, kind: id.startsWith('m:') ? 'meeting' : 'note', title: `Note ${id}`, at: AT, project: null, people: null, gist: null,
    summary: 'What happened.', actionItems: null, ownerNotes: null, link: null, hasTranscript: false, editable: id.startsWith('n:'), ...over,
  };
}
