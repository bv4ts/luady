import { describe, expect, it } from 'vitest';
import { BACK_TEXT, dueMark } from '../../src/board/reminders.js';
import { boardHarness } from './harness.js';

const MINUTE = 60_000;

describe('snooze', () => {
  it('a card comes back when its snooze ends: cleared, logged, one notice, back on the chat list', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Call the bank', source: 'web' }, 'owner');
    await t.board.update(1, { snoozeUntil: '2026-11-15T09:30:00.000Z' }, 'owner');
    expect(t.todos.render()).toBe('Your to-do list is empty.');
    await t.board.checkReminders();
    expect(t.reminders.sent).toEqual([]);
    t.clock.advance(30 * MINUTE);
    await t.board.checkReminders();
    await t.board.checkReminders();
    expect(t.reminders.sent.map((sent) => sent.text)).toEqual(['Back on your board: Call the bank']);
    expect(t.board.get(1)).toMatchObject({ snoozeUntil: null, state: 'open' });
    expect(t.board.detail(1)?.events.at(-1)).toMatchObject({ kind: 'note', text: BACK_TEXT });
    expect(t.updated.at(-1)?.[0]).toMatchObject({ id: 1, snoozeUntil: null });
    expect(t.todos.render()).toBe('📝 *To-do*\n☐ 1. Call the bank');
  });

  it('a snooze given with an offset counts by its real time; a done card is cleared without a notice', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Offset', source: 'web' }, 'owner');
    await t.board.update(1, { snoozeUntil: '2026-11-15T13:10:00+04:00' }, 'owner');
    await t.board.add({ title: 'Already done', source: 'web' }, 'owner');
    await t.board.update(2, { snoozeUntil: '2026-11-15T09:05:00.000Z', state: 'done' }, 'owner');
    t.clock.advance(9 * MINUTE);
    await t.board.checkReminders();
    expect(t.reminders.sent).toEqual([]);
    expect(t.board.get(2)?.snoozeUntil).toBeNull();
    t.clock.advance(MINUTE);
    await t.board.checkReminders();
    expect(t.reminders.sent.map((sent) => sent.text)).toEqual(['Back on your board: Offset']);
  });
});

describe('due dates', () => {
  it('one notice when the due time passes, once per card and due time; a new due time gives a new one', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Send the invoice', source: 'web' }, 'owner');
    await t.board.update(1, { dueAt: '2026-11-15T10:00:00.000Z' }, 'owner');
    await t.board.checkReminders();
    expect(t.reminders.sent).toEqual([]);
    t.clock.advance(60 * MINUTE);
    await t.board.checkReminders();
    t.clock.advance(MINUTE);
    await t.board.checkReminders();
    expect(t.reminders.sent.map((sent) => sent.text)).toEqual(['Due now: Send the invoice']);
    expect(t.board.detail(1)?.events.at(-1)).toMatchObject({ kind: 'note', text: dueMark('2026-11-15T10:00:00.000Z') });
    expect(dueMark('2026-11-15T10:00:00.000Z')).toBe('Due Sun, Nov 15, 2:00 PM: reminder sent.');

    await t.board.update(1, { dueAt: '2026-11-15T10:30:00.000Z' }, 'owner');
    await t.board.checkReminders();
    expect(t.reminders.sent).toHaveLength(1);
    t.clock.advance(30 * MINUTE);
    await t.board.checkReminders();
    expect(t.reminders.sent).toHaveLength(2);
    await t.board.checkReminders();
    expect(t.reminders.sent).toHaveLength(2);
  });

  it('a done card gets no due notice; a hub restart does not send it again', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Done already', source: 'web' }, 'owner');
    await t.board.update(1, { dueAt: '2026-11-15T09:10:00.000Z', state: 'done' }, 'owner');
    await t.board.add({ title: 'Open one', source: 'web' }, 'owner');
    await t.board.update(2, { dueAt: '2026-11-15T09:10:00.000Z' }, 'owner');
    t.clock.advance(20 * MINUTE);
    await t.board.checkReminders();
    expect(t.reminders.sent.map((sent) => sent.text)).toEqual(['Due now: Open one']);
    t.board.stop();
    t.board.start();
    await t.board.checkReminders();
    expect(t.reminders.sent).toHaveLength(1);
  });
});
