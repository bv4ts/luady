import { describe, expect, it } from 'vitest';
import { dueState, dueText, remindPresets, snoozedCards, backText } from '../../../../src/features/agency/drawers/board/remind.js';
import {
  accountLimits, areaPath, linePath, loadMax, serverFacts, serverSeries, limitTone,
} from '../../../../src/features/agency/drawers/fleet/fleet-model.js';
import { checkUrl, hostOf, labelError, moveLink, officeLinks } from '../../../../src/features/agency/drawers/links/links-model.js';
import { clockText, dayKey, dayStart, dayWords, ownerMs, isoFromInputs, whenWords } from '../../../../src/features/agency/drawers/schedule/owner-time.js';
import { cronToRule, nextText, ruleToWhen, ruleWords, sortSchedules, whenText, inPast, taskError } from '../../../../src/features/agency/drawers/schedule/schedule-model.js';
import { KIND_LOOK, hourTicks, placeMarks, refTarget, rowText, stripAt, stripRange } from '../../../../src/features/agency/drawers/timeline/timeline-model.js';
import { linkLabel, officeCounts, tiltOf, weekLine, winDayLabel, winsByDay } from '../../../../src/features/agency/drawers/wins/wins-model.js';
import { roomLookup } from '../../../../src/features/rooms/room-lookup.js';
import { question, server, session } from '../../../fixtures.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { card } from '../board/board-fixtures.js';
import { account, link, win } from './wave2-fixtures.js';

/** Sunday 15 Nov 2026, 2:30 PM in owner time. */
const NOW = ownerMs(2026, 11, 15, 14, 30);

describe('owner time', () => {
  it('writes clock times and days in the owner\'s words', () => {
    expect(clockText(ownerMs(2026, 11, 15, 9))).toBe('9:00 AM');
    expect(clockText(ownerMs(2026, 11, 15, 0, 5))).toBe('12:05 AM');
    expect(clockText(ownerMs(2026, 11, 15, 12, 30))).toBe('12:30 PM');
    expect(dayWords(ownerMs(2026, 11, 16, 9), NOW)).toBe('Tomorrow');
    expect(dayWords(ownerMs(2026, 11, 14, 23, 59), NOW)).toBe('Yesterday');
    expect(dayWords(ownerMs(2026, 11, 19, 9), NOW)).toBe('Thursday');
    expect(dayWords(ownerMs(2026, 11, 30, 9), NOW)).toBe('Nov 30');
    expect(dayWords(ownerMs(2027, 1, 3, 9), NOW)).toBe('Jan 3, 2027');
    expect(whenWords(ownerMs(2026, 11, 16, 9), NOW)).toBe('Tomorrow, 9:00 AM');
  });

  it('keeps the owner day at the UTC day boundary', () => {
    // 21:00 UTC on the 14th is 1:00 AM on the 15th in owner time.
    expect(dayKey(Date.UTC(2026, 10, 14, 21))).toBe('2026-11-15');
    expect(dayStart('2026-11-15')).toBe(Date.UTC(2026, 10, 14, 20));
    expect(dayStart('2026-02-30')).toBeNull();
    expect(isoFromInputs('2026-11-20', '09:00')).toBe('2026-11-20T09:00:00+04:00');
    expect(isoFromInputs('2026-11-20', '25:00')).toBeNull();
  });
});

