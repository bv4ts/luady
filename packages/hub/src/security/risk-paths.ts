import { posix } from 'node:path';

/** Deny-listed fragments, matched case-insensitively against the raw and normalized text. */
export const DENIED_FRAGMENTS: readonly string[] = [
  '.ssh',
  '.credentials.json',
  'etc/shadow',
  'etc/gshadow',
  'etc/sudoers',
  '.luady/answers',
];

/** Protected locations as path components; '*' is any single component. */
const SENSITIVE_PATHS: ReadonlyArray<readonly string[]> = [
  ['home', '*', '.ssh'],
  ['home', '*', '.claude', '.credentials.json'],
  ['home', '*', '.luady', 'answers'],
  ['root', '.ssh'],
  ['etc', 'shadow'],
  ['etc', 'gshadow'],
  ['etc', 'sudoers'],
  ['etc', 'sudoers.d'],
];

/** Pseudo filesystems that alias other paths (/proc/<pid>/root, /dev/fd, …). */
const VIRTUAL_ROOTS: readonly string[] = ['proc', 'sys', 'dev'];
const PROC_ALIAS_RE = /\/proc\/[^/]+\/(?:task\/[^/]+\/)?(root|cwd|fd|map_files)(\/|$)/i;
const GLOB_RE = /[*?[]/;
const UNKNOWN_TILDE_RE = /^~[+\-\d]/;
const REGEX_SPECIAL_RE = /[\\^$.*+?()[\]{}|]/;

export function referencesDeniedPath(text: string): boolean {
  const forms = [text, posix.normalize(text)].map((form) => form.toLowerCase());
  return forms.some((form) => PROC_ALIAS_RE.test(form) || DENIED_FRAGMENTS.some((fragment) => form.includes(fragment)));
}

/** Absolute POSIX path for a word; `~` is any user's home. Null when the word depends on an unknown directory. */
export function toAbsolute(word: string, cwd: string | null): string | null {
  if (UNKNOWN_TILDE_RE.test(word)) return null;
  if (word === '~' || word.startsWith('~/')) return posix.normalize(`/home/*${word.slice(1)}`);
  if (word.startsWith('~')) return posix.normalize(`/home/${word.slice(1)}`);
  if (word.startsWith('/')) return posix.normalize(word);
  return cwd === null ? null : posix.normalize(posix.join(cwd, word));
}

function components(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

function bracketClose(component: string, open: number): number {
  let start = open + 1;
  if (component.charAt(start) === '!' || component.charAt(start) === '^') start += 1;
  if (component.charAt(start) === ']') start += 1;
  return component.indexOf(']', start);
}

/** Over-approximates one glob component; each bracket class becomes "any one character". */
function globToRegExp(component: string): RegExp {
  let source = '';
  let i = 0;
  while (i < component.length) {
    const ch = component.charAt(i);
    const close = ch === '[' ? bracketClose(component, i) : -1;
    if (ch === '*') source += '.*';
    else if (ch === '?' || close !== -1) source += '.';
    else source += REGEX_SPECIAL_RE.test(ch) ? `\\${ch}` : ch;
    i = close !== -1 ? close + 1 : i + 1;
  }
  return new RegExp(`^${source}$`, 'i');
}

function componentMatches(part: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (GLOB_RE.test(part)) return globToRegExp(part).test(pattern);
  return part.toLowerCase() === pattern.toLowerCase();
}

/** True when the shared leading components of `parts` and `pattern` all match. */
function prefixesMatch(parts: readonly string[], pattern: readonly string[]): boolean {
  const shared = Math.min(parts.length, pattern.length);
  for (let i = 0; i < shared; i += 1) {
    if (!componentMatches(parts[i] ?? '', pattern[i] ?? '')) return false;
  }
  return true;
}

function inVirtualRoot(parts: readonly string[]): boolean {
  const first = parts[0];
  return first !== undefined && VIRTUAL_ROOTS.some((root) => componentMatches(first, root));
}

/** True when an unquoted glob could expand to a protected location or something inside it. */
export function globMayHitDenied(word: string, cwd: string | null): boolean {
  const absolute = toAbsolute(word, cwd);
  if (absolute === null) return true;
  const parts = components(absolute);
  if (inVirtualRoot(parts)) return true;
  return SENSITIVE_PATHS.some((pattern) => parts.length >= pattern.length && prefixesMatch(parts, pattern));
}

/** True when a recursive search rooted at `word` cannot reach a protected location. */
export function isRecursionSafe(word: string, cwd: string | null): boolean {
  const absolute = toAbsolute(word, cwd);
  if (absolute === null) return false;
  const parts = components(absolute);
  if (inVirtualRoot(parts)) return false;
  return !SENSITIVE_PATHS.some((pattern) => prefixesMatch(parts, pattern));
}
