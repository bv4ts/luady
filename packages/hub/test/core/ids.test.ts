import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { newId, sha256Hex, shQuote } from '../../src/core/ids.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('returns a fresh random UUID v4', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(b).not.toBe(a);
  });
});

describe('sha256Hex', () => {
  it('hashes the UTF-8 bytes of the text', () => {
    expect(sha256Hex('hi')).toBe('8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const arabic = '\u0645\u0631\u062d\u0628\u0627 \u{1F680}';
    expect(sha256Hex(arabic)).toBe(createHash('sha256').update(Buffer.from(arabic, 'utf8')).digest('hex'));
  });
});

describe('shQuote', () => {
  it.each([
    ['plain', "'plain'"],
    ['', "''"],
    ['two words', "'two words'"],
    ["it's", "'it'\\''s'"],
    ["''", "''\\'''\\'''"],
    ['$HOME and $(id)', "'$HOME and $(id)'"],
    ['`uname -a`', "'`uname -a`'"],
    ['a\\b"c', '\'a\\b"c\''],
    ['tab\there\rcr', "'tab\there\rcr'"],
    ['\u0645\u0631\u062d\u0628\u0627 \u{1F680}', "'\u0645\u0631\u062d\u0628\u0627 \u{1F680}'"],
  ])('quotes %j as %s', (input, expected) => {
    expect(shQuote(input)).toBe(expected);
  });

  it.each(['line1\nline2', 'nul\0byte', '\n'])('throws ValidationError for %j', (input) => {
    expect(() => shQuote(input)).toThrow(ValidationError);
  });
});
