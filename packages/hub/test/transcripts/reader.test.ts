import { describe, expect, it } from 'vitest';
import type { CtlTranscript } from '@luady/shared';
import type { CtlClient, TranscriptWindow } from '../../src/core/contracts.js';
import { ValidationError } from '../../src/core/errors.js';
import { CHUNK_BYTES, condensedTranscript, readTranscriptPage } from '../../src/transcripts/reader.js';
import { createFakeCtl } from '../helpers/fakes.js';

function userLine(i: number): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${i}`,
    timestamp: `2026-10-09T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
    message: { role: 'user', content: `message ${i}` },
  });
}

const CONTENT = `${Array.from({ length: 30 }, (_, i) => userLine(i)).join('\n')}\n`;

/** Fake `luady-ctl transcript`: complete lines only, `--tail N`, `--before B --max N`. */
function transcriptSource(content: string): { ctl: CtlClient; windows: TranscriptWindow[]; starts: number[] } {
  const bytes = Buffer.from(content, 'utf8');
  const starts: number[] = [];
  const ends: number[] = [];
  let lineStart = 0;
  bytes.forEach((byte, index) => {
    if (byte !== 0x0a) return;
    starts.push(lineStart);
    ends.push(index + 1);
    lineStart = index + 1;
  });
  const windows: TranscriptWindow[] = [];
  const slice = (from: number, to: number): CtlTranscript => ({
    path: '/home/dev/.claude/projects/x/sid-1.jsonl',
    size: bytes.length,
    from,
    to,
    data: bytes.subarray(from, to).toString('utf8'),
  });
  const ctl = createFakeCtl({
    transcript: async (_sessionId, window) => {
      windows.push(window);
      if (window.tail !== undefined) {
        const min = bytes.length - window.tail;
        return slice(starts.find((start) => start >= min) ?? bytes.length, bytes.length);
      }
      const to = [...ends].reverse().find((end) => end <= (window.before ?? 0)) ?? 0;
      const from = starts.find((start) => start >= to - (window.max ?? 0) && start < to) ?? to;
      return slice(from, to);
    },
  });
  return { ctl, windows, starts };
}

describe('readTranscriptPage', () => {
  it('returns the newest page first with a byte-offset cursor', async () => {
    const { ctl, windows, starts } = transcriptSource(CONTENT);
    const page = await readTranscriptPage(ctl, 'sid-1', null, 5);
    expect(page.items.map((item) => item.text)).toEqual(['message 25', 'message 26', 'message 27', 'message 28', 'message 29']);
    expect(page.nextCursor).toBe(String(starts[25]));
    expect(windows).toEqual([{ tail: CHUNK_BYTES }]);
  });

  it('walks older pages with before/max until the start', async () => {
    const { ctl } = transcriptSource(CONTENT);
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page = await readTranscriptPage(ctl, 'sid-1', cursor, 5);
      pages.push(page.items.map((item) => item.text));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(pages).toHaveLength(6);
    expect([...pages].reverse().flat()).toEqual(Array.from({ length: 30 }, (_, i) => `message ${i}`));
  });

  it('fetches more chunks when one chunk holds too few items', async () => {
    const { ctl, windows, starts } = transcriptSource(CONTENT);
    const page = await readTranscriptPage(ctl, 'sid-1', null, 3, 200);
    expect(page.items.map((item) => item.text)).toEqual(['message 27', 'message 28', 'message 29']);
    expect(page.nextCursor).toBe(String(starts[27]));
    expect(windows).toEqual([{ tail: 200 }, { before: starts[29], max: 200 }, { before: starts[28], max: 200 }]);
  });

  it('condensed renders the last N items as text', async () => {
    const { ctl } = transcriptSource(CONTENT);
    await expect(condensedTranscript(ctl, 'sid-1', 2)).resolves.toBe('[user] message 28\n[user] message 29');
    await expect(condensedTranscript(transcriptSource('').ctl, 'sid-1', 5)).resolves.toBe('(no messages yet)');
  });

  it('rejects malformed cursors and limits', async () => {
    const { ctl } = transcriptSource(CONTENT);
    await expect(readTranscriptPage(ctl, 'sid-1', 'abc', 5)).rejects.toBeInstanceOf(ValidationError);
    await expect(readTranscriptPage(ctl, 'sid-1', '-1', 5)).rejects.toBeInstanceOf(ValidationError);
    await expect(readTranscriptPage(ctl, 'sid-1', null, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(condensedTranscript(ctl, 'sid-1', 101)).rejects.toBeInstanceOf(ValidationError);
  });
});
