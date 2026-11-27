import { describe, expect, it } from 'vitest';
import {
  CreateLinkBodySchema,
  CreateScheduleBodySchema,
  DEFAULT_WEB_PREFS,
  FleetHistoryDTOSchema,
  LinkDTOSchema,
  LinkListDTOSchema,
  RecapDTOSchema,
  RecapLineSchema,
  ScheduleItemDTOSchema,
  ScheduleListDTOSchema,
  TIMELINE_KINDS,
  TimelineDTOSchema,
  UpdateLinkBodySchema,
  UpdateWebPrefsBodySchema,
  WebPrefsDTOSchema,
  WinsDTOSchema,
  isEmptyRecap,
  mergeWebPrefs,
} from '../src/extras.js';
import { TOOL_DEFS } from '../src/tools.js';
import { WsServerMessageSchema } from '../src/ws.js';

const AT = '2026-11-15T09:00:00.000Z';
const line = { at: AT, text: 'Checkout fixed', ref: { kind: 'todo', id: '12' }, server: 'birch' };
const lines = (n: number) => Array.from({ length: n }, () => line);
const recap = {
  since: '2026-11-15T06:00:00.000Z', until: AT, finished: [line], failed: [], waiting: [{ ...line, ref: { kind: 'question', id: 'ABCDEFGH' } }],
  meetings: [{ ...line, ref: { kind: 'note', id: 'm:abc' }, server: null }], cards: { added: 2, done: 1 }, sessions: { started: 3, ended: 1 },
};

