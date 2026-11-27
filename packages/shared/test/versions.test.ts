import { describe, expect, it } from 'vitest';
import { KIT_V2, KIT_V21, versionAtLeast } from '../src/versions.js';

describe('KIT_V2', () => {
  it('is the first kit version with step events, the pause verbs, sign-out and permission previews', () => {
    expect(KIT_V2).toBe('2.0.0');
  });
});

describe('KIT_V21', () => {
  it('is the first kit version with the skills, kb-put and git-status verbs', () => {
    expect(KIT_V21).toBe('2.1.0');
    expect(versionAtLeast(KIT_V21, KIT_V2)).toBe(true);
  });
});

describe('versionAtLeast', () => {
  it.each([
    ['2.0.0', '2.0.0', true],
    ['1.9.9', '2.0.0', false],
    ['2.1', '2.0.0', true],
    ['2.0.0', '2.0.1', false],
    ['10.0.0', '9.9.9', true],
    ['2', '2.0.0', true],
    ['2.0.0', '2', true],
    ['1.10.0', '1.9.0', true],
  ])('versionAtLeast(%j, %j) is %s', (version, min, expected) => {
    expect(versionAtLeast(version, min)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a non-numeric part', '2.x'],
    ['a leading dot', '.2.0'],
    ['a trailing dot', '2.0.'],
    ['a pre-release suffix', '2.0.0-beta'],
    ['a negative part', '-2.0.0'],
  ])('is false for %s', (_label, version) => {
    expect(versionAtLeast(version, '2.0.0')).toBe(false);
  });

  it('is false when the minimum itself is not a version', () => {
    expect(versionAtLeast('2.0.0', 'latest')).toBe(false);
  });
});
