import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JiraBoardDTOSchema, JiraIssueDetailDTOSchema, JiraSitesDTOSchema } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { JiraNotConnectedError, RefusedError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { ATTENTION_TICK_MS, createJiraService } from '../../src/jira/index.js';
import { JIRA_MESSAGES } from '../../src/jira/errors.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { classicOfficeName } from '../helpers/classic-rooms.js';
import { AUTH, CLOUD_ID, EMAIL, FLAGGED_FIELD, GATEWAY, SITE, SPRINT_FIELD, TOKEN, createFakeJira, issue, type FakeJiraOptions } from './fake-jira.js';

const SECRET = 'k'.repeat(64);
const CONNECT = { baseUrl: SITE, email: EMAIL, token: TOKEN };

function setup(opts: FakeJiraOptions = {}, extra: { log?: ReturnType<typeof silentLogger>; clientsPresent?: () => boolean } = {}) {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock('2026-11-15T09:00:00.000Z');
  const jira = createFakeJira(opts);
  const events: string[] = [];
  bus.on('jira.changed', (e) => events.push(`jira:${e.room}`));
  bus.on('accounts.changed', () => events.push('accounts'));
  const service = createJiraService({
    db, bus, clock, log: extra.log ?? silentLogger(), secret: SECRET, fetch: jira.fetch, timeoutMs: 50, clientsPresent: extra.clientsPresent,
    officeName: classicOfficeName,
  });
  return { db, bus, clock, jira, service, events };
}

const searches = (jira: ReturnType<typeof createFakeJira>) => jira.calls.filter((c) => c.url.includes('/search/jql'));

afterEach(() => {
  vi.useRealTimers();
});

describe('connecting', () => {
  it('checks the sign-in, seals the token and answers a site row without it', async () => {
    const t = setup();
    const site = await t.service.connect('birch', CONNECT);
    expect(site).toMatchObject({ server: 'birch', baseUrl: SITE, email: EMAIL, displayName: 'Owner', lastError: null, attention: null });
    expect(JSON.stringify(site)).not.toContain(TOKEN);
    const row = t.db.prepare('SELECT token_enc, cloud_id, account_id FROM jira_sites').get() as { token_enc: string; cloud_id: string | null; account_id: string };
    expect(row.token_enc).not.toContain(TOKEN);
    expect(row).toMatchObject({ cloud_id: null, account_id: 'acc-1' });
    expect(JiraSitesDTOSchema.parse(t.service.sites()).sites).toHaveLength(1);
    expect(JSON.stringify(t.service.sites())).not.toContain(TOKEN);
    expect(t.events).toEqual(['jira:birch', 'accounts']);
  });

  it('remembers the gateway form for a scoped token', async () => {
    const t = setup({ mode: 'scoped' });
    await t.service.connect('birch', CONNECT);
    expect((t.db.prepare('SELECT cloud_id FROM jira_sites').get() as { cloud_id: string }).cloud_id).toBe(CLOUD_ID);
    t.jira.calls.length = 0;
    await t.service.board('birch', 'mine', false);
    expect(t.jira.calls.every((c) => c.url.startsWith(GATEWAY))).toBe(true);
  });

  it('a refused token stores nothing and says why in plain words', async () => {
    const t = setup({ mode: 'refused' });
    await expect(t.service.connect('birch', CONNECT)).rejects.toThrow(JIRA_MESSAGES.auth);
    expect(t.service.sites()).toEqual({ sites: [] });
  });

  it('refuses another host without a request', async () => {
    const t = setup();
    await expect(t.service.connect('birch', { ...CONNECT, baseUrl: 'https://evil.example.com' })).rejects.toThrow('atlassian.net');
    expect(t.jira.calls).toHaveLength(0);
  });

  it('disconnects', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    await t.service.disconnect('birch');
    expect(t.service.sites()).toEqual({ sites: [] });
    await expect(t.service.board('birch', 'sprint', false)).rejects.toBeInstanceOf(JiraNotConnectedError);
  });
});

