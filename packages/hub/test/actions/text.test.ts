import { describe, expect, it } from 'vitest';
import { clipText, oneLine, sessionLabel } from '../../src/actions/text.js';

describe('text helpers', () => {
  it('clips without splitting a surrogate pair', () => {
    expect(clipText('abc', 5)).toBe('abc');
    expect(clipText('abcdef', 3)).toBe('abc…');
    expect(clipText('a😀b', 2)).toBe('a…');
    expect(clipText('abcdef', 3, ' [more]')).toBe('abc [more]');
  });

  it('collapses whitespace into one line', () => {
    expect(oneLine('  a\n\tb   c  ', 10)).toBe('a b c');
    expect(oneLine('one two three', 7)).toBe('one two…');
  });

  it('formats the session label', () => {
    expect(sessionLabel({ host: 'cedar', displayName: 'meadow-hr' })).toBe('cedar · meadow-hr');
  });
});