describe('schedule rules', () => {
  it('turns each rule into the cron or time the hub stores', () => {
    expect(ruleToWhen({ kind: 'daily', time: '09:00' })).toEqual({ when: '0 9 * * *' });
    expect(ruleToWhen({ kind: 'weekdays', time: '08:30' })).toEqual({ when: '30 8 * * 1-5' });
    expect(ruleToWhen({ kind: 'weekly', weekday: 4, time: '17:15' })).toEqual({ when: '15 17 * * 4' });
    expect(ruleToWhen({ kind: 'once', date: '2026-11-20', time: '09:00' })).toEqual({ when: '2026-11-20T09:00:00+04:00' });
    expect(ruleToWhen({ kind: 'once', date: '', time: '09:00' })).toEqual({ error: 'Pick a date.' });
    expect(ruleToWhen({ kind: 'daily', time: '' })).toEqual({ error: 'Pick a time.' });
  });

  it('reads crons back into words, and leaves Luady\'s own as they are', () => {
    expect(cronToRule('0 9 * * 1-5')).toEqual({ kind: 'weekdays', time: '09:00' });
    expect(cronToRule('15 17 * * 7')).toEqual({ kind: 'weekly', weekday: 0, time: '17:15' });
    expect(cronToRule('*/5 * * * *')).toBeNull();
    expect(whenText('0 9 * * 1-5', NOW)).toBe('Every weekday (Monday to Friday) at 9:00 AM');
    expect(whenText('0 21 * * *', NOW)).toBe('Every day at 9:00 PM');
    expect(whenText('30 7 * * 4', NOW)).toBe('Every Thursday at 7:30 AM');
    expect(whenText('2026-11-16T09:00:00+04:00', NOW)).toBe('Once, Tomorrow, 9:00 AM');
    expect(whenText('0 9 1 * *', NOW)).toBe("Repeats on Luady's own rule (0 9 1 * *)");
    for (const rule of [{ kind: 'daily', time: '06:05' }, { kind: 'weekdays', time: '23:59' }, { kind: 'weekly', weekday: 6, time: '00:00' }] as const) {
      const made = ruleToWhen(rule);
      expect('when' in made && cronToRule(made.when)).toEqual(rule);
    }
    expect(ruleWords({ kind: 'once', date: '2026-11-19', time: '18:00' }, NOW)).toBe('Once, Thursday, 6:00 PM');
  });

  it('says the next run, sorts soonest first and checks the form', () => {
    expect(nextText({ nextRunAt: new Date(ownerMs(2026, 11, 16, 9)).toISOString() }, NOW)).toBe('Next: Tomorrow, 9:00 AM');
    expect(nextText({ nextRunAt: null }, NOW)).toBe('Will not run again');
    const items = [{ id: 'b', when: '', task: 't', nextRunAt: null }, { id: 'a', when: '', task: 't', nextRunAt: '2026-11-16T05:00:00.000Z' }];
    expect(sortSchedules(items).map((item) => item.id)).toEqual(['a', 'b']);
    expect(taskError('hi')).toMatch(/Say what/);
    expect(taskError('Check the deploy')).toBeNull();
    expect(inPast({ kind: 'once', date: '2026-11-15', time: '09:00' }, NOW)).toBe(true);
    expect(inPast({ kind: 'daily', time: '09:00' }, NOW)).toBe(false);
  });
});

describe('snooze and due', () => {
  it('offers this evening, tomorrow and named days at fixed clock times', () => {
    const presets = remindPresets(NOW);
    expect(presets.map((p) => p.label)).toEqual([
      'This evening, 6:00 PM', 'Tomorrow, 9:00 AM', 'Tuesday, 9:00 AM', 'Wednesday, 9:00 AM', 'Thursday, 9:00 AM', 'Friday, 9:00 AM', 'Saturday, 9:00 AM',
    ]);
    expect(presets[0]?.at).toBe(ownerMs(2026, 11, 15, 18));
    expect(presets[1]?.at).toBe(ownerMs(2026, 11, 16, 9));
    expect(presets[4]?.at).toBe(ownerMs(2026, 11, 19, 9));
    expect(remindPresets(ownerMs(2026, 11, 15, 19)).map((p) => p.id)[0]).toBe('tomorrow');
  });

  it('lists snoozed cards soonest first, and turns a passed due date red', () => {
    const later = new Date(ownerMs(2026, 11, 19, 9)).toISOString();
    const sooner = new Date(ownerMs(2026, 11, 16, 9)).toISOString();
    const cards = [card(1, { snoozeUntil: later }), card(2, { snoozeUntil: sooner }), card(3), card(4, { state: 'done', snoozeUntil: later })];
    expect(snoozedCards(cards, NOW).map((c) => c.id)).toEqual([2, 1]);
    expect(backText(card(2, { snoozeUntil: sooner }), NOW)).toBe('Back Tomorrow, 9:00 AM');
    const past = new Date(ownerMs(2026, 11, 14, 17)).toISOString();
    expect(dueState(card(5, { dueAt: past }), NOW)).toBe('past');
    expect(dueState(card(5, { dueAt: past, state: 'done' }), NOW)).toBe('ahead');
    expect(dueState(card(5), NOW)).toBe('none');
    expect(dueText(card(5, { dueAt: past }), NOW)).toBe('Overdue · Yesterday, 5:00 PM');
    expect(dueText(card(5, { dueAt: later }), NOW)).toBe('Due Thursday, 9:00 AM');
  });
});

