import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../packages/hub/dist/core/bus.js';
import type { Db, JiraService } from '../../packages/hub/dist/core/contracts.js';
import { openDb } from '../../packages/hub/dist/db/open.js';
import { createJiraService } from '../../packages/hub/dist/jira/index.js';
import { createLogger } from '../../packages/hub/dist/log.js';
import { createFakeJira, PREVIEW_JIRA_EMAIL, PREVIEW_JIRA_SITE, PREVIEW_JIRA_TOKEN, type FakeJira } from '../fake-jira.ts';

let dir = '';
let db: Db;
let jira: FakeJira;
let service: JiraService;
let nowMs = Date.parse('2026-11-15T08:00:00.000Z');
const clock = { now: () => new Date(nowMs) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'luady-fake-jira-'));
  db = openDb(join(dir, 'hub.db'));
  nowMs = Date.parse('2026-11-15T08:00:00.000Z');
  jira = createFakeJira({ clock: clock.now });
  service = createJiraService({
    db, bus: createBus(() => undefined), clock, log: createLogger({ level: 'silent' }), secret: 'a'.repeat(64), fetch: jira.fetch,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const connect = () => service.connect('birch', jira.connectInput);

describe('the fake Jira site through the hub\'s own Jira service', () => {
  it('signs in only with the preview token', async () => {
    await expect(service.connect('birch', { ...jira.connectInput, token: 'some-other-token-1234' })).rejects.toThrow(/refused the sign-in/i);
    const site = await connect();
    expect(site).toMatchObject({ server: 'birch', baseUrl: PREVIEW_JIRA_SITE, email: PREVIEW_JIRA_EMAIL, displayName: 'Preview Owner' });
  });

  it('answers 401 to any other sign-in and tenant_info without one', async () => {
    const bad = await jira.fetch(`${PREVIEW_JIRA_SITE}/rest/api/3/myself`, { headers: { authorization: 'Basic eDp5' } });
    expect(bad.status).toBe(401);
    const tenant = await jira.fetch(`${PREVIEW_JIRA_SITE}/_edge/tenant_info`);
    expect(await tenant.json()).toEqual({ cloudId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await expect(jira.fetch('https://example.com/rest/api/3/myself')).rejects.toThrow(/only its fake Jira/);
    expect(PREVIEW_JIRA_TOKEN).not.toMatch(/^ATATT/);
  });

  it('shows "Sprint 42 · Checkout" with a dozen tickets in the four status columns', async () => {
    await connect();
    const board = await service.board('birch', 'sprint', false);
    expect(board.view).toBe('sprint');
    expect(board.sprint?.name).toBe('Sprint 42 · Checkout');
    expect(board.issues).toHaveLength(12);
    expect(board.columns.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
    expect(board.issues.filter((i) => i.flagged).map((i) => i.key).sort()).toEqual(['ORC-1101', 'ORC-1108']);
    expect(board.issues.some((i) => i.key === 'ORC-1131')).toBe(false);
  });

  it('All mine leaves out done tickets and adds the one outside the sprint; Needs attention keeps flagged and high', async () => {
    await connect();
    const mine = await service.board('birch', 'mine', false);
    expect(mine.issues.some((i) => i.status.category === 'done')).toBe(false);
    expect(mine.issues.map((i) => i.key)).toContain('ORC-1098');
    const attention = await service.board('birch', 'attention', false);
    expect(attention.issues.map((i) => i.key).sort()).toEqual(['ORC-1101', 'ORC-1108', 'ORC-1117', 'ORC-1130']);
  });

  it('a ticket opens with its description and comments converted to Markdown', async () => {
    await connect();
    const ticket = await service.issue('birch', 'ORC-1101', { seen: true });
    expect(ticket.descriptionMd).toContain('**delivery fee**');
    expect(ticket.descriptionMd).toContain('```ts');
    expect(ticket.comments.map((c) => c.author)).toEqual(['Sara Haddad', 'Omar Khalil']);
    expect(ticket.comments[1]?.bodyMd).toContain('@Owner');
    expect(ticket.parent).toEqual({ key: 'ORC-1090', summary: 'Checkout v2' });
    expect(ticket.transitions.map((t) => t.to)).toEqual(['To Do', 'In Review', 'Done']);
    expect((await service.issue('birch', 'ORC-1112', { seen: false })).subtasks.map((s) => s.key)).toEqual(['ORC-1113', 'ORC-1114']);
  });

  it('moves, comments, edits and assigns for real', async () => {
    await connect();
    const moved = await service.transition('birch', 'ORC-1105', '21');
    expect(moved.status).toEqual({ name: 'In Progress', category: 'doing' });
    const commented = await service.comment('birch', 'ORC-1105', 'On it today.');
    expect(commented.comments.at(-1)).toMatchObject({ author: 'Preview Owner', bodyMd: 'On it today.' });
    const edited = await service.edit('birch', 'ORC-1105', { summary: 'Apple Pay merchant name', priority: 'High', labels: ['ios'] });
    expect(edited).toMatchObject({ summary: 'Apple Pay merchant name', priority: 'High', labels: ['ios'] });
    expect((await service.assign('birch', 'ORC-1105', false)).assignee).toBeNull();
    expect((await service.assign('birch', 'ORC-1105', true)).assignee).toBe('Preview Owner');
    await expect(service.transition('birch', 'ORC-1105', '21')).rejects.toThrow();
  });

  it('a teammate\'s comment after the connection gives the ticket a news dot', async () => {
    await connect();
    nowMs += 5_000;
    jira.touch('ORC-1115', 'Sara Haddad', 'Still wraps.');
    const board = await service.board('birch', 'sprint', true);
    expect(board.issues.find((i) => i.key === 'ORC-1115')?.hasNews).toBe(true);
    expect(board.issues.find((i) => i.key === 'ORC-1105')?.hasNews).toBe(false);
  });

  it('pages a search the way Jira does', async () => {
    const auth = `Basic ${Buffer.from(`${PREVIEW_JIRA_EMAIL}:${PREVIEW_JIRA_TOKEN}`).toString('base64')}`;
    const url = `${PREVIEW_JIRA_SITE}/rest/api/3/search/jql?jql=${encodeURIComponent('assignee = currentUser() AND sprint in openSprints()')}&maxResults=5`;
    const first = (await (await jira.fetch(url, { headers: { authorization: auth } })).json()) as { issues: unknown[]; nextPageToken?: string };
    expect(first.issues).toHaveLength(5);
    expect(first.nextPageToken).toBe('5');
  });
});
