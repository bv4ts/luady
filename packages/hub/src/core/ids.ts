import { createHash, randomUUID } from 'node:crypto';
import { ValidationError } from './errors.js';

const UNSAFE_ARG_CHARS = /[\0\n]/;

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * POSIX single-quote escaping for ONE regex-validated argv element of a remote command line.
 * Free text (messages, prompts, commands, file contents) never goes through here: it travels on stdin.
 */
export function shQuote(arg: string): string {
  if (UNSAFE_ARG_CHARS.test(arg)) {
    throw new ValidationError('Shell argument must not contain NUL or newline characters');
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