describe('the board', () => {
  const statuses = [
    issue('ORC-1', { status: { name: 'Done', statusCategory: { key: 'done' } } }),
    issue('ORC-2', { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }),
    issue('ORC-3', { status: { name: 'To Do', statusCategory: { key: 'new' } } }),
    issue('ORC-4', { status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } }),
  ];

  it('without a connection answers jira_not_connected', async () => {
    const t = setup();
    await expect(t.service.board('birch', 'sprint', false)).rejects.toMatchObject({ code: 'jira_not_connected' });
    await expect(t.service.issue('birch', 'ORC-1', { seen: true })).rejects.toBeInstanceOf(JiraNotConnectedError);
  });

  it('my sprint: columns ordered to-do, in progress, done; the sprint name and end', async () => {
    const t = setup({ issues: statuses });
    await t.service.connect('birch', CONNECT);
    const board = JiraBoardDTOSchema.parse(await t.service.board('birch', 'sprint', false));
    expect(board.view).toBe('sprint');
    expect(board.columns.map((c) => [c.name, c.keys])).toEqual([
      ['To Do', ['ORC-3']], ['In Progress', ['ORC-2']], ['In Review', ['ORC-4']], ['Done', ['ORC-1']],
    ]);
    expect(board.sprint).toEqual({ name: 'Sprint 7', endsAt: '2026-11-20T12:00:00.000Z' });
    expect(board.issues[0]).toMatchObject({ key: 'ORC-1', sprint: 'Sprint 7', url: `${SITE}/browse/ORC-1`, updatedAt: '2026-11-15T08:00:00.000Z' });
    const search = new URL(searches(t.jira)[0]!.url);
    expect(search.searchParams.get('jql')).toBe('assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC');
    expect(search.searchParams.get('fields')).toBe(`summary,status,issuetype,priority,labels,updated,parent,${SPRINT_FIELD},${FLAGGED_FIELD}`);
  });

  it('an empty sprint falls back to All mine', async () => {
    const t = setup({ sprintIssues: [] });
    await t.service.connect('birch', CONNECT);
    const board = await t.service.board('birch', 'sprint', false);
    expect(board.view).toBe('mine');
    expect(board.sprint).toBeNull();
    expect(board.issues.map((i) => i.key)).toEqual(['ORC-1', 'ORC-2']);
    expect(new URL(searches(t.jira)[1]!.url).searchParams.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  });

  it('keeps a view 60 seconds; refresh fetches again; the field list is read once', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    await t.service.board('birch', 'mine', false);
    await t.service.board('birch', 'mine', false);
    expect(searches(t.jira)).toHaveLength(1);
    await t.service.board('birch', 'mine', true);
    expect(searches(t.jira)).toHaveLength(2);
    t.clock.advance(61_000);
    const later = await t.service.board('birch', 'mine', false);
    expect(searches(t.jira)).toHaveLength(3);
    expect(later.fetchedAt).toBe('2026-11-15T09:01:01.000Z');
    expect(t.jira.calls.filter((c) => c.url.endsWith('/rest/api/3/field'))).toHaveLength(1);
  });

  it('hasNews: changed after the connection and not opened since; opening marks it seen', async () => {
    const t = setup({ issues: [issue('ORC-1', { updated: '2026-11-15T10:00:00.000+0000' }), issue('ORC-2')] });
    await t.service.connect('birch', CONNECT);
    const before = await t.service.board('birch', 'mine', false);
    expect(before.issues.map((i) => [i.key, i.hasNews])).toEqual([['ORC-1', true], ['ORC-2', false]]);
    t.clock.set('2026-11-15T10:30:00.000Z');
    const opened = JiraIssueDetailDTOSchema.parse(await t.service.issue('birch', 'ORC-1', { seen: true }));
    expect(opened.hasNews).toBe(false);
    expect((await t.service.board('birch', 'mine', false)).issues[0]?.hasNews).toBe(false);
  });

  it('needs attention: flagged, high priority or changed; the count reaches the site row', async () => {
    const t = setup({ issues: [
      issue('ORC-1', { [FLAGGED_FIELD]: [{ value: 'Impediment' }] }),
      issue('ORC-2', { priority: { name: 'Highest' } }),
      issue('ORC-3', { updated: '2026-11-15T10:00:00.000+0000' }),
      issue('ORC-4'),
    ] });
    await t.service.connect('birch', CONNECT);
    const board = await t.service.board('birch', 'attention', false);
    expect(board.view).toBe('attention');
    expect(board.issues.map((i) => i.key)).toEqual(['ORC-1', 'ORC-2', 'ORC-3']);
    expect(board.issues[0]?.flagged).toBe(true);
    expect(t.service.sites().sites[0]?.attention).toBe(3);
  });

  it('a failing call is recorded on the site row in plain words', async () => {
    const t = setup({ fail: { path: '/rest/api/3/search/jql', status: 503 } });
    await t.service.connect('birch', CONNECT);
    await expect(t.service.board('birch', 'mine', false)).rejects.toThrow(JIRA_MESSAGES.server);
    expect(t.service.sites().sites[0]?.lastError).toBe(JIRA_MESSAGES.server);
  });
});

