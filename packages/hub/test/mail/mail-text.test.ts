import { describe, expect, it } from 'vitest';
import { MAIL_SCAN_MAX, htmlToText, tidyMailBody } from '../../src/mail/mail-text.js';
import { HOSTILE_INPUT_BUDGET_MS, elapsedMs } from '../helpers/timing.js';

describe('htmlToText', () => {
  it('drops style and script blocks, then every tag', () => {
    expect(htmlToText('<p>Hi</p><STYLE type="x">p { color: red }</style><script>alert(1)</script>there')).toBe(' Hi there');
    expect(htmlToText('a <b>bold</b> word')).toBe('a  bold  word');
  });

  it('drops an unclosed style block to the end and keeps a lone "<"', () => {
    expect(htmlToText('before<style>p {}')).toBe('before');
    expect(htmlToText('1 < 2 and <i>x</i>')).toBe('1 < 2 and  x ');
  });

  it('reads only the first MAIL_SCAN_MAX characters', () => {
    expect(htmlToText(`${'a'.repeat(MAIL_SCAN_MAX)}tail`)).toBe('a'.repeat(MAIL_SCAN_MAX));
  });

  it('handles hostile HTML (a page full of "<", unclosed blocks) well under a second', () => {
    expect(elapsedMs(() => htmlToText('<'.repeat(MAIL_SCAN_MAX)))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    expect(elapsedMs(() => htmlToText('<style'.repeat(MAIL_SCAN_MAX / 6)))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    expect(elapsedMs(() => htmlToText('<script>'.repeat(MAIL_SCAN_MAX / 8)))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
  });
});

describe('tidyMailBody', () => {
  it('drops trailing spaces and blank lines, keeps indentation', () => {
    expect(tidyMailBody('  \nHello  \r\n\r\n   \n  indented\nend  ')).toBe('Hello\n  indented\nend');
  });

  it('handles a huge run of spaces well under a second', () => {
    expect(elapsedMs(() => tidyMailBody(`${' '.repeat(MAIL_SCAN_MAX)}x`))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
  });
});
