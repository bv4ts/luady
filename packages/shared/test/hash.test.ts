import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeForHash, promptHash } from '../src/hash.js';

// "مرحبا يا صديقي" written as escapes so the bytes cannot change in transit.
const ARABIC = '\u0645\u0631\u062d\u0628\u0627 \u064a\u0627 \u0635\u062f\u064a\u0642\u064a';
const ROCKET = '\u{1F680}';
const NBSP = '\u00a0';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('normalizeForHash', () => {
  it('turns every CRLF into LF', () => {
    expect(normalizeForHash('line1\r\nline2\r\n\r\nline3')).toBe('line1\nline2\n\nline3');
  });

  it('strips space, tab, LF, CR, FF and VT at both ends only', () => {
    expect(normalizeForHash(' \t\v\f\r\n a  b \n\r\f\v\t ')).toBe('a  b');
  });

  it('keeps a lone CR and non-breaking spaces', () => {
    expect(normalizeForHash('a\rb')).toBe('a\rb');
    expect(normalizeForHash(`${NBSP}hi${NBSP}`)).toBe(`${NBSP}hi${NBSP}`);
  });
});

describe('promptHash', () => {
  it('equals sha256 of the normalized UTF-8 text', () => {
    expect(promptHash('  hi\r\n')).toBe(sha256('hi'));
  });

  // Cross-checked with CPython 3.13:
  // hashlib.sha256(t.replace('\r\n', '\n').strip(' \t\n\r\f\v').encode('utf-8')).hexdigest()
  it.each([
    ['  hi\r\n', '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4'],
    ['a\r\nb', '7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78'],
    [`  ${ARABIC}\n`, '6ce283826bb9df66cad3b611db4f4f109b1c5086c4a91826ce1231f15db47bc8'],
    [`deploy ${ROCKET}\r\n\r\n`, '57fdf98ca29cf942b2d629013787fbf689714ce6c0de0ac18b21a87466a5fc47'],
    ['\t\v\fx\f\v\t', '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'],
    ['a\rb', 'af9081672dd5ef3247a30c2db5b0dafcc9bcf981a26aefb3c55d210d43fcc14e'],
    [`${NBSP}hi${NBSP}`, '7d126793cedcb0d197fc118d25e080f966a4195daaeaefdbdc8ab9e4bcc7d3bd'],
    ['line1\r\nline2\r\n\r\nline3\r\n', '795d57b9c79dc1ae5c392c3dfabf3dded0febd34dae512aac5e9930a987d2e3f'],
    ['', EMPTY_SHA256],
    [' \r\n\t ', EMPTY_SHA256],
  ])('parity vector %# matches server-kit', (input, expected) => {
    expect(promptHash(input)).toBe(expected);
  });

  it('always returns 64 lowercase hex characters', () => {
    expect(promptHash(ARABIC)).toMatch(/^[a-f0-9]{64}$/);
  });
});
