import { describe, expect, it } from 'vitest';
import { BOARD_STATES, type BoardState } from '@luady/shared';
import { RefusedError, ValidationError } from '../../src/core/errors.js';
import { ENTER_KIND, NEXT_STATES, planChange } from '../../src/board/machine.js';
import type { CardRow } from '../../src/board/store.js';

const AT = '2026-11-15T10:00:00.000Z';

function card(over: Partial<CardRow> = {}): CardRow {
  return {
    id: 12, text: 'Fix the total', today: 0, done: 0, created_at: '2026-11-15T09:00:00.000Z', done_at: null, details: '', project: 'orchard',
    server: 'birch', source: 'web', source_ref: null, state: 'open', priority: 0, auto: 0, run_id: null, session_id: null, result: null,
    updated_at: null, due_at: null, snooze_until: null, ...over,
  };
}

describe('the life of a card', () => {
  const pairs = BOARD_STATES.flatMap((from) => BOARD_STATES.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', (from: BoardState, to: BoardState) => {
    const row = card({ state: from, done: from === 'done' ? 1 : 0, done_at: from === 'done' ? AT : null, session_id: 's1' });
    if (!NEXT_STATES[from].includes(to)) {
      expect(() => planChange(row, { state: to }, 'owner', AT)).toThrow(RefusedError);
      return;
    }
    const plan = planChange(row, { state: to }, 'owner', AT);
    expect(plan?.columns.state).toBe(to);
    // done and done_at follow state, so a rolled-back release reads the same list.
    expect(plan?.columns.done).toBe(to === 'done' ? 1 : 0);
    expect(plan?.columns.done_at).toBe(to === 'done' ? AT : null);
    expect(plan?.columns.updated_at).toBe(AT);
    expect(plan?.logs.map((line) => line.kind)).toEqual([ENTER_KIND[to]]);
    // Back to To do or queued again: the old session no longer ticks it.
    if (to === 'open' || to === 'queued') expect(plan?.columns.session_id).toBeNull();
    else expect(plan?.columns).not.toHaveProperty('session_id');
  });

  it('a done card never goes to review', () => {
    expect(() => planChange(card({ state: 'done', done: 1 }), { state: 'review' }, 'manager', AT)).toThrow(/cannot go to review/);
  });

  it('nothing to change gives no plan', () => {
    expect(planChange(card(), { title: 'Fix the total', state: 'open' }, 'owner', AT)).toBeNull();
  });

  it('edits write one "edited" line naming the fields, and an edited title stops a mission renaming the card', () => {
    const plan = planChange(card({ auto: 1 }), { title: '  New   title ', details: 'More', today: true }, 'owner', AT);
    expect(plan?.columns).toMatchObject({ text: 'New title', details: 'More', today: 1, auto: 0 });
    expect(plan?.logs).toEqual([{ kind: 'edited', text: 'Title, details, today changed by the owner.' }]);
    expect(planChange(card({ auto: 1 }), { title: 'Mission title' }, 'hub', AT)?.columns).not.toHaveProperty('auto');
  });

  it('a note alone is a note line, or a report line from a session', () => {
    expect(planChange(card(), { note: 'Waiting for the API key' }, 'manager', AT)?.logs).toEqual([{ kind: 'note', text: 'Waiting for the API key' }]);
    expect(planChange(card(), { note: 'Tests pass', noteKind: 'report' }, 'hub', AT)?.logs).toEqual([{ kind: 'report', text: 'Tests pass' }]);
  });

  it('done logs the result; the result is one line of at most 500 characters', () => {
    const plan = planChange(card({ state: 'running' }), { state: 'done', result: `Fixed\n${'x'.repeat(600)}` }, 'manager', AT);
    expect(plan?.columns.result).toHaveLength(500);
    expect(plan?.columns.result?.startsWith('Fixed x')).toBe(true);
    expect(plan?.logs[0]?.kind).toBe('done');
  });

  it('refuses an empty or too long title', () => {
    expect(() => planChange(card(), { title: '   ' }, 'owner', AT)).toThrow(ValidationError);
    expect(() => planChange(card(), { title: 'x'.repeat(301) }, 'owner', AT)).toThrow(ValidationError);
  });
});
