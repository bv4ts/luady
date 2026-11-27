import { describe, expect, it } from 'vitest';
import { TOAST_MIN_MS, nextExpiry, toastList } from '../../../../src/features/agency/model/toast-list.js';
import { notice } from '../../../fixtures.js';

const AT = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const base = { since: AT - 10_000, closed: new Set<string>(), now: AT + 4_000 };

describe('toastList', () => {
  it('keeps a settled result only while it has shown less than 6 seconds, and never one that never showed', () => {
    const settled = notice({ id: 'r', createdAt: iso(AT), settledAt: iso(AT + 3_000), settledVia: 'web' });
    expect(toastList({ ...base, notices: [settled], shownAt: new Map([['r', AT]]) }).map((n) => n.id)).toEqual(['r']);
    expect(toastList({ ...base, notices: [settled], shownAt: new Map([['r', AT]]), now: AT + TOAST_MIN_MS })).toEqual([]);
    expect(toastList({ ...base, notices: [settled], shownAt: new Map() })).toEqual([]);
  });

  it('keeps a red one until it is answered, also once it went to the chat; a dismissed one goes', () => {
    const red = notice({ id: 'q', kind: 'question', createdAt: iso(AT), chatSentAt: iso(AT + 600_000) });
    expect(toastList({ ...base, notices: [red], shownAt: new Map(), now: AT + 3_600_000 })).toHaveLength(1);
    const answered = { ...red, settledAt: iso(AT + 5_000), settledVia: 'answer' as const };
    expect(toastList({ ...base, notices: [answered], shownAt: new Map([['q', AT]]) })).toEqual([]);
    expect(toastList({ ...base, notices: [red], shownAt: new Map(), closed: new Set(['q']) })).toEqual([]);
  });

  it('never toasts a chat reply or a notice from before the page loaded', () => {
    const reply = notice({ id: 'c', kind: 'reply', ref: { kind: 'manager', id: 'm1' }, createdAt: iso(AT) });
    const old = notice({ id: 'o', createdAt: iso(AT - 60_000) });
    expect(toastList({ ...base, notices: [reply, old], shownAt: new Map() })).toEqual([]);
  });
});

describe('nextExpiry', () => {
  it('is when the first settled ordinary toast has had its 6 seconds; none for open or red ones', () => {
    const settled = notice({ id: 'r', settledAt: iso(AT + 3_000), settledVia: 'web' });
    const open = notice({ id: 'o' });
    const red = notice({ id: 'q', kind: 'permission' });
    expect(nextExpiry([settled, open, red], new Map([['r', AT]]))).toBe(AT + TOAST_MIN_MS);
    expect(nextExpiry([open, red], new Map())).toBeNull();
  });
});
