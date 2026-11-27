import { pino } from 'pino';
import type { Logger } from '../../src/core/contracts.js';

export interface CapturedLogger {
  readonly log: Logger;
  readonly lines: readonly string[];
}

/** A real pino logger that keeps every JSON line in memory. No time, pid or hostname, so any number in a line is ours. */
export function createCaptureLogger(): CapturedLogger {
  const lines: string[] = [];
  const log = pino(
    { level: 'trace', base: null, timestamp: false },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { log, lines };
}
