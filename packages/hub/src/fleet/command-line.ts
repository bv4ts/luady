import { CTL_PATH_RE } from '../config/schema.js';
import { ValidationError } from '../core/errors.js';
import { shQuote } from '../core/ids.js';

/**
 * Builds the remote command `${ctlPath} <shQuote'd args>`. The program path comes from validated
 * config and stays unquoted so `~/` expands; every argument is single-quoted. Free text never
 * reaches this function: callers send it on stdin.
 */
export function buildCommandLine(ctlPath: string, args: readonly string[]): string {
  if (!CTL_PATH_RE.test(ctlPath)) throw new ValidationError(`invalid luady-ctl path: ${JSON.stringify(ctlPath)}`);
  return [ctlPath, ...args.map((arg) => shQuote(arg))].join(' ');
}
