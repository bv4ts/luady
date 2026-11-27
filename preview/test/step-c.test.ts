import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type {
  BoardItemDTO, BoardListDTO, ChatMessageDTO, DelegateResultDTO, JiraBoardDTO, JiraIssueDetailDTO, KbListDTO, LibraryDTO, MeDTO, NoteListDTO,
} from '@luady/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPreview, type Preview } from '../main.ts';
import { authFrame, signInPreview, signedIn } from './sign-in.ts';
import { RUNNING_SESSIONS, SEED_MEETING_ID } from '../seed-step-c.ts';

const hubRequire = createRequire(new URL('../../packages/hub/package.json', import.meta.url));
const WebSocket = hubRequire('ws') as typeof import('ws').default;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await sleep(150);
    value = await read();
  }
  return value;
}

let preview: Preview;
let cookie = '';
let csrf = '';
/** The page key of the sign-in. */
let pageKey = '';

const origin = (): string => `http://localhost:${preview.port}`;
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${preview.url}${path}`, { headers: signedIn({ cookie, pageKey }) });
  return { status: res.status, body: (await res.json()) as T };
}
async function send<T>(method: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${preview.url}${path}`, {
    method, headers: { ...signedIn({ cookie, pageKey }), 'x-hub-csrf': csrf, origin: origin(), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}
async function drive(scenario: string, args: readonly string[]): Promise<string> {
  const res = await fetch(`${preview.url}/__preview/run`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `https://localhost:${preview.port}` }, body: JSON.stringify({ scenario, args }),
  });
  const body = (await res.json()) as { ok: boolean; result?: string; error?: string };
  if (!body.ok) throw new Error(body.error);
  return body.result ?? '';
}
const board = async (): Promise<BoardItemDTO[]> => (await get<BoardListDTO>('/api/board')).body.items;
const cards = async (ids: readonly number[]): Promise<BoardItemDTO[]> => (await board()).filter((c) => ids.includes(c.id));

/** Frames of one type from a website socket, until it is closed. */
function listen(type: string): { frames: Array<Record<string, unknown>>; close(): void; open: Promise<void> } {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://localhost:${preview.port}/ws`, { headers: { cookie, origin: `https://localhost:${preview.port}` } });
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    if (frame.type === type) frames.push(frame);
  });
  const open = new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(authFrame(pageKey));
      resolve();
    });
    socket.once('error', reject);
  });
  return { frames, open, close: () => socket.close() };
}

