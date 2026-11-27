import { describe, expect, it } from 'vitest';
import {
  TermClientMessageSchema,
  TermServerMessageSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from '../src/ws.js';

const NOW = '2026-10-09T12:00:00.000Z';
const question = {
  qid: 'ABCDEFGH',
  kind: 'question',
  host: 'cedar',
  sessionId: 'cedar:cc-meadow-hr:0.0',
  sessionLabel: 'cedar \u00b7 meadow-hr',
  questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }] }],
  permission: null,
  state: 'answered',
  createdAt: NOW,
  resolvedAt: NOW,
  resolvedVia: 'test-channel',
};

describe('WsServerMessageSchema', () => {
  it.each([
    [{ type: 'hello', now: NOW }],
    [{ type: 'session.removed', id: 'cedar:cc-old:0.0' }],
    [{ type: 'question.updated', question }],
    [{ type: 'manager.status', status: { state: 'busy', since: NOW, claudeSessionId: 'abc', queued: 2 } }],
    [
      {
        type: 'transcript.appended',
        sessionId: 'cedar:cc-x:0.0',
        items: [{ uuid: 'u1', role: 'assistant', text: 'Done', ts: null, toolName: null }],
      },
    ],
  ])('accepts %j', (msg) => {
    expect(WsServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects unknown types and malformed payloads', () => {
    expect(WsServerMessageSchema.safeParse({ type: 'session.deleted', id: 'x' }).success).toBe(false);
    const badStatus = { type: 'manager.status', status: { state: 'asleep', since: NOW, claudeSessionId: null, queued: 0 } };
    expect(WsServerMessageSchema.safeParse(badStatus).success).toBe(false);
  });
});

describe('WsClientMessageSchema', () => {
  it('accepts subscribe, unsubscribe and ping', () => {
    const subscribe = { type: 'subscribe.transcript', sessionId: 'cedar:cc-x:0.0' };
    expect(WsClientMessageSchema.parse(subscribe)).toEqual(subscribe);
    expect(WsClientMessageSchema.parse({ type: 'unsubscribe.transcript', sessionId: 'cedar:cc-x:0.0' }).type).toBe(
      'unsubscribe.transcript',
    );
    expect(WsClientMessageSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  it('rejects session ids over 160 chars and unknown types', () => {
    expect(WsClientMessageSchema.safeParse({ type: 'subscribe.transcript', sessionId: 'x'.repeat(161) }).success).toBe(false);
    expect(WsClientMessageSchema.safeParse({ type: 'shell', cmd: 'ls' }).success).toBe(false);
  });

  it('drops unknown keys (z.object strips) instead of rejecting them', () => {
    expect(WsClientMessageSchema.parse({ type: 'ping', extra: 1 })).toEqual({ type: 'ping' });
  });
});

describe('terminal messages', () => {
  it('accepts input, resize, output and exit', () => {
    expect(TermClientMessageSchema.parse({ type: 'input', data: 'ls -la\r' })).toEqual({ type: 'input', data: 'ls -la\r' });
    expect(TermClientMessageSchema.parse({ type: 'resize', cols: 120, rows: 40 })).toEqual({ type: 'resize', cols: 120, rows: 40 });
    expect(TermServerMessageSchema.parse({ type: 'output', data: '\u001b[32mok\u001b[0m' }).type).toBe('output');
    expect(TermServerMessageSchema.parse({ type: 'exit', code: null })).toEqual({ type: 'exit', code: null });
  });

  it.each([
    ['input over 64 KiB', { type: 'input', data: 'x'.repeat(65537) }],
    ['9 columns', { type: 'resize', cols: 9, rows: 24 }],
    ['201 rows', { type: 'resize', cols: 80, rows: 201 }],
    ['fractional columns', { type: 'resize', cols: 80.5, rows: 24 }],
    ['an unknown type', { type: 'paste', data: 'x' }],
  ])('rejects %s', (_label, msg) => {
    expect(TermClientMessageSchema.safeParse(msg).success).toBe(false);
  });
});

const AT = '2026-11-14T10:00:00.000Z';
const stepDto = {
  id: 'toolu_1', tool: 'Bash', kind: 'run', title: 'npm test', agentId: null, agentType: null,
  startedAt: AT, endedAt: null, ok: null, added: null, removed: null,
};
const notice = {
  id: 'n_01', kind: 'reply', text: 'Done.', ref: { kind: 'manager', id: 'm1' }, createdAt: AT,
  chatDueAt: AT, chatSentAt: null, settledAt: null, settledVia: null,
};

describe('activity, steps, notice, presence and accounts server messages', () => {
  it.each([
    [{ type: 'activity.updated', items: [{ sessionId: 'cedar:cc-x:0.0', tool: 'run', paused: false, helpers: 0, contextPct: 12, lastStepAt: AT }] }],
    [{ type: 'activity.updated', items: [] }],
    [
      {
        type: 'steps.appended',
        sessionId: 'cedar:cc-x:0.0',
        steps: [stepDto],
        todos: [{ id: '1', subject: 'Write tests', status: 'in_progress' }],
        helpers: [{ agentId: 'agent_1', agentType: 'Explore', startedAt: AT }],
      },
    ],
    [{ type: 'steps.appended', sessionId: 'cedar:cc-x:0.0', steps: [stepDto], todos: null, helpers: null }],
    [{ type: 'notice.created', notice }],
    [{ type: 'notice.updated', notice: { ...notice, settledAt: AT, settledVia: 'web' } }],
    [{ type: 'presence.updated', presence: { mode: 'chat', online: false, clients: 0, forcedUntil: null } }],
    [{ type: 'accounts.changed', at: AT }],
  ])('accepts and round-trips %j', (msg) => {
    expect(WsServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects steps.appended without the todos and helpers keys', () => {
    expect(WsServerMessageSchema.safeParse({ type: 'steps.appended', sessionId: 'cedar:cc-x:0.0', steps: [] }).success).toBe(false);
    expect(WsServerMessageSchema.safeParse({ type: 'steps.appended', sessionId: 'x', steps: [], todos: null }).success).toBe(false);
  });

  it.each([
    ['activity with a tool name instead of a kind', { type: 'activity.updated', items: [{ sessionId: 'x', tool: 'Bash', paused: false, helpers: 0, contextPct: null, lastStepAt: null }] }],
    ['a notice with an unknown kind', { type: 'notice.created', notice: { ...notice, kind: 'sms' } }],
    ['presence in mode away', { type: 'presence.updated', presence: { mode: 'away', online: false, clients: 0, forcedUntil: null } }],
    ['accounts.changed without at', { type: 'accounts.changed' }],
  ])('rejects %s', (_label, msg) => {
    expect(WsServerMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe('steps, presence and notice client messages', () => {
  it.each([
    [{ type: 'subscribe.steps', sessionId: 'cedar:cc-x:0.0' }],
    [{ type: 'unsubscribe.steps', sessionId: 'cedar:cc-x:0.0' }],
    [{ type: 'presence.hello', visible: true }],
    [{ type: 'presence.hello', visible: false }],
    [{ type: 'presence.active' }],
    [{ type: 'notice.ack', ids: ['n_01'] }],
    [{ type: 'notice.ack', ids: Array.from({ length: 50 }, (_v, i) => `n_${i}`) }],
  ])('accepts %j', (msg) => {
    expect(WsClientMessageSchema.parse(msg)).toEqual(msg);
  });

  it.each([
    ['notice.ack with 0 ids', { type: 'notice.ack', ids: [] }],
    ['notice.ack with 51 ids', { type: 'notice.ack', ids: Array.from({ length: 51 }, (_v, i) => `n_${i}`) }],
    ['notice.ack with a 65-character id', { type: 'notice.ack', ids: ['x'.repeat(65)] }],
    ['subscribe.steps with a 161-character id', { type: 'subscribe.steps', sessionId: 'x'.repeat(161) }],
    ['unsubscribe.steps without an id', { type: 'unsubscribe.steps' }],
    ['presence.hello without visible', { type: 'presence.hello' }],
  ])('rejects %s', (_label, msg) => {
    expect(WsClientMessageSchema.safeParse(msg).success).toBe(false);
  });
});