describe('fleet graphs and facts', () => {
  const box = { width: 100, height: 20, from: 0, to: 100, max: 10 };

  it('turns graph points into an SVG path, breaking at gaps', () => {
    expect(linePath([[0, 0], [50, 5], [100, 10]], box)).toBe('M0 20 L50 10 L100 0');
    expect(linePath([[0, 0], [25, null], [50, 20], [75, 5]], box)).toBe('M0 20 M50 0 L75 10');
    expect(linePath([[-10, 1], [200, 1]], box)).toBe('');
    expect(areaPath([[0, 0], [100, 10]], box)).toBe('M0 20 L100 0 L100 20 L0 20 Z');
    expect(loadMax([[0, 0.4], [1, 3.2]])).toBe(4);
    expect(loadMax([])).toBe(2);
  });

  it('draws no disk graph for a server that does not report its disk', () => {
    const history = { servers: [{ name: 'birch' as const, points: [[1, 0.5, 40, null], [2, 0.7, 42, null]] as [number, number, number, number | null][] }], accounts: [] };
    expect(serverSeries(history, 'birch').disk).toBeNull();
    expect(serverSeries(history, 'birch').mem).toEqual([[1, 40], [2, 42]]);
    expect(serverSeries(null, 'cedar')).toEqual({ load: [], mem: [], disk: null });
  });

  it('words a server and an account', () => {
    const facts = serverFacts(server({ name: 'birch' }), [session({ host: 'birch' }), session({ host: 'birch', state: 'ended' })], NOW);
    expect(facts).toMatchObject({ online: true, link: 'Online', load: 'load 0.42', mem: 'memory 50%', disk: 'disk: 20 GB free', sessions: '1 session' });
    const withTotal = server({ sysinfo: { load1: 1, load5: 1, mem_total_kb: 100, mem_avail_kb: 25, disk_free_kb: 25 * 1024 * 1024, uptime_s: 1, disk_total_kb: 100 * 1024 * 1024 } as never });
    expect(serverFacts(withTotal, [], NOW).disk).toBe('disk 75% · 25 GB free');
    expect(serverFacts(server({ status: 'offline', lastSeenAt: new Date(ownerMs(2026, 11, 15, 9)).toISOString() }), [], NOW).link).toBe('Offline since Today, 9:00 AM');
    const limits = accountLimits(account(), NOW);
    expect(limits.map((l) => l.text)).toEqual(['62% · resets Today, 5:00 PM', 'no reading']);
    expect([limitTone(null), limitTone(79), limitTone(80), limitTone(95)]).toEqual(['ok', 'ok', 'warn', 'alert']);
  });
});

describe('wins', () => {
  it('groups by owner day and counts every office', () => {
    const items = [win(1, ownerMs(2026, 11, 15, 10)), win(2, ownerMs(2026, 11, 14, 22)), win(3, ownerMs(2026, 11, 15, 13)), win(4, ownerMs(2026, 11, 12, 9))];
    expect(winsByDay(items, NOW).map((day) => [day.label, day.items.map((item) => item.id)])).toEqual([
      ['Today', [3, 1]], ['Yesterday', [2]], ['Thursday, Nov 12', [4]],
    ]);
    expect(winDayLabel(ownerMs(2026, 11, 15, 0, 1), NOW)).toBe('Today');
    expect(officeCounts({ birch: 3, cedar: 1 }, roomLookup(classicRoomDtos())).map((o) => `${o.name} ${String(o.count)}`)).toEqual(['Orchard 3', 'Harbor 0', 'Meadow 1', 'Private Projects 0']);
    expect(weekLine(0)).toBe('Nothing shipped yet this week');
    expect(weekLine(4)).toBe('4 shipped this week');
  });

  it('names links and tilts photos the same way every time', () => {
    expect(linkLabel('https://github.com/owner/repo/pull/42')).toBe('Pull request #42');
    expect(linkLabel('https://orchard-demo.atlassian.net/browse/ORC-12')).toBe('Ticket ORC-12');
    expect(linkLabel('https://www.staging.orchard.example/checkout')).toBe('staging.orchard.example · checkout');
    expect(linkLabel('https://orchard.example')).toBe('orchard.example');
    expect(tiltOf(7)).toBe(tiltOf(7));
    expect(Math.abs(tiltOf(123))).toBeLessThanOrEqual(2.5);
  });
});

