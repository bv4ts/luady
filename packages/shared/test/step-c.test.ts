import { describe, expect, it } from 'vitest';
import { ConnectionDTOSchema } from '../src/accounts.js';
import { SessionActivityDTOSchema } from '../src/activity.js';
import { ABOUT_KINDS, ChatMessageDTOSchema, LuadySendBodySchema, SendBodySchema } from '../src/api.js';
import { CtlGitStatusSchema, CtlKbPutInputSchema, CtlKbPutSchema, CtlSkillsSchema, isKbPath } from '../src/ctl.js';
import { WsServerMessageSchema } from '../src/ws.js';
import { BOARD_ITEM as sampleItem } from './helpers.js';

const AT = '2026-11-15T09:00:00.000Z';

describe('activity gains the step title, helper types and turn start (optional)', () => {
  const old = { sessionId: 'birch:cc-x:0.0', tool: 'agent', paused: false, helpers: 2, contextPct: 40, lastStepAt: AT };

  it('parses a record from an older hub and a full one', () => {
    expect(SessionActivityDTOSchema.parse(old)).toEqual(old);
    const full = { ...old, title: 'Editing checkout.ts', helperTypes: ['Explore', 'Plan'], turnStartedAt: AT };
    expect(SessionActivityDTOSchema.parse(full)).toEqual(full);
    expect(SessionActivityDTOSchema.parse({ ...old, title: null, turnStartedAt: null }).title).toBeNull();
  });

  it('caps helper types at three', () => {
    expect(SessionActivityDTOSchema.safeParse({ ...old, helperTypes: ['a', 'b', 'c', 'd'] }).success).toBe(false);
  });
});

describe('chat with Luady about something', () => {
  it('pins the three kinds', () => {
    expect(ABOUT_KINDS).toEqual(['note', 'todo', 'jira']);
  });

  it('LuadySendBodySchema takes text with or without an about', () => {
    expect(LuadySendBodySchema.parse({ text: 'What do you think?' })).toEqual({ text: 'What do you think?' });
    const about = { text: 'Start this', about: { kind: 'jira', id: 'birch:ORC-123' } };
    expect(LuadySendBodySchema.parse(about)).toEqual(about);
  });

  it.each([
    ['an unknown kind', { text: 'x', about: { kind: 'email', id: '1' } }],
    ['a 161-character id', { text: 'x', about: { kind: 'note', id: 'x'.repeat(161) } }],
    ['an empty id', { text: 'x', about: { kind: 'note', id: '' } }],
    ['an extra key in about', { text: 'x', about: { kind: 'note', id: 'n:1', label: 'x' } }],
    ['an extra key', { text: 'x', html: '<b>' }],
    ['empty text', { text: '' }],
  ])('LuadySendBodySchema rejects %s', (_label, body) => {
    expect(LuadySendBodySchema.safeParse(body).success).toBe(false);
  });

  it('SendBodySchema (sessions) still refuses about', () => {
    expect(SendBodySchema.safeParse({ text: 'x', about: { kind: 'note', id: 'n:1' } }).success).toBe(false);
  });

  it('ChatMessageDTOSchema parses a message with and without about', () => {
    const message = { id: 'm1', thread: 'manager', role: 'owner', channel: 'web', text: 'Thoughts?', ts: AT };
    expect(ChatMessageDTOSchema.parse(message)).toEqual(message);
    const about = { ...message, about: { kind: 'note', id: 'm:abc', label: 'Weekly sync' } };
    expect(ChatMessageDTOSchema.parse(about)).toEqual(about);
    expect(ChatMessageDTOSchema.safeParse({ ...message, about: { kind: 'note', id: 'm:abc' } }).success).toBe(false);
  });
});

describe('Jira on the connections list', () => {
  it('accepts a jira row', () => {
    const row = { id: 'jira', label: 'Jira · Orchard', state: 'connected', detail: 'owner@example.com', connectUrl: null };
    expect(ConnectionDTOSchema.parse(row)).toEqual(row);
  });
});

