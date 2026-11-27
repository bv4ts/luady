import { describe, expect, it } from 'vitest';
import {
  JIRA_KEY_RE,
  JIRA_SITE_RE,
  JiraAssignBodySchema,
  JiraBoardDTOSchema,
  JiraColumnDTOSchema,
  JiraCommentBodySchema,
  JiraConnectBodySchema,
  JiraDisconnectBodySchema,
  JiraEditBodySchema,
  JiraIssueDTOSchema,
  JiraIssueDetailDTOSchema,
  JiraSiteDTOSchema,
  JiraSitesDTOSchema,
  JiraTransitionBodySchema,
  isJiraSiteUrl,
} from '../src/jira.js';

const AT = '2026-11-15T09:00:00.000Z';
const issue = {
  key: 'ORC-123', summary: 'Login fails on Safari', type: 'Bug', status: { name: 'In Progress', category: 'doing' }, priority: 'High',
  labels: ['web'], updatedAt: AT, sprint: 'Sprint 42', parent: { key: 'ORC-100', summary: 'Auth' }, flagged: false, hasNews: true,
  url: 'https://orchard-demo.atlassian.net/browse/ORC-123',
};
const site = {
  server: 'birch', baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', displayName: 'Owner', connectedAt: AT,
  lastOkAt: AT, lastError: null, attention: 3,
};

describe('JIRA_KEY_RE', () => {
  it.each(['ORC-1', 'ORC-123', 'AB_C2-9999999', 'X1-42'])('accepts %s', (key) => {
    expect(JIRA_KEY_RE.test(key)).toBe(true);
  });

  it.each(['orc-123', 'F-1', 'ORC123', 'ORC-', 'ORC-12345678', '1S-2', 'ORC-1 ', 'ABCDEFGHIJKLMNOPQRSTU-1'])('rejects %s', (key) => {
    expect(JIRA_KEY_RE.test(key)).toBe(false);
  });
});

describe('isJiraSiteUrl', () => {
  it.each(['https://orchard-demo.atlassian.net', 'https://meadow-demo-2.atlassian.net/', 'https://harbor-demo2.atlassian.net'])('accepts %s', (url) => {
    expect(isJiraSiteUrl(url)).toBe(true);
    expect(JIRA_SITE_RE.test(url)).toBe(true);
  });

  it.each([
    'http://orchard-demo.atlassian.net',
    'https://orchard-demo.atlassian.net.evil.com',
    'https://evil.com/orchard-demo.atlassian.net',
    'https://a.b.atlassian.net',
    'https://orchard-demo.atlassian.net/jira',
    'https://Orchard-Demo.atlassian.net',
    'https://orchard-demo.atlassian.net:8443',
    'https://user@orchard-demo.atlassian.net',
    'https://api.atlassian.com',
    ' https://orchard-demo.atlassian.net',
  ])('rejects %s', (url) => {
    expect(isJiraSiteUrl(url)).toBe(false);
  });
});

describe('Jira DTOs', () => {
  it('parses sites, an issue, a column, a board and a detail', () => {
    expect(JiraSiteDTOSchema.parse(site)).toEqual(site);
    expect(JiraSitesDTOSchema.parse({ sites: [site] }).sites).toHaveLength(1);
    expect(JiraIssueDTOSchema.parse(issue)).toEqual(issue);
    const column = { name: 'In Progress', category: 'doing', keys: ['ORC-123'] };
    expect(JiraColumnDTOSchema.parse(column)).toEqual(column);
    const board = { view: 'sprint', issues: [issue], columns: [column], sprint: { name: 'Sprint 42', endsAt: null }, fetchedAt: AT };
    expect(JiraBoardDTOSchema.parse(board)).toEqual(board);
    const detail = {
      ...issue, descriptionMd: '**Steps**', reporter: 'Sara', assignee: 'Owner', createdAt: AT, dueDate: null,
      comments: [{ id: '1001', author: 'Sara', at: AT, bodyMd: 'Seen on iOS too' }],
      transitions: [{ id: '31', name: 'Done', to: 'Done' }], subtasks: [{ key: 'ORC-124', summary: 'Test', status: 'To Do' }],
    };
    expect(JiraIssueDetailDTOSchema.parse(detail)).toEqual(detail);
  });

  it('rejects a bad key, an unknown category, an unknown view and a link that is not https', () => {
    expect(JiraIssueDTOSchema.safeParse({ ...issue, key: 'orc-1' }).success).toBe(false);
    expect(JiraIssueDTOSchema.safeParse({ ...issue, status: { name: 'x', category: 'blocked' } }).success).toBe(false);
    expect(JiraIssueDTOSchema.safeParse({ ...issue, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(JiraBoardDTOSchema.safeParse({ view: 'all', issues: [], columns: [], sprint: null, fetchedAt: AT }).success).toBe(false);
    expect(JiraSiteDTOSchema.safeParse({ ...site, server: 'Not A Room' }).success).toBe(false);
  });
});

describe('Jira bodies', () => {
  const connect = { baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', token: 'test-token-0abc', pin: '123456' };

  it('JiraConnectBodySchema accepts a sign-in', () => {
    expect(JiraConnectBodySchema.parse(connect)).toEqual(connect);
  });

  it.each([
    ['another host', { baseUrl: 'https://evil.example.com' }],
    ['a 7-character token', { token: 'x'.repeat(7) }],
    ['a 601-character token', { token: 'x'.repeat(601) }],
    ['a 201-character e-mail', { email: `${'x'.repeat(190)}@example.com` }],
    ['no PIN', { pin: undefined }],
    ['a bad PIN', { pin: '12' }],
    ['an unknown key', { cloudId: 'abc' }],
  ])('JiraConnectBodySchema rejects %s', (_label, patch) => {
    expect(JiraConnectBodySchema.safeParse({ ...connect, ...patch }).success).toBe(false);
  });

  it('the write bodies keep to their limits and reject unknown keys', () => {
    expect(JiraDisconnectBodySchema.parse({ pin: '123456' })).toEqual({ pin: '123456' });
    expect(JiraTransitionBodySchema.parse({ transitionId: '31' })).toEqual({ transitionId: '31' });
    expect(JiraTransitionBodySchema.safeParse({ transitionId: '' }).success).toBe(false);
    expect(JiraCommentBodySchema.parse({ text: 'On it' })).toEqual({ text: 'On it' });
    expect(JiraCommentBodySchema.safeParse({ text: '' }).success).toBe(false);
    expect(JiraCommentBodySchema.safeParse({ text: 'x'.repeat(8001) }).success).toBe(false);
    expect(JiraEditBodySchema.parse({ summary: 'New', labels: ['web'] })).toEqual({ summary: 'New', labels: ['web'] });
    expect(JiraEditBodySchema.safeParse({ summary: 'x'.repeat(256) }).success).toBe(false);
    expect(JiraEditBodySchema.safeParse({ description: 'x'.repeat(20001) }).success).toBe(false);
    expect(JiraEditBodySchema.safeParse({ status: 'Done' }).success).toBe(false);
    expect(JiraAssignBodySchema.parse({ me: false })).toEqual({ me: false });
    expect(JiraAssignBodySchema.safeParse({ me: 'yes' }).success).toBe(false);
  });
});