describe('a ticket', () => {
  it('opens with the description, comments, people, sub-tasks and moves', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    const ticket = await t.service.issue('birch', 'ORC-1', { seen: false });
    expect(ticket).toMatchObject({
      key: 'ORC-1', descriptionMd: 'The login button fails.', reporter: 'Sara', assignee: 'Owner', dueDate: '2026-11-21',
      comments: [{ id: '7', author: 'Sara', at: '2026-11-12T08:00:00.000Z', bodyMd: '**Seen on Safari**' }],
      subtasks: [{ key: 'ORC-9', summary: 'Write the test', status: 'To Do' }],
    });
    expect(ticket.transitions[0]).toEqual({ id: '11', name: 'Start progress', to: 'In Progress' });
  });

  it('moves, comments, edits and assigns with the right requests, answering the fresh ticket', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    t.events.length = 0;
    await t.service.transition('birch', 'ORC-1', '21');
    await t.service.comment('birch', 'ORC-1', 'On it\nnow');
    await t.service.edit('birch', 'ORC-1', { summary: 'New title', description: 'Line', priority: 'High', labels: ['web app'] });
    await t.service.assign('birch', 'ORC-1', true);
    const fresh = await t.service.assign('birch', 'ORC-1', false);
    expect(fresh.key).toBe('ORC-1');
    const writes = t.jira.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, new URL(c.url).pathname, c.body]);
    expect(writes).toEqual([
      ['POST', '/rest/api/3/issue/ORC-1/transitions', { transition: { id: '21' } }],
      ['POST', '/rest/api/3/issue/ORC-1/comment', { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'On it' }, { type: 'hardBreak' }, { type: 'text', text: 'now' }] }] } }],
      ['PUT', '/rest/api/3/issue/ORC-1', { fields: { summary: 'New title', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Line' }] }] }, priority: { name: 'High' }, labels: ['web_app'] } }],
      ['PUT', '/rest/api/3/issue/ORC-1/assignee', { accountId: 'acc-1' }],
      ['PUT', '/rest/api/3/issue/ORC-1/assignee', { accountId: null }],
    ]);
    expect(t.events.filter((e) => e === 'jira:birch').length).toBeGreaterThanOrEqual(5);
  });

  it('a write drops the cached boards', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    await t.service.board('birch', 'mine', false);
    await t.service.comment('birch', 'ORC-1', 'x');
    await t.service.board('birch', 'mine', false);
    expect(searches(t.jira)).toHaveLength(2);
  });

  it('moveTo matches status or transition names without case; several or none list the choices', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    await t.service.moveTo('birch', 'ORC-1', 'in progress');
    expect(t.jira.calls.find((c) => c.method === 'POST')?.body).toEqual({ transition: { id: '11' } });
    await expect(t.service.moveTo('birch', 'ORC-1', 'In Review')).rejects.toThrow(
      '"In Review" fits more than one move on ORC-1. Choices: Send to review (to In Review), Approve (to In Review).',
    );
    await expect(t.service.moveTo('birch', 'ORC-1', 'Shipped')).rejects.toThrow('ORC-1 has no move called "Shipped". Choices: Start progress (to In Progress), Done');
  });

  it('an unknown ticket is a 404 in plain words', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    await expect(t.service.issue('birch', 'ORC-404', { seen: true })).rejects.toMatchObject({ code: 'not_found', message: JIRA_MESSAGES.notFound });
  });

  it('search by JQL for Luady', async () => {
    const t = setup();
    await t.service.connect('birch', CONNECT);
    const found = await t.service.search('birch', { jql: 'project = ORC', limit: 1 });
    expect(found.map((i) => i.key)).toEqual(['ORC-1']);
    expect(new URL(searches(t.jira)[0]!.url).searchParams.get('maxResults')).toBe('1');
  });
});