describe('today strip', () => {
  const day = '2026-11-15';
  const item = (hour: number, minute: number, kind: 'started' | 'done' = 'done') =>
    ({ at: new Date(ownerMs(2026, 11, 15, hour, minute)).toISOString(), kind, label: 'Payroll', server: 'birch' as const, ref: null });

  it('runs from 6 AM to now today, to midnight on a past day, and earlier when something happened before 6', () => {
    expect(stripRange(day, [], NOW)).toEqual({ from: ownerMs(2026, 11, 15, 6), to: NOW });
    expect(stripRange(day, [item(4, 20)], NOW).from).toBe(ownerMs(2026, 11, 15, 4));
    expect(stripRange('2026-11-14', [], NOW)).toEqual({ from: ownerMs(2026, 11, 14, 6), to: ownerMs(2026, 11, 15, 0) });
    expect(stripRange(day, [], ownerMs(2026, 11, 15, 5))).toEqual({ from: ownerMs(2026, 11, 15, 0), to: ownerMs(2026, 11, 15, 5) });
    expect(stripRange(day, [], ownerMs(2026, 11, 15, 0, 20))).toEqual({ from: ownerMs(2026, 11, 15, 0), to: ownerMs(2026, 11, 15, 1) });
  });

  it('places marks, stacks crowded ones and labels the hours', () => {
    const range = stripRange(day, [], NOW);
    expect(stripAt(ownerMs(2026, 11, 15, 6), range)).toBe(0);
    expect(stripAt(NOW, range)).toBe(1);
    const placed = placeMarks([item(9, 0), item(9, 1), item(9, 2), item(12, 0)], range);
    expect(placed.map((p) => p.row)).toEqual([0, 1, 2, 0]);
    const ticks = hourTicks(range);
    expect(ticks[0]?.label).toBe('6 AM');
    expect(ticks.map((t) => t.label)).toContain('12 PM');
    expect(rowText(item(9, 5))).toBe('9:05 AM · Finished · Payroll');
    expect(KIND_LOOK.asked.shape).toBe('diamond');
  });

  it('opens the thing a mark points at', () => {
    expect(refTarget({ kind: 'todo', id: '12' }, [])).toEqual({ kind: 'modal', modal: { kind: 'board', itemId: 12 } });
    expect(refTarget({ kind: 'note', id: 'm:9' }, [])).toEqual({ kind: 'modal', modal: { kind: 'notes', noteId: 'm:9' } });
    expect(refTarget({ kind: 'session', id: 'birch:a:0.0' }, [])).toEqual({ kind: 'agent', sessionId: 'birch:a:0.0' });
    expect(refTarget({ kind: 'question', id: 'ABCDEFGH' }, [question()])).toEqual({ kind: 'agent', sessionId: question().sessionId });
    expect(refTarget({ kind: 'question', id: 'ZZZZZZZZ' }, [question()])).toBeNull();
    expect(refTarget(null, [])).toBeNull();
  });
});

describe('links', () => {
  it('accepts https only, adding it when no scheme was typed', () => {
    expect(checkUrl('github.com/orchard')).toEqual({ url: 'https://github.com/orchard' });
    expect(checkUrl(' https://figma.com/file/x ')).toEqual({ url: 'https://figma.com/file/x' });
    expect(checkUrl('http://staging.orchard.example')).toEqual({ error: 'Only https:// links can go on the shelf.' });
    expect(checkUrl('javascript:alert(1)')).toEqual({ error: 'Only https:// links can go on the shelf.' });
    expect(checkUrl('')).toEqual({ error: 'Paste the address.' });
    expect(checkUrl('localhost')).toEqual({ error: 'That does not look like a web address.' });
    expect(checkUrl(`https://a.com/${'x'.repeat(500)}`)).toEqual({ error: expect.stringContaining('too long') });
    expect(labelError(' ')).toMatch(/short name/);
    expect(labelError('x'.repeat(41))).toMatch(/40/);
    expect(hostOf('https://www.github.com/x')).toBe('github.com');
  });

  it('keeps shelf order and moves a link one place', () => {
    const items = [link(3, 'birch', 2), link(1, 'birch', 0), link(2, 'birch', 1), link(9, 'cedar', 0)];
    const shelf = officeLinks(items, 'birch');
    expect(shelf.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(moveLink(shelf, 3, -1)).toEqual([{ id: 3, position: 1 }, { id: 2, position: 2 }]);
    expect(moveLink(shelf, 1, -1)).toEqual([]);
    expect(moveLink(shelf, 3, 1)).toEqual([]);
  });
});
