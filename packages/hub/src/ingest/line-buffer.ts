import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface LineBuffer {
  /** Feeds one chunk; returns the lines it completed, without `\n` or a trailing `\r`. Blank lines are skipped. */
  push(chunk: Buffer | string): string[];
  /** The incomplete tail still waiting for its newline. */
  pending(): string;
  /** How many over-long lines were discarded. */
  dropped(): number;
}

/**
 * Splits a byte stream into complete lines. A StringDecoder keeps multi-byte UTF-8 sequences that
 * straddle chunk boundaries intact. A line longer than `maxLineBytes` is discarded up to its newline.
 */
export function createLineBuffer(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES): LineBuffer {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let discarding = false;
  let droppedLines = 0;

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const parts = `${carry}${text}`.split('\n');
      const tail = parts.pop() ?? '';
      const lines: string[] = [];
      for (const part of parts) {
        if (discarding) {
          discarding = false;
          continue;
        }
        const line = part.endsWith('\r') ? part.slice(0, -1) : part;
        if (line !== '') lines.push(line);
      }
      if (Buffer.byteLength(tail, 'utf8') > maxLineBytes) {
        if (!discarding) droppedLines += 1;
        discarding = true;
        carry = '';
      } else {
        carry = discarding ? '' : tail;
      }
      return lines;
    },
    pending: () => carry,
    dropped: () => droppedLines,
  };
}
