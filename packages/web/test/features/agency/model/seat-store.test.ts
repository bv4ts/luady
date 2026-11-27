import { describe, expect, it, vi } from 'vitest';
import { SEATS_KEY, loadSeats, saveSeats } from '../../../../src/features/agency/model/seat-store.js';

const storageWith = (raw: string | null) => ({ getItem: vi.fn(() => raw) });

describe('loadSeats', () => {
  it('reads the saved desk numbers', () => {
    const storage = storageWith(JSON.stringify({ 'birch:a': 0, 'cedar:b': 7 }));
    expect(loadSeats(storage)).toEqual({ 'birch:a': 0, 'cedar:b': 7 });
    expect(storage.getItem).toHaveBeenCalledWith(SEATS_KEY);
    expect(SEATS_KEY).toBe('hub.agency.seats');
  });

  it('returns {} for missing, corrupt or wrongly shaped data', () => {
    for (const raw of [null, '', '{bad', 'null', '42', '"text"', '[1,2]']) {
      expect(loadSeats(storageWith(raw))).toEqual({});
    }
  });

  it('drops entries that are not whole, non-negative desk numbers', () => {
    const raw = JSON.stringify({ ok: 3, neg: -1, half: 1.5, text: '2', big: 1e9, none: null });
    expect(loadSeats(storageWith(raw))).toEqual({ ok: 3 });
  });

  it('returns {} when the storage itself throws', () => {
    const storage = { getItem: () => { throw new Error('SecurityError'); } };
    expect(loadSeats(storage)).toEqual({});
  });
});

describe('saveSeats', () => {
  it('writes the seats as JSON under the key', () => {
    const storage = { setItem: vi.fn() };
    saveSeats(storage, { 'birch:a': 2 });
    expect(storage.setItem).toHaveBeenCalledWith(SEATS_KEY, '{"birch:a":2}');
  });

  it('never throws when the storage is full or blocked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => saveSeats(storage, { 'birch:a': 2 })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