describe('board, mission, notes and knowledge-base server messages', () => {
  const mission = {
    sessionId: 'birch:cc-x:0.0', label: 'birch · x', title: 'Checkout', phase: 'waiting', turns: 1, note: null, lastText: 'Done?', openedAt: AT, idleSince: AT,
  };

  it.each([
    [{ type: 'board.updated', items: [sampleItem] }],
    [{ type: 'board.removed', ids: [12, 13] }],
    [{ type: 'mission.updated', mission }],
    [{ type: 'mission.removed', sessionId: 'birch:cc-x:0.0', outcome: 'done', summary: 'Shipped' }],
    [{ type: 'mission.removed', sessionId: 'birch:cc-x:0.0', outcome: 'ended', summary: null }],
    [{ type: 'session.said', sessionId: 'birch:cc-x:0.0', kind: 'reply', text: 'Done.', truncated: false, at: AT }],
    [{ type: 'notes.changed', at: AT }],
    [{ type: 'kb.changed', at: AT }],
    [{ type: 'library.changed', at: AT }],
    [{ type: 'jira.changed', room: 'birch', at: AT }],
  ])('accepts and round-trips %j', (msg) => {
    expect(WsServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it.each([
    ['board.removed with string ids', { type: 'board.removed', ids: ['12'] }],
    ['mission.removed with outcome failed', { type: 'mission.removed', sessionId: 'x', outcome: 'failed', summary: null }],
    ['session.said over 1200 characters', { type: 'session.said', sessionId: 'x', kind: 'reply', text: 'x'.repeat(1201), truncated: true, at: AT }],
    ['jira.changed for a room id outside the grammar', { type: 'jira.changed', room: 'Not A Room', at: AT }],
    ['jira.changed with the old server field', { type: 'jira.changed', server: 'birch', at: AT }],
    ['notes.changed without at', { type: 'notes.changed' }],
  ])('rejects %s', (_label, msg) => {
    expect(WsServerMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe('kit 2.1 verbs', () => {
  it('skills: parses a list and caps it at 300', () => {
    const skill = { name: 'deploy', description: 'Deploy the app.', source: 'project', path: '/home/dev/projects/x/.claude/skills/deploy/SKILL.md' };
    expect(CtlSkillsSchema.parse({ skills: [skill] })).toEqual({ skills: [skill] });
    expect(CtlSkillsSchema.safeParse({ skills: Array.from({ length: 301 }, () => skill) }).success).toBe(false);
    expect(CtlSkillsSchema.safeParse({ skills: [{ ...skill, source: 'builtin' }] }).success).toBe(false);
  });

  it('kb-put: parses the counts', () => {
    expect(CtlKbPutSchema.parse({ written: 3, removed: 1 })).toEqual({ written: 3, removed: 1 });
    expect(CtlKbPutSchema.safeParse({ written: -1, removed: 0 }).success).toBe(false);
  });

  it('git-status: parses projects with and without an upstream', () => {
    const value = {
      projects: [
        { path: '/home/dev/projects/x', name: 'x', branch: 'main', dirty: true, ahead: 2, behind: 0, lastCommitAt: AT },
        { path: '/home/dev/projects/y', name: 'y', branch: null, dirty: false, ahead: null, behind: null, lastCommitAt: null },
      ],
    };
    expect(CtlGitStatusSchema.parse(value)).toEqual(value);
  });
});

describe('kb-put input', () => {
  it.each(['INDEX.md', 'global/rules.md', 'office/meadow.md', 'orchard/deploy.md', 'my.project/overview.md'])('accepts the path %s', (path) => {
    expect(isKbPath(path)).toBe(true);
  });

  it.each([
    ['an absolute path', '/home/dev/luady-kb/INDEX.md'],
    ['a parent segment', 'orchard/../../.bashrc'],
    ['a dot segment', './INDEX.md'],
    ['a hidden file', '.env.md'],
    ['a text file', 'notes.txt'],
    ['a backslash', 'orchard\\deploy.md'],
    ['an empty segment', 'orchard//deploy.md'],
    ['a NUL', 'a\0.md'],
    ['an empty path', ''],
  ])('refuses %s', (_label, path) => {
    expect(isKbPath(path)).toBe(false);
  });

  it('takes files and prune, and refuses a bad path or unknown keys', () => {
    const payload = { files: [{ path: 'INDEX.md', content: '# Index' }], prune: true };
    expect(CtlKbPutInputSchema.parse(payload)).toEqual(payload);
    expect(CtlKbPutInputSchema.safeParse({ ...payload, files: [{ path: '../x.md', content: '' }] }).success).toBe(false);
    expect(CtlKbPutInputSchema.safeParse({ ...payload, force: true }).success).toBe(false);
    expect(CtlKbPutInputSchema.safeParse({ files: [] }).success).toBe(false);
  });

  it('refuses a payload over 2 MB, counted in UTF-8 bytes', () => {
    const big = 'x'.repeat(1024 * 1024);
    expect(CtlKbPutInputSchema.safeParse({ files: [{ path: 'a.md', content: big }], prune: false }).success).toBe(true);
    expect(CtlKbPutInputSchema.safeParse({ files: [{ path: 'a.md', content: big }, { path: 'b.md', content: big }], prune: false }).success).toBe(false);
    const arabic = 'ل'.repeat(700 * 1024);
    expect(CtlKbPutInputSchema.safeParse({ files: [{ path: 'a.md', content: arabic }], prune: false }).success).toBe(true);
    expect(CtlKbPutInputSchema.safeParse({ files: [{ path: 'a.md', content: arabic }, { path: 'b.md', content: arabic }], prune: false }).success).toBe(false);
  });
});