describe('recap', () => {
  it('parses a line without a reference, and a whole recap', () => {
    expect(RecapLineSchema.parse({ ...line, ref: null, server: null })).toEqual({ ...line, ref: null, server: null });
    expect(RecapDTOSchema.parse(recap)).toEqual(recap);
  });

  it('isEmptyRecap: true only with every list empty and every count zero', () => {
    const empty = { ...recap, finished: [], waiting: [], meetings: [], cards: { added: 0, done: 0 }, sessions: { started: 0, ended: 0 } };
    expect(isEmptyRecap(empty)).toBe(true);
    expect(isEmptyRecap({ ...empty, sessions: { started: 1, ended: 0 } })).toBe(false);
    expect(isEmptyRecap(recap)).toBe(false);
  });

  it.each([
    ['a 201-character line', { finished: [{ ...line, text: 'x'.repeat(201) }] }],
    ['13 lines in a list', { failed: lines(13) }],
    ['an unknown reference kind', { finished: [{ ...line, ref: { kind: 'mail', id: '1' } }] }],
    ['a negative count', { cards: { added: -1, done: 0 } }],
    ['a server that is not a host id', { finished: [{ ...line, server: 'B:irch' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(RecapDTOSchema.safeParse({ ...recap, ...patch }).success).toBe(false);
  });
});

describe('fleet history', () => {
  const history = {
    servers: [{ name: 'cedar', points: [[1763190000, 0.4, 51, 62], [1763190060, 0.5, 52, 62]] }],
    accounts: [{ id: 'claude:org_1', label: 'Max', points: [[1763190000, 12, null], [1763190060, null, 40]] }],
  };

  it('parses servers and accounts with their point tuples', () => {
    expect(FleetHistoryDTOSchema.parse(history)).toEqual(history);
    expect(FleetHistoryDTOSchema.parse({ servers: [], accounts: [] })).toEqual({ servers: [], accounts: [] });
  });

  it('takes a null disk share (the kit does not report the disk size) but not a missing one', () => {
    expect(FleetHistoryDTOSchema.safeParse({ ...history, servers: [{ name: 'cedar', points: [[1, 0.4, 51, null]] }] }).success).toBe(true);
    expect(FleetHistoryDTOSchema.safeParse({ ...history, servers: [{ name: 'cedar', points: [[1, 0.4, 51, 101]] }] }).success).toBe(false);
  });

  it('rejects more than 240 points, a percentage over 100, a short tuple and an unknown server', () => {
    const many = Array.from({ length: 241 }, (_, i) => [i, 0, 0, 0]);
    expect(FleetHistoryDTOSchema.safeParse({ ...history, servers: [{ name: 'cedar', points: many }] }).success).toBe(false);
    expect(FleetHistoryDTOSchema.safeParse({ ...history, servers: [{ name: 'cedar', points: [[1, 0, 101, 0]] }] }).success).toBe(false);
    expect(FleetHistoryDTOSchema.safeParse({ ...history, servers: [{ name: 'cedar', points: [[1, 0, 0]] }] }).success).toBe(false);
    expect(FleetHistoryDTOSchema.safeParse({ ...history, servers: [{ name: 'Not An Id', points: [] }] }).success).toBe(false);
    expect(FleetHistoryDTOSchema.safeParse({ ...history, accounts: [{ id: 'x', label: 'x', points: [[1, 0, 101]] }] }).success).toBe(false);
  });
});

describe('wins', () => {
  const win = { id: 12, title: 'Checkout', project: 'orchard', server: 'birch', result: 'PR #88 merged', links: ['https://github.com/x/pull/88'], doneAt: AT };

  it('parses wins with the count per office', () => {
    const wins = { items: [win], byServer: { birch: 1 } };
    expect(WinsDTOSchema.parse(wins)).toEqual(wins);
  });

  it('rejects an http link, six links, a 301-character link and a count for luady', () => {
    expect(WinsDTOSchema.safeParse({ items: [{ ...win, links: ['http://x.example'] }], byServer: {} }).success).toBe(false);
    expect(WinsDTOSchema.safeParse({ items: [{ ...win, links: Array.from({ length: 6 }, () => 'https://a.example') }], byServer: {} }).success).toBe(false);
    expect(WinsDTOSchema.safeParse({ items: [{ ...win, links: [`https://a.example/${'x'.repeat(290)}`] }], byServer: {} }).success).toBe(false);
    expect(WinsDTOSchema.safeParse({ items: [], byServer: { 'Not An Id': 1 } }).success).toBe(false);
  });
});

describe('timeline', () => {
  const item = { at: AT, kind: 'done', label: 'Checkout fixed', server: 'birch', ref: { kind: 'todo', id: '12' } };

  it('pins the eight kinds and parses a day', () => {
    expect(TIMELINE_KINDS).toEqual(['started', 'done', 'asked', 'answered', 'arrived', 'left', 'meeting', 'alert']);
    const day = { day: '2026-11-15', items: [item, { ...item, kind: 'alert', server: null, ref: null }] };
    expect(TimelineDTOSchema.parse(day)).toEqual(day);
  });

  it('rejects a bad day, an unknown kind, a 161-character label and 401 items', () => {
    expect(TimelineDTOSchema.safeParse({ day: '15/11/2026', items: [] }).success).toBe(false);
    expect(TimelineDTOSchema.safeParse({ day: '2026-11-15', items: [{ ...item, kind: 'lunch' }] }).success).toBe(false);
    expect(TimelineDTOSchema.safeParse({ day: '2026-11-15', items: [{ ...item, label: 'x'.repeat(161) }] }).success).toBe(false);
    expect(TimelineDTOSchema.safeParse({ day: '2026-11-15', items: Array.from({ length: 401 }, () => item) }).success).toBe(false);
  });
});

describe('schedules', () => {
  it('parses items and the list', () => {
    const item = { id: 'S1', when: '0 9 * * 1-5', task: 'Morning check', nextRunAt: AT };
    expect(ScheduleItemDTOSchema.parse(item)).toEqual(item);
    expect(ScheduleListDTOSchema.parse({ items: [{ ...item, nextRunAt: null }] }).items).toHaveLength(1);
  });

  it('CreateScheduleBodySchema keeps to 5..64 and 3..2000 and rejects unknown keys', () => {
    expect(CreateScheduleBodySchema.parse({ when: '0 9 * * 1-5', task: 'Check the deploy' })).toEqual({ when: '0 9 * * 1-5', task: 'Check the deploy' });
    expect(CreateScheduleBodySchema.safeParse({ when: '9am', task: 'Check the deploy' }).success).toBe(false);
    expect(CreateScheduleBodySchema.safeParse({ when: 'x'.repeat(65), task: 'Check' }).success).toBe(false);
    expect(CreateScheduleBodySchema.safeParse({ when: '0 9 * * *', task: 'go' }).success).toBe(false);
    expect(CreateScheduleBodySchema.safeParse({ when: '0 9 * * *', task: 'x'.repeat(2001) }).success).toBe(false);
    expect(CreateScheduleBodySchema.safeParse({ when: '0 9 * * *', task: 'Check', id: 'S1' }).success).toBe(false);
  });
});

describe('links', () => {
  const link = { id: 1, server: 'birch', label: 'Staging', url: 'https://staging.orchard.example', position: 0 };

  it('parses a link and a list', () => {
    expect(LinkDTOSchema.parse(link)).toEqual(link);
    expect(LinkListDTOSchema.parse({ items: [link] })).toEqual({ items: [link] });
  });

  it('CreateLinkBodySchema takes https only, labels 1..40, addresses up to 500', () => {
    const body = { server: 'cedar', label: 'GitHub', url: 'https://github.com/meadow' };
    expect(CreateLinkBodySchema.parse(body)).toEqual(body);
    for (const url of ['http://github.com', 'javascript:alert(1)', 'ftp://x.example', `https://x.example/${'x'.repeat(490)}`, 'not a url']) {
      expect(CreateLinkBodySchema.safeParse({ ...body, url }).success, url).toBe(false);
    }
    expect(CreateLinkBodySchema.safeParse({ ...body, label: '' }).success).toBe(false);
    expect(CreateLinkBodySchema.safeParse({ ...body, label: 'x'.repeat(41) }).success).toBe(false);
    expect(CreateLinkBodySchema.safeParse({ ...body, server: 'Not A Room' }).success).toBe(false);
    expect(CreateLinkBodySchema.safeParse({ ...body, position: 2 }).success).toBe(false);
  });

  it('UpdateLinkBodySchema takes any of label, url and position', () => {
    expect(UpdateLinkBodySchema.parse({ position: 3 })).toEqual({ position: 3 });
    expect(UpdateLinkBodySchema.safeParse({ position: -1 }).success).toBe(false);
    expect(UpdateLinkBodySchema.safeParse({ url: 'http://x.example' }).success).toBe(false);
    expect(UpdateLinkBodySchema.safeParse({ server: 'cedar' }).success).toBe(false);
  });
});

describe('website preferences', () => {
  it('defaults: sound on at 0.6, day and night on', () => {
    expect(DEFAULT_WEB_PREFS).toEqual({ sound: { muted: false, volume: 0.6 }, dayNight: true });
    expect(WebPrefsDTOSchema.parse(DEFAULT_WEB_PREFS)).toEqual(DEFAULT_WEB_PREFS);
  });

  it('rejects a volume outside 0..1', () => {
    expect(WebPrefsDTOSchema.safeParse({ ...DEFAULT_WEB_PREFS, sound: { muted: false, volume: 1.2 } }).success).toBe(false);
  });

  it('a change names any part, and merges over what is stored', () => {
    expect(UpdateWebPrefsBodySchema.parse({ sound: { muted: true } })).toEqual({ sound: { muted: true } });
    expect(UpdateWebPrefsBodySchema.safeParse({ theme: 'dark' }).success).toBe(false);
    expect(UpdateWebPrefsBodySchema.safeParse({ sound: { loud: true } }).success).toBe(false);
    expect(mergeWebPrefs(DEFAULT_WEB_PREFS, { sound: { muted: true } })).toEqual({ sound: { muted: true, volume: 0.6 }, dayNight: true });
    expect(mergeWebPrefs(DEFAULT_WEB_PREFS, { dayNight: false })).toEqual({ ...DEFAULT_WEB_PREFS, dayNight: false });
  });
});

describe('schedule, link and preference server messages', () => {
  it.each([
    [{ type: 'schedules.changed', at: AT }],
    [{ type: 'links.changed', at: AT }],
    [{ type: 'prefs.changed', at: AT }],
  ])('accepts %j', (message) => {
    expect(WsServerMessageSchema.parse(message)).toEqual(message);
  });

  it('rejects them without at', () => {
    expect(WsServerMessageSchema.safeParse({ type: 'links.changed' }).success).toBe(false);
  });
});

describe('due and snooze on the to-do tools', () => {
  const due = '2026-11-20T09:00:00+04:00';

  it('todo_add takes due and snooze as ISO times', () => {
    expect(TOOL_DEFS.todo_add.input.parse({ text: 'Renew the domain', due, snooze: due })).toMatchObject({ due, snooze: due });
    expect(TOOL_DEFS.todo_add.input.safeParse({ text: 'x', due: 'Thursday' }).success).toBe(false);
    expect(TOOL_DEFS.todo_add.input.safeParse({ text: 'x', due: null }).success).toBe(false);
  });

  it('todo_update takes them, and null clears them', () => {
    expect(TOOL_DEFS.todo_update.input.parse({ id: 1, due: null, snooze: due })).toEqual({ id: 1, due: null, snooze: due });
    expect(TOOL_DEFS.todo_update.input.safeParse({ id: 1, snooze: '2026-11-20' }).success).toBe(false);
  });
});
