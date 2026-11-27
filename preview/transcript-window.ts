import type { CtlTranscript } from '@luady/shared';
import type { TranscriptWindow } from '../packages/hub/dist/core/contracts.js';

/** Whole lines only, like `luady-ctl transcript`: `tail`, `from`+`max` or `before`+`max` bytes. */
export function transcriptWindow(path: string, lines: readonly string[], window: TranscriptWindow): CtlTranscript {
  const chunks = lines.map((line) => `${line}\n`);
  const sizes = chunks.map((chunk) => Buffer.byteLength(chunk));
  const starts = sizes.reduce<number[]>((acc, size, i) => [...acc, (acc[i] ?? 0) + size], [0]);
  const size = starts[chunks.length] ?? 0;
  const max = window.tail ?? window.max ?? Number.POSITIVE_INFINITY;
  const backFrom = (end: number): number => {
    let first = end;
    while (first > 0 && (starts[end] ?? 0) - (starts[first - 1] ?? 0) <= max) first -= 1;
    return first;
  };
  let first = 0;
  let last = chunks.length;
  if (window.tail !== undefined) first = backFrom(last);
  else if (window.before !== undefined) {
    last = starts.slice(1).filter((end) => end <= (window.before ?? 0)).length;
    first = backFrom(last);
  } else if (window.from !== undefined) {
    first = starts.slice(0, -1).filter((start) => start < (window.from ?? 0)).length;
    last = first;
    while (last < chunks.length && (starts[last + 1] ?? 0) - (starts[first] ?? 0) <= max) last += 1;
  }
  const from = starts[first] ?? size;
  const to = starts[last] ?? size;
  return { path, size, from, to, data: chunks.slice(first, last).join('') };
}
