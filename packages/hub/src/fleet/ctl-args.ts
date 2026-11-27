import { CtlKbPutInputSchema, LIMITS, NAME_RE, QID_RE, TARGET_RE, type CtlKbFile } from '@luady/shared';
import type { CtlKey, TranscriptWindow } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';

export const FREE_TEXT_MAX = LIMITS.sendTextMax;
export const FILE_CONTENT_MAX = 500_000;
export const FILE_READ_MAX = 1_000_000;
/** Binary file fetch (send_file): 50 MiB raw (about 67 MiB as base64 on the wire). */
export const FILE_GET_MAX = 50 * 1024 * 1024;
/** Upload (file_upload): same 50 MiB cap; the kit accepts up to 64 MiB. */
export const FILE_PUT_MAX = 50 * 1024 * 1024;
export const UPLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function checkUploadName(name: string): string {
  if (!UPLOAD_NAME_RE.test(name) || name.includes('..')) throw new ValidationError(`invalid upload file name: ${JSON.stringify(name)}`);
  return name;
}
export const EXEC_TIMEOUT_MAX_SEC = 600;
const CTL_KEYS: readonly CtlKey[] = ['Escape', 'C-c', 'Enter'];
const CONFIG_KEYS = ['remote_answering', 'hook_wait_seconds'] as const;
const CONFIG_VALUE_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function checkTarget(target: string): string {
  if (!TARGET_RE.test(target)) throw new ValidationError(`invalid tmux target: ${JSON.stringify(target)}`);
  return target;
}

export function checkQid(qid: string): string {
  if (!QID_RE.test(qid)) throw new ValidationError(`invalid question id: ${JSON.stringify(qid)}`);
  return qid;
}

export function checkName(value: string, what = 'name'): string {
  if (!NAME_RE.test(value)) throw new ValidationError(`invalid ${what}: ${JSON.stringify(value)}`);
  return value;
}

export function checkPath(path: string): string {
  if (!path.startsWith('/') || path.length > 1024 || /[\0\n\r]/.test(path)) {
    throw new ValidationError(`invalid absolute path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function checkKey(key: string): CtlKey {
  const found = CTL_KEYS.find((candidate) => candidate === key);
  if (found === undefined) throw new ValidationError(`unsupported key: ${JSON.stringify(key)}`);
  return found;
}

export function checkInt(value: number, min: number, max: number, what: string): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${what} must be an integer in ${min}..${max}`);
  }
  return String(value);
}

/** Free text for stdin: bounded, NUL-free, non-blank unless `allowEmpty`. Never placed in argv. */
export function checkText(text: string, max: number, what: string, allowEmpty = false): string {
  if (typeof text !== 'string') throw new ValidationError(`${what} must be a string`);
  if (!allowEmpty && text.trim() === '') throw new ValidationError(`${what} must not be empty`);
  if (text.length > max) throw new ValidationError(`${what} must be at most ${max} characters`);
  if (text.includes('\0')) throw new ValidationError(`${what} must not contain NUL characters`);
  return text;
}

/** C0 control characters other than tab, line feed and carriage return, and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const CONTROL_CHARS_RE = new RegExp(CONTROL_CHAR_RE.source, 'g');

/**
 * The same control characters, each replaced by a visible `<U+XXXX>` mark: text from outside (mail, a server, pasted
 * terminal output) can then always be typed into a pane, and shows what it held.
 */
export function markControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, (char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

/**
 * Text the kit types into a pane (`send`, a `start` prompt): checkText, plus no control character but line breaks and
 * tabs. Another one would reach the pane as a key (two Ctrl-C leave Claude Code), not as text; the kit refuses it too.
 */
export function checkTypedText(text: string, max: number, what: string, allowEmpty = false): string {
  checkText(text, max, what, allowEmpty);
  const found = CONTROL_CHAR_RE.exec(text);
  if (found !== null) {
    const code = found[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new ValidationError(`${what} must not contain control characters (found U+${code}); only line breaks and tabs`);
  }
  return text;
}

export function checkConfigKey(key: string): (typeof CONFIG_KEYS)[number] {
  const found = CONFIG_KEYS.find((candidate) => candidate === key);
  if (found === undefined) throw new ValidationError(`unsupported config key: ${JSON.stringify(key)}`);
  return found;
}

export function checkConfigValue(value: string): string {
  if (!CONFIG_VALUE_RE.test(value)) throw new ValidationError(`invalid config value: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The stdin of `kb-put`: relative `.md` paths inside ~/luady-kb/ (no `..`, no absolute paths), at most 2 MB in all.
 * The kit checks the same again and refuses symlinks out of the folder.
 */
export function kbPutPayload(files: readonly CtlKbFile[], prune: boolean): string {
  const parsed = CtlKbPutInputSchema.safeParse({ files, prune });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(`invalid kb-put payload: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return JSON.stringify(parsed.data);
}

/** Transcript window: exactly one of `--tail N`, `--from B --max N`, `--before B --max N`. */
export function transcriptArgs(window: TranscriptWindow): string[] {
  const modes = [window.tail, window.from, window.before].filter((value) => value !== undefined).length;
  if (modes !== 1) throw new ValidationError('transcript window needs exactly one of tail, from or before');
  const chunkMax = LIMITS.transcriptChunkMax;
  if (window.tail !== undefined) return ['--tail', checkInt(window.tail, 1, chunkMax, 'tail')];
  const max = checkInt(window.max ?? chunkMax, 1, chunkMax, 'max');
  if (window.from !== undefined) {
    return ['--from', checkInt(window.from, 0, Number.MAX_SAFE_INTEGER, 'from'), '--max', max];
  }
  return ['--before', checkInt(window.before ?? 0, 0, Number.MAX_SAFE_INTEGER, 'before'), '--max', max];
}
