import { describe, expect, it } from 'vitest';
import {
  BOARD_SOURCES,
  BOARD_STATES,
  BoardEventDTOSchema,
  BoardItemDTOSchema,
  BoardItemDetailDTOSchema,
  BoardListDTOSchema,
  CreateBoardItemBodySchema,
  DelegateBodySchema,
  DelegateResultDTOSchema,
  DelegateToSchema,
  DelegateWhatSchema,
  MissionDTOSchema,
  MissionListDTOSchema,
  UpdateBoardItemBodySchema,
} from '../src/board.js';
import { BOARD_ITEM } from './helpers.js';

const AT = '2026-11-15T09:00:00.000Z';
const sampleItem = BOARD_ITEM;

const mission = {
  sessionId: 'birch:cc-orchard:0.0',
  label: 'birch · orchard',
  title: 'Checkout fixes',
  phase: 'working',
  turns: 3,
  note: 'Running the tests',
  lastText: null,
  openedAt: AT,
  idleSince: null,
};

describe('board constants', () => {
  it('pins the states and sources in order', () => {
    expect(BOARD_STATES).toEqual(['open', 'queued', 'running', 'review', 'done']);
    expect(BOARD_SOURCES).toEqual(['web', 'chat', 'manager', 'meeting', 'jira', 'note', 'session']);
  });
});

describe('BoardItemDTOSchema', () => {
  it('parses a card', () => {
    expect(BoardItemDTOSchema.parse(sampleItem)).toEqual(sampleItem);
  });

  it.each([
    ['an empty title', { title: '' }],
    ['a 301-character title', { title: 'x'.repeat(301) }],
    ['8001 characters of details', { details: 'x'.repeat(8001) }],
    ['a 501-character result', { result: 'x'.repeat(501) }],
    ['priority 2', { priority: 2 }],
    ['state paused', { state: 'paused' }],
    ['source email', { source: 'email' }],
    ['a server that is not a host id', { server: 'Ha:Q' }],
  ])('rejects %s', (_label, patch) => {
    expect(BoardItemDTOSchema.safeParse({ ...sampleItem, ...patch }).success).toBe(false);
  });
});

describe('events, missions, detail and list', () => {
  it('parses an event and caps its text at 2000', () => {
    const event = { id: 1, itemId: 12, at: AT, kind: 'report', text: '#12 done: tests pass' };
    expect(BoardEventDTOSchema.parse(event)).toEqual(event);
    expect(BoardEventDTOSchema.safeParse({ ...event, text: 'x'.repeat(2001) }).success).toBe(false);
    expect(BoardEventDTOSchema.safeParse({ ...event, kind: 'deleted' }).success).toBe(false);
  });

  it('parses a mission and caps its last text at 1200', () => {
    expect(MissionDTOSchema.parse(mission)).toEqual(mission);
    expect(MissionDTOSchema.safeParse({ ...mission, lastText: 'x'.repeat(1201) }).success).toBe(false);
    expect(MissionDTOSchema.safeParse({ ...mission, phase: 'done' }).success).toBe(false);
    expect(MissionListDTOSchema.parse({ items: [mission] })).toEqual({ items: [mission] });
  });

  it('parses a detail with and without a mission, and a list', () => {
    const detail = { item: sampleItem, events: [], mission };
    expect(BoardItemDetailDTOSchema.parse(detail)).toEqual(detail);
    expect(BoardItemDetailDTOSchema.parse({ ...detail, mission: null }).mission).toBeNull();
    expect(BoardListDTOSchema.parse({ items: [sampleItem] })).toEqual({ items: [sampleItem] });
  });
});