describe('pick', () => {
  it('the named office, the only one, or a question', async () => {
    const t = setup();
    expect(() => t.service.pick()).toThrow(JiraNotConnectedError);
    await t.service.connect('birch', CONNECT);
    expect(t.service.pick()).toBe('birch');
    expect(() => t.service.pick('cedar')).toThrow('Meadow');
    await t.service.connect('ash', { ...CONNECT, baseUrl: 'https://harbor-demo.atlassian.net' });
    expect(() => t.service.pick()).toThrow(RefusedError);
    expect(t.service.pick('ash')).toBe('ash');
  });
});

describe('attention refresh', () => {
  it('only while a website client is present, at most every 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let present = false;
    const t = setup({}, { clientsPresent: () => present });
    await t.service.connect('birch', CONNECT);
    t.service.start();
    await vi.advanceTimersByTimeAsync(ATTENTION_TICK_MS);
    expect(searches(t.jira)).toHaveLength(0);
    present = true;
    await vi.advanceTimersByTimeAsync(ATTENTION_TICK_MS);
    expect(searches(t.jira)).toHaveLength(1);
    t.clock.advance(2 * 60_000);
    await vi.advanceTimersByTimeAsync(ATTENTION_TICK_MS);
    expect(searches(t.jira)).toHaveLength(1);
    t.clock.advance(4 * 60_000);
    await vi.advanceTimersByTimeAsync(ATTENTION_TICK_MS);
    expect(searches(t.jira)).toHaveLength(2);
    expect(t.service.sites().sites[0]?.attention).toBe(0);
    t.service.stop();
  });
});

describe('secrets', () => {
  it('no log line and no thrown error carries the token or the Authorization header', async () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk: Buffer, _enc, done) { lines.push(chunk.toString()); done(); } });
    const log = pino({ level: 'trace' }, sink);
    const errors: unknown[] = [];
    const keep = (p: Promise<unknown>) => p.catch((err: unknown) => errors.push(err));
    const ok = setup({}, { log });
    await ok.service.connect('birch', CONNECT);
    await ok.service.board('birch', 'sprint', true);
    await keep(ok.service.issue('birch', 'ORC-404', { seen: true }));
    for (const fail of [401, 403, 400, 500]) {
      const t = setup({ fail: { path: '/rest/api/3/search/jql', status: fail, body: { errorMessages: [TOKEN, AUTH] } } }, { log });
      await t.service.connect('birch', CONNECT);
      await keep(t.service.board('birch', 'mine', true));
      await keep(t.service.search('birch', { jql: 'x', limit: 5 }));
    }
    const refused = setup({ mode: 'refused' }, { log });
    await keep(refused.service.connect('birch', CONNECT));
    const hang = setup({ mode: 'hang' }, { log });
    await keep(hang.service.connect('birch', CONNECT));
    expect(errors.length).toBeGreaterThanOrEqual(10);
    const text = [...lines, ...errors.map((e) => (e instanceof Error ? `${e.message}\n${e.stack ?? ''}\n${JSON.stringify(e)}` : String(e)))].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(AUTH.slice(6));
  });
});
