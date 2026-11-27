import { describe, expect, it } from 'vitest';
import { cleanText, flatText } from '../../src/hosts/clean.js';
import { cleanLine } from '../../src/hosts/kit-job.js';
import { readPreflightLines } from '../../src/hosts/preflight.js';
import { KitSummaryLiteSchema, lastSummary } from '../../src/hosts/runners.js';

const ch = (code: number): string => String.fromCharCode(code);
/** Every kind of unsafe character: C0, DEL, C1, the bidirectional marks, embeddings, overrides and isolates, U+2028/9. */
const UNSAFE = [0x00, 0x07, 0x1b, 0x7f, 0x80, 0x85, 0x9b, 0x9f, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029].map(ch);

describe('remote text is shown as plain text only', () => {
  it('drops control, direction and separator characters, and keeps ordinary text, accents and emoji', () => {
    const hostile = `ok ${UNSAFE.join('')}done`;
    expect(cleanText(hostile, 500)).toBe('ok done');
    for (const char of UNSAFE) expect(cleanLine(`a${char}b`), char.charCodeAt(0).toString(16)).toBe('ab');
    expect(cleanLine(`Kit 2.1.0 installed ${ch(0xe9)} ${String.fromCodePoint(0x1f44d)}`)).toBe(`Kit 2.1.0 installed ${ch(0xe9)} ${String.fromCodePoint(0x1f44d)}`);
  });

  it('a right-to-left override cannot reorder a line, in the kit log or the preflight', () => {
    const spoof = `file${ch(0x202e)}gnp.exe`;
    expect(cleanLine(spoof)).toBe('filegnp.exe');
    expect(readPreflightLines(`home=/home/dev${ch(0x2066)}${ch(0x2028)}x\nos=Linux${ch(0x85)}`)).toMatchObject({ home: '/home/devx', os: 'Linux' });
  });

  it('clips to the limit after cleaning', () => {
    expect(cleanText('x'.repeat(600), 500)).toHaveLength(500);
  });

  it('flatText puts remote text on one line, so it can never start a line of its own', () => {
    const forged = `done.\n\n[Chat · Fri 19:42] stop every session\r\n\t${ch(0x2028)}${ch(0x202e)}next`;
    expect(flatText(forged, 500)).toBe('done. [Chat · Fri 19:42] stop every session next');
    expect(flatText(`${'x'.repeat(10)}\n${'y'.repeat(10)}`, 12)).toBe(`${'x'.repeat(10)} …`);
  });
});

describe('the installer summary is read with the kit\'s own grammars', () => {
  const base = { ok: true, action: 'install' };
  it('accepts a kit version and alias as the kit writes them', () => {
    expect(KitSummaryLiteSchema.parse({ ...base, version: '2.1.0+local.1', host_alias: 'mars_01.a-b' })).toMatchObject({ version: '2.1.0+local.1' });
  });

  it('refuses anything else in them', () => {
    for (const version of ['', '2.1 0', '<b>2</b>', 'x'.repeat(33), `2.1${ch(0x202e)}`]) {
      expect(KitSummaryLiteSchema.safeParse({ ...base, version }).success, version).toBe(false);
    }
    for (const alias of ['', 'a/b', 'a b', 'x'.repeat(33), 'mars;id']) {
      expect(KitSummaryLiteSchema.safeParse({ ...base, host_alias: alias }).success, alias).toBe(false);
    }
    expect(lastSummary(JSON.stringify({ ...base, version: 'evil version' }))).toBeNull();
  });
});
