import type { LuadyApi } from '../../src/api/client.js';

/** Route cases for the board, notes, kb, jira and said API modules, shared with client.test.ts. */
export interface StepCRouteCase { name: string; call: (api: LuadyApi) => Promise<unknown>; method: string; url: string; body?: unknown; response: unknown }

const AT = '2026-11-15T09:00:00.000Z';
const PIN = '123456';
export const CARD = {
  id: 12, title: 'Fix the checkout total', details: '', project: 'orchard', server: 'birch', source: 'web', sourceRef: null, state: 'open',
  today: false, priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: AT, updatedAt: AT, doneAt: null,
  dueAt: null, snoozeUntil: null,
};
const MISSION = { sessionId: 'birch:a', label: 'birch · a', title: 'x', phase: 'idle', turns: 0, note: null, lastText: null, openedAt: AT, idleSince: AT };
const NOTE = {
  id: 'n:4', kind: 'note', title: 'Stand-up', at: AT, project: null, people: null, gist: null, summary: 'Login done', actionItems: null,
  ownerNotes: null, link: null, hasTranscript: false, editable: true,
};
const PAGE = {
  id: 3, scope: 'global', server: null, project: null, slug: 'rules', title: 'Rules', tags: [], pinned: false, auto: false, size: 7,
  updatedAt: AT, updatedBy: 'owner', body: 'Be kind',
};
const SITE = {
  server: 'birch', baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', displayName: null, connectedAt: AT, lastOkAt: AT,
  lastError: null, attention: null,
};
const TICKET = {
  key: 'ORC-123', summary: 'Login fails', type: 'Bug', status: { name: 'To Do', category: 'todo' }, priority: null, labels: [], updatedAt: AT,
  sprint: null, parent: null, flagged: false, hasNews: false, url: 'https://orchard-demo.atlassian.net/browse/ORC-123', descriptionMd: '',
  reporter: null, assignee: null, createdAt: AT, dueDate: null, comments: [], transitions: [], subtasks: [],
};
const CONNECT = { baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', token: 'test-token-0abcdef', pin: PIN };

export const STEP_C_CASES: StepCRouteCase[] = [
  { name: 'board', call: (a) => a.board(), method: 'GET', url: '/api/board', response: { items: [CARD] } },
  { name: 'createCard', call: (a) => a.createCard({ title: 'Buy milk' }), method: 'POST', url: '/api/board', body: { title: 'Buy milk' }, response: CARD },
  { name: 'card', call: (a) => a.card(12), method: 'GET', url: '/api/board/12', response: { item: CARD, events: [], mission: null } },
  { name: 'updateCard', call: (a) => a.updateCard(12, { state: 'done' }), method: 'PUT', url: '/api/board/12', body: { state: 'done' }, response: CARD },
  { name: 'deleteCard', call: (a) => a.deleteCard(12), method: 'POST', url: '/api/board/12/delete', body: {}, response: { ok: true } },
  {
    name: 'delegate', call: (a) => a.delegate({ what: [{ kind: 'todo', id: 12 }], to: { kind: 'auto' } }), method: 'POST', url: '/api/delegate',
    body: { what: [{ kind: 'todo', id: 12 }], to: { kind: 'auto' } }, response: { runId: 'r_1', items: [CARD], manager: 'sent' },
  },
  { name: 'missions', call: (a) => a.missions(), method: 'GET', url: '/api/missions', response: { items: [MISSION] } },
  { name: 'notes', call: (a) => a.notes({ query: 'stand-up', limit: 20 }), method: 'GET', url: '/api/notes?query=stand-up&limit=20', response: { items: [NOTE] } },
  { name: 'note', call: (a) => a.note('m:abc'), method: 'GET', url: '/api/notes/m%3Aabc', response: NOTE },
  { name: 'createNote', call: (a) => a.createNote({ body: 'Login done', discuss: true }), method: 'POST', url: '/api/notes', body: { body: 'Login done', discuss: true }, response: NOTE },
  { name: 'updateNote', call: (a) => a.updateNote('n:4', { project: null }), method: 'PUT', url: '/api/notes/n%3A4', body: { project: null }, response: NOTE },
  { name: 'deleteNote', call: (a) => a.deleteNote('n:4'), method: 'POST', url: '/api/notes/n%3A4/delete', body: {}, response: { ok: true } },
  { name: 'markNoteOpened', call: (a) => a.markNoteOpened('m:abc'), method: 'POST', url: '/api/notes/m%3Aabc/opened', body: {}, response: { ok: true } },
  { name: 'noteTranscript', call: (a) => a.noteTranscript('m:abc', 12000), method: 'GET', url: '/api/notes/m%3Aabc/transcript?start=12000', response: { text: 'Hi', nextStart: null } },
  { name: 'kbPages', call: (a) => a.kbPages({ scope: 'project', server: 'birch', project: 'orchard' }), method: 'GET', url: '/api/kb?scope=project&server=birch&project=orchard', response: { items: [PAGE], syncedAt: {} } },
  { name: 'kbPage', call: (a) => a.kbPage(3), method: 'GET', url: '/api/kb/3', response: PAGE },
  { name: 'createKbPage', call: (a) => a.createKbPage({ scope: 'global', title: 'Rules', body: 'Be kind' }), method: 'POST', url: '/api/kb', body: { scope: 'global', title: 'Rules', body: 'Be kind' }, response: PAGE },
  { name: 'updateKbPage', call: (a) => a.updateKbPage(3, { pinned: true }), method: 'PUT', url: '/api/kb/3', body: { pinned: true }, response: PAGE },
  { name: 'deleteKbPage', call: (a) => a.deleteKbPage(3), method: 'POST', url: '/api/kb/3/delete', body: {}, response: { ok: true } },
  { name: 'syncKb', call: (a) => a.syncKb('ash'), method: 'POST', url: '/api/kb/sync', body: { server: 'ash' }, response: { ok: true } },
  { name: 'library', call: (a) => a.library(), method: 'GET', url: '/api/library', response: { offices: [], managerSkills: [] } },
  { name: 'refreshLibrary', call: (a) => a.refreshLibrary(), method: 'POST', url: '/api/library/refresh', body: {}, response: { ok: true } },
  { name: 'jiraSites', call: (a) => a.jiraSites(), method: 'GET', url: '/api/jira', response: { sites: [SITE] } },
  { name: 'connectJira', call: (a) => a.connectJira('birch', CONNECT), method: 'PUT', url: '/api/jira/birch/connection', body: CONNECT, response: SITE },
  { name: 'disconnectJira', call: (a) => a.disconnectJira('birch', PIN), method: 'POST', url: '/api/jira/birch/disconnect', body: { pin: PIN }, response: { ok: true } },
  {
    name: 'jiraBoard', call: (a) => a.jiraBoard('birch', 'attention', true), method: 'GET', url: '/api/jira/birch/board?view=attention&refresh=1',
    response: { view: 'attention', issues: [], columns: [], sprint: null, fetchedAt: AT },
  },
  { name: 'jiraIssue', call: (a) => a.jiraIssue('birch', 'ORC-123'), method: 'GET', url: '/api/jira/birch/issues/ORC-123', response: TICKET },
  { name: 'transitionJira', call: (a) => a.transitionJira('birch', 'ORC-123', '31'), method: 'POST', url: '/api/jira/birch/issues/ORC-123/transition', body: { transitionId: '31' }, response: TICKET },
  { name: 'commentJira', call: (a) => a.commentJira('birch', 'ORC-123', 'On it'), method: 'POST', url: '/api/jira/birch/issues/ORC-123/comment', body: { text: 'On it' }, response: TICKET },
  { name: 'editJira', call: (a) => a.editJira('birch', 'ORC-123', { summary: 'New' }), method: 'PUT', url: '/api/jira/birch/issues/ORC-123', body: { summary: 'New' }, response: TICKET },
  { name: 'assignJira', call: (a) => a.assignJira('birch', 'ORC-123', true), method: 'POST', url: '/api/jira/birch/issues/ORC-123/assign', body: { me: true }, response: TICKET },
  { name: 'said', call: (a) => a.said(), method: 'GET', url: '/api/said', response: { items: [] } },
  {
    name: 'sendToLuady (about)', call: (a) => a.sendToLuady({ text: 'Start this', about: { kind: 'jira', id: 'birch:ORC-123' } }), method: 'POST',
    url: '/api/manager/messages', body: { text: 'Start this', about: { kind: 'jira', id: 'birch:ORC-123' } }, response: { ok: true },
  },
];
