import { describe, expect, it } from 'vitest';
import { createLineBuffer } from '../../src/ingest/line-buffer.js';

describe('createLineBuffer', () => {
  it('returns complete lines and keeps the partial tail', () => {
    const buffer = createLineBuffer();
    expect(buffer.push('a\nb\nc')).toEqual(['a', 'b']);
    expect(buffer.pending()).toBe('c');
    expect(buffer.push('d\n')).toEqual(['cd']);
    expect(buffer.pending()).toBe('');
  });

  it('reassembles a JSON line split at every byte boundary', () => {
    const line = JSON.stringify({
      file: 'events-20261009.jsonl',
      offset: 4096,
      event: { text: 'مرحبا 👋 "quoted" $(x) `y`' },
    });
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const buffer = createLineBuffer();
      const first = buffer.push(bytes.subarray(0, cut));
      const second = buffer.push(bytes.subarray(cut));
      expect([...first, ...second]).toEqual([line]);
    }
  });

  it('decodes a 4-byte emoji split across three chunks', () => {
    const bytes = Buffer.from('👋\n', 'utf8');
    const buffer = createLineBuffer();
    expect(buffer.push(bytes.subarray(0, 1))).toEqual([]);
    expect(buffer.push(bytes.subarray(1, 3))).toEqual([]);
    expect(buffer.push(bytes.subarray(3))).toEqual(['👋']);
  });

  it('strips CRLF endings and skips blank lines', () => {
    expect(createLineBuffer().push('one\r\n\r\ntwo\n')).toEqual(['one', 'two']);
  });

  it('returns many lines from one chunk in order', () => {
    const text = `${Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')}\n`;
    const lines = createLineBuffer().push(text);
    expect(lines).toHaveLength(50);
    expect(lines[49]).toBe('line-49');
  });

  it('drops an over-long line and recovers at the next newline', () => {
    const buffer = createLineBuffer(16);
    expect(buffer.push('x'.repeat(20))).toEqual([]);
    expect(buffer.dropped()).toBe(1);
    expect(buffer.push('yyy\nok\n')).toEqual(['ok']);
    expect(buffer.pending()).toBe('');
  });
});