describe('cards, notes, knowledge pages and Jira in a running preview', () => {
  beforeAll(async () => {
    preview = await startPreview({ port: await freePort(), env: {} });
    await preview.ready;
    ({ cookie, pageKey } = await signInPreview(preview));
    csrf = ((await (await fetch(`${preview.url}/api/me`, { headers: signedIn({ cookie, pageKey }) })).json()) as MeDTO).csrf;
  }, 90_000);

  afterAll(async () => {
    await preview?.stop();
  });

  it('seeds cards in every lane, with running ones on live sessions', async () => {
    const items = await board();
    expect(new Set(items.map((c) => c.state))).toEqual(new Set(['open', 'running', 'review', 'done']));
    expect(items.filter((c) => c.state === 'open' && c.today && c.priority === 1)).toHaveLength(1);
    const running = items.filter((c) => c.state === 'running').map((c) => c.sessionId);
    expect(running).toEqual(expect.arrayContaining(Object.values(RUNNING_SESSIONS)));
    expect(items.filter((c) => c.state === 'done').every((c) => c.result !== null)).toBe(true);
  });

  it('seeds two typed notes and a meeting with action items', async () => {
    const notes = (await get<NoteListDTO>('/api/notes')).body.items;
    expect(notes.map((n) => n.kind).sort()).toEqual(['meeting', 'note', 'note']);
    expect(notes.find((n) => n.id === `m:${SEED_MEETING_ID}`)?.actionItems).toMatch(/delivery fee/);
  });

  it('seeds knowledge pages and copies them to the servers on Sync now', async () => {
    const pages = (await get<KbListDTO>('/api/kb')).body.items;
    expect(new Set(pages.filter((p) => !p.auto).map((p) => p.scope))).toEqual(new Set(['global', 'office', 'project']));
    expect(pages.some((p) => p.pinned)).toBe(true);
    expect(pages.some((p) => /[؀-ۿ]/.test(p.title))).toBe(true);
    expect((await send('POST', '/api/kb/sync', { server: 'birch' })).status).toBe(200);
    const files = preview.fleet.kit('birch').kbFiles();
    expect(files.get('INDEX.md')).toMatch(/How we work/);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['global/how-we-work.md']));
    expect([...files.keys()].some((path) => path.startsWith('app-backend/'))).toBe(true);
    expect([...files.keys()].some((path) => path.startsWith('harbor-web-app/'))).toBe(false);
  });

  it('lists each office\'s skills in the Library', async () => {
    const library = await until(async () => (await get<LibraryDTO>('/api/library')).body, (l) => l.offices.every((o) => o.skills !== null), 10_000);
    expect(library.offices.find((o) => o.server === 'birch')?.skills?.map((s) => s.name)).toContain('jira-ticket');
    expect(library.managerSkills.map((s) => s.name)).toEqual(expect.arrayContaining(['board', 'cc-prompt']));
  });

  it('shows Orchard\'s Jira board at once; a ticket moves, gets a comment and becomes a card', async () => {
    const jira = (await get<JiraBoardDTO>('/api/jira/birch/board?view=sprint')).body;
    expect(jira.sprint?.name).toBe('Sprint 42 · Checkout');
    expect(jira.issues).toHaveLength(12);
    const moved = await send<JiraIssueDetailDTO>('POST', '/api/jira/birch/issues/ORC-1126/transition', { transitionId: '21' });
    expect(moved.body.status.name).toBe('In Progress');
    const commented = await send<JiraIssueDetailDTO>('POST', '/api/jira/birch/issues/ORC-1126/comment', { text: 'Starting now.' });
    expect(commented.body.comments.at(-1)?.bodyMd).toBe('Starting now.');
    const started = await send<DelegateResultDTO>('POST', '/api/delegate', { what: [{ kind: 'jira', server: 'birch', key: 'ORC-1126' }], to: { kind: 'auto' } });
    expect(started.status).toBe(200);
    expect(started.body.items[0]).toMatchObject({ source: 'jira', sourceRef: 'birch:ORC-1126', state: 'queued', server: 'birch' });
  });

  it('jira-off shows the connect form state; jira-on brings the board back', async () => {
    await drive('jira-off', []);
    const off = await get<{ error: { code: string } }>('/api/jira/birch/board?view=sprint');
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('jira_not_connected');
    await drive('jira-on', []);
    expect((await get<JiraBoardDTO>('/api/jira/birch/board?view=sprint')).status).toBe(200);
  });

  it('Run: Luady starts a session for the cards, and its reports tick them done', async () => {
    const a = (await send<BoardItemDTO>('POST', '/api/board', { title: 'Round the totals', project: 'orders-api', server: 'birch' })).body;
    const b = (await send<BoardItemDTO>('POST', '/api/board', { title: 'Log failed payments', project: 'orders-api', server: 'birch' })).body;
    const run = await send<DelegateResultDTO>('POST', '/api/delegate', { what: [{ kind: 'todo', id: a.id }, { kind: 'todo', id: b.id }], to: { kind: 'auto' } });
    expect(run.body.items.map((c) => c.state)).toEqual(['queued', 'queued']);
    const linked = await until(() => cards([a.id, b.id]), (list) => list.every((c) => c.state === 'running' && c.sessionId !== null), 20_000);
    expect(new Set(linked.map((c) => c.sessionId)).size).toBe(1);
    const done = await until(() => cards([a.id, b.id]), (list) => list.every((c) => c.state === 'done'), 30_000);
    expect(done.sort((x, y) => x.id - y.id).map((c) => c.result)).toEqual([
      'Round the totals: changed and tested in the preview.', 'Log failed payments: changed and tested in the preview.',
    ]);
  }, 60_000);

  it('Give to an idle session: the cards go to that session', async () => {
    const c = (await send<BoardItemDTO>('POST', '/api/board', { title: 'Tidy the store desk', project: 'store-desk', server: 'birch' })).body;
    await send('POST', '/api/delegate', { what: [{ kind: 'todo', id: c.id }], to: { kind: 'session', id: 'birch:cc-store-desk:0.0' } });
    const [linked] = await until(() => cards([c.id]), (list) => list[0]?.state === 'running', 20_000);
    expect(linked?.sessionId).toBe('birch:cc-store-desk:0.0');
    await until(() => cards([c.id]), (list) => list[0]?.state === 'done', 20_000);
  }, 45_000);

  it('say and report reach a website socket as session.said; card adds a card', async () => {
    const said = listen('session.said');
    await said.open;
    await drive('say', ['cedar/meadow-hr', 'Payroll', 'is', 'ready.']);
    await drive('report', ['cedar/meadow-hr', 'Exported to the share.']);
    await until(async () => said.frames.length, (n) => n >= 2, 5_000);
    said.close();
    expect(said.frames.map((f) => [f.kind, f.text, f.sessionId])).toEqual([
      ['reply', 'Payroll is ready.', 'cedar:cc-meadow-hr:0.0'], ['report', 'Exported to the share.', 'cedar:cc-meadow-hr:0.0'],
    ]);
    const result = await drive('card', ['Call', 'the', 'bank']);
    const id = Number(/#(\d+)/.exec(result)?.[1]);
    expect((await cards([id]))[0]).toMatchObject({ title: 'Call the bank', state: 'open', source: 'web' });
  });

  it('a note sent to Luady gets his answer and a follow-up card from the note', async () => {
    const note = await send<{ id: string }>('POST', '/api/notes', { title: 'Weekly sync', body: 'We agreed to ship the fee fix first.', discuss: true });
    expect(note.status).toBe(200);
    const thread = await until(
      async () => (await get<{ items: ChatMessageDTO[] }>('/api/manager/messages?limit=20')).body.items,
      (items) => items.some((m) => m.role === 'manager' && m.text.startsWith('I read "Weekly sync"')), 15_000,
    );
    expect(thread.find((m) => m.role === 'owner' && m.about?.kind === 'note')?.about?.id).toBe(note.body.id);
    const followUp = await until(board, (items) => items.some((c) => c.sourceRef === note.body.id), 5_000);
    expect(followUp.find((c) => c.sourceRef === note.body.id)).toMatchObject({ source: 'note', title: 'Follow up on "Weekly sync"' });
  }, 30_000);

  it('luady-say puts Luady\'s answer in the chat', async () => {
    await drive('luady-say', ['Three', 'cards', 'are', 'done.']);
    const items = await until(
      async () => (await get<{ items: ChatMessageDTO[] }>('/api/manager/messages?limit=5')).body.items,
      (list) => list.some((m) => m.text === 'Three cards are done.'), 10_000,
    );
    expect(items.at(-1)).toMatchObject({ role: 'manager', text: 'Three cards are done.' });
  });
});