describe('CreateBoardItemBodySchema', () => {
  it('accepts a title alone and a full body', () => {
    expect(CreateBoardItemBodySchema.parse({ title: 'Buy milk' })).toEqual({ title: 'Buy milk' });
    const full = {
      title: 'ORC-123 Fix login', details: 'From Jira', project: 'orchard', server: 'birch', today: true, priority: 1,
      source: 'jira', sourceRef: 'birch:ORC-123',
    };
    expect(CreateBoardItemBodySchema.parse(full)).toEqual(full);
  });

  it.each([
    ['an unknown key', { title: 'x', state: 'done' }],
    ['a blank title', { title: '   ' }],
    ['a 301-character title', { title: 'x'.repeat(301) }],
    ['source luady (only the hub and Luady make those)', { title: 'x', source: 'manager' }],
    ['source chat', { title: 'x', source: 'chat' }],
    ['8001 characters of details', { title: 'x', details: 'x'.repeat(8001) }],
  ])('rejects %s', (_label, body) => {
    expect(CreateBoardItemBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('UpdateBoardItemBodySchema', () => {
  it('accepts clearing the project and server, and the two owner states', () => {
    const patch = { project: null, server: null, state: 'done', dueAt: '2026-11-20T08:00:00+04:00', snoozeUntil: null };
    expect(UpdateBoardItemBodySchema.parse(patch)).toEqual(patch);
    expect(UpdateBoardItemBodySchema.parse({})).toEqual({});
  });

  it.each([
    ['an unknown key', { result: 'done' }],
    ['state running', { state: 'running' }],
    ['state review', { state: 'review' }],
    ['a due date that is not a date', { dueAt: 'Thursday' }],
  ])('rejects %s', (_label, body) => {
    expect(UpdateBoardItemBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('delegation', () => {
  it('parses the three kinds of work and the three targets', () => {
    for (const what of [{ kind: 'todo', id: 12 }, { kind: 'jira', server: 'birch', key: 'ORC-123' }, { kind: 'note', id: 'm:abc12345' }, { kind: 'note', id: 'n:4' }]) {
      expect(DelegateWhatSchema.parse(what)).toEqual(what);
    }
    for (const to of [{ kind: 'auto' }, { kind: 'session', id: 'birch:cc-orchard:0.0' }, { kind: 'server', server: 'cedar' }]) {
      expect(DelegateToSchema.parse(to)).toEqual(to);
    }
  });

  it.each([
    ['a bad ticket key', { kind: 'jira', server: 'birch', key: 'orc-123' }],
    ['a ticket on a room id outside the grammar', { kind: 'jira', server: 'Or chard', key: 'ORC-123' }],
    ['a note id without its kind', { kind: 'note', id: '4' }],
    ['card id 0', { kind: 'todo', id: 0 }],
    ['an unknown key', { kind: 'todo', id: 1, title: 'x' }],
  ])('DelegateWhatSchema rejects %s', (_label, what) => {
    expect(DelegateWhatSchema.safeParse(what).success).toBe(false);
  });

  it('DelegateBodySchema takes 1 to 12 items and a note up to 1000 characters', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ kind: 'todo', id: i + 1 }));
    expect(DelegateBodySchema.safeParse({ what: twelve, to: { kind: 'auto' } }).success).toBe(true);
    expect(DelegateBodySchema.safeParse({ what: [...twelve, { kind: 'todo', id: 13 }], to: { kind: 'auto' } }).success).toBe(false);
    expect(DelegateBodySchema.safeParse({ what: [], to: { kind: 'auto' } }).success).toBe(false);
    expect(DelegateBodySchema.safeParse({ what: twelve, to: { kind: 'auto' }, note: 'x'.repeat(1001) }).success).toBe(false);
    expect(DelegateBodySchema.safeParse({ what: twelve, to: { kind: 'auto' }, extra: 1 }).success).toBe(false);
  });

  it('DelegateResultDTOSchema parses a result', () => {
    const result = { runId: 'r_1', items: [sampleItem], manager: 'queued' };
    expect(DelegateResultDTOSchema.parse(result)).toEqual(result);
    expect(DelegateResultDTOSchema.safeParse({ ...result, manager: 'down' }).success).toBe(false);
  });
});
