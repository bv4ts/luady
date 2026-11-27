import { describe, expect, it } from 'vitest';
import { assignSeats, type SeatInput, type SeatMap } from '../src/seats.js';

const inRoom = (room: string, ids: readonly string[]): SeatInput[] => ids.map((id) => ({ id, room }));
const many = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

describe('assignSeats', () => {
  it('seats newcomers at the lowest free desks in id order', () => {
    const r = assignSeats(inRoom('birch', ['c', 'a', 'b']), {});
    expect(r.seats).toEqual({ a: 0, b: 1, c: 2 });
    expect(r.modes).toEqual({ birch: 'normal' });
    expect(r.overflow).toEqual({ birch: [] });
  });

  it('keeps everyone else in place when one leaves', () => {
    const first = assignSeats(inRoom('birch', ['a', 'b', 'c']), {});
    const after = assignSeats(inRoom('birch', ['a', 'c']), first.seats);
    expect(after.seats).toEqual({ a: 0, c: 2 });
  });

  it('gives a newcomer the freed desk without moving anyone', () => {
    const after = assignSeats(inRoom('birch', ['a', 'c', 'd']), { a: 0, c: 2 });
    expect(after.seats).toEqual({ a: 0, c: 2, d: 1 });
  });

  it('keeps everyone in place when a newcomer arrives with a lower id', () => {
    const after = assignSeats(inRoom('birch', ['m', 'n', 'a']), { m: 0, n: 1 });
    expect(after.seats).toEqual({ m: 0, n: 1, a: 2 });
  });

  it('switches to tight desks above 12 sessions and keeps earlier desk numbers', () => {
    const ids = many('s', 13);
    const before = assignSeats(inRoom('birch', ids.slice(0, 12)), {});
    const r = assignSeats(inRoom('birch', ids), before.seats);
    expect(r.modes.birch).toBe('tight');
    const indices = Object.values(r.seats);
    expect(indices).toHaveLength(13);
    expect(new Set(indices).size).toBe(13);
    expect(indices.every((i) => i >= 0 && i < 20)).toBe(true);
    ids.slice(0, 12).forEach((id) => expect(r.seats[id]).toBe(before.seats[id]));
  });

  it('seats 20 of 21 and reports the rest as overflow', () => {
    const ids = many('s', 21);
    const r = assignSeats(inRoom('birch', ids), {});
    expect(Object.keys(r.seats)).toHaveLength(20);
    expect(r.overflow.birch).toEqual(['s20']);
    expect(new Set(Object.values(r.seats)).size).toBe(20);
  });

  it('overflows a newcomer before anyone who already had a desk', () => {
    const seated = many('b', 20);
    const previous = assignSeats(inRoom('birch', seated), {}).seats;
    const r = assignSeats(inRoom('birch', ['a00', ...seated]), previous);
    expect(r.overflow.birch).toEqual(['a00']);
    seated.forEach((id) => expect(r.seats[id]).toBe(previous[id]));
  });

  it('overflows the highest newcomer ids first', () => {
    const r = assignSeats(inRoom('birch', many('n', 23)), {});
    expect(r.overflow.birch).toEqual(['n20', 'n21', 'n22']);
  });

  it('moves a desk number that the arrangement no longer has', () => {
    const r = assignSeats(inRoom('birch', ['a', 'b', 'c']), { a: 15, b: 0 });
    expect(r.modes.birch).toBe('normal');
    expect(r.seats.b).toBe(0);
    expect(r.seats.a).toBeLessThan(12);
    expect(new Set(Object.values(r.seats)).size).toBe(3);
  });

  it('gives a moved session priority over newcomers', () => {
    const r = assignSeats(inRoom('birch', ['a', 'b']), { b: 40 });
    expect(r.seats).toEqual({ b: 0, a: 1 });
  });

  it('settles two sessions claiming one desk by id', () => {
    const r = assignSeats(inRoom('birch', ['x', 'y']), { y: 3, x: 3 });
    expect(r.seats).toEqual({ x: 3, y: 0 });
  });

  it('ignores desk numbers that are not whole and non-negative', () => {
    const r = assignSeats(inRoom('birch', ['a', 'b', 'c']), { a: -1, b: 1.5, c: Number.NaN });
    expect(r.seats).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('numbers desks per room', () => {
    const r = assignSeats([...inRoom('birch', ['a']), ...inRoom('ash', ['b'])], {});
    expect(r.seats).toEqual({ a: 0, b: 0 });
    expect(r.modes).toEqual({ birch: 'normal', ash: 'normal' });
  });

  it('drops sessions that are gone and seats a repeated id once', () => {
    const r = assignSeats(inRoom('birch', ['a', 'a']), { a: 4, gone: 0 });
    expect(r.seats).toEqual({ a: 4 });
  });

  it('does not change its inputs and returns frozen values', () => {
    const sessions = inRoom('birch', ['b', 'a']);
    const previous: SeatMap = { a: 1 };
    const r = assignSeats(sessions, previous);
    expect(sessions.map((s) => s.id)).toEqual(['b', 'a']);
    expect(previous).toEqual({ a: 1 });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.seats)).toBe(true);
    expect(Object.isFrozen(r.overflow.birch)).toBe(true);
  });

  it('handles no sessions', () => {
    expect(assignSeats([], { a: 1 })).toEqual({ seats: {}, modes: {}, overflow: {} });
  });
});
