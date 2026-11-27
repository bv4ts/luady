import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../src/db/open.js';
import { BOARD_PIN_SECONDS, REMINDER_BEFORE_MS, createTodoService } from '../../src/todos/service.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

function setup() {
  const clock = createFakeClock('2026-10-10T15:00:00.000Z');
  const outbound = createFakeOutbound();
  const cleared: number[][] = [];
  const todos = createTodoService({
    db: openMemoryDb(), clock, log: silentLogger(), outbound, onTodayCleared: (ids) => void cleared.push([...ids]),
  });
  return { clock, outbound, todos, cleared };
}

describe('to-do list', () => {
  it('keeps plain items off the pinned board and lists them', async () => {
    const t = setup();
    await t.todos.add('  call   the bank ', false);
    expect(t.outbound.sent).toEqual([]);
    expect(t.todos.render()).toBe('📝 *To-do*\n☐ 1. call the bank');
  });

  it("pins today's board for 24 h, edits it as items change, reminds 4 h before it ends, then unpins", async () => {
    const t = setup();
    await t.todos.add('send the invoice', true);
    expect(t.outbound.sent[0]?.text).toContain('📝 *Today · Sat 10 Oct*\n☐ 1. send the invoice');
    expect(t.outbound.pins).toEqual([{ msgId: 'fake-wa-1', on: true, ...{} }]);
    await t.todos.add('gym', true);
    await t.todos.done(1);
    expect(t.outbound.edits.at(-1)?.text).toContain('✅ ~send the invoice~\n☐ 2. gym');

    t.clock.advance(BOARD_PIN_SECONDS * 1000 - REMINDER_BEFORE_MS);
    await t.todos.tick();
    expect(t.outbound.sent.at(-1)?.text).toBe("⏰ *4 hours left* on today's list:\n☐ 2. gym");
    await t.todos.tick();
    expect(t.outbound.sent.filter((m) => m.text.startsWith('⏰'))).toHaveLength(1);

    t.clock.advance(REMINDER_BEFORE_MS);
    await t.todos.tick();
    expect(t.outbound.pins.at(-1)).toEqual({ msgId: 'fake-wa-1', on: false });
    // The cards' today flags were cleared: the board is told which ones (it sends board.updated for them).
    expect(t.cleared).toEqual([[1, 2]]);
    expect(t.todos.render()).toBe('📝 *To-do*\n☐ 2. gym');
  });

  it('rejects empty items and unknown numbers', async () => {
    const t = setup();
    await expect(t.todos.add('   ', false)).rejects.toThrow(/1-300 characters/);
    await expect(t.todos.done(99)).rejects.toThrow(/No to-do #99/);
  });
});
