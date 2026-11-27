import { posix } from 'node:path';
import { globMayHitDenied, isRecursionSafe, referencesDeniedPath, toAbsolute } from './risk-paths.js';
import { checkProgram } from './risk-programs.js';
import { lexCommand, type Segment, type Word } from './shell-lexer.js';

export interface RiskVerdict {
  tier: 0 | 1;
  reason: string;
}

const QUOTE_MAX = 60;

function tier1(reason: string): RiskVerdict {
  return { tier: 1, reason };
}

function quoted(text: string): string {
  return JSON.stringify(text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text);
}

function wordProblem(word: Word, cwd: string | null): string | null {
  const resolved = toAbsolute(word.text, cwd);
  if (referencesDeniedPath(word.text) || (resolved !== null && referencesDeniedPath(resolved))) {
    return `${quoted(word.text)} refers to a protected path`;
  }
  if (word.glob && globMayHitDenied(word.text, cwd)) return `glob ${quoted(word.text)} may match a protected path`;
  return null;
}

/** grep -r and rg may search the cwd implicitly, so the cwd and every argument must be recursion-safe. */
function recursionProblem(args: readonly Word[], cwd: string | null): string | null {
  if (cwd === null) return 'recursive search needs a known working directory';
  if (!isRecursionSafe('.', cwd)) return `recursive search from ${cwd} could read protected files`;
  const unsafe = args.find((word) => !isRecursionSafe(word.text, cwd));
  return unsafe === undefined ? null : `recursive search of ${quoted(unsafe.text)} could read protected files`;
}

function segmentProblem(segment: Segment, cwd: string | null): string | null {
  const program = checkProgram(segment.map((word) => word.text));
  if (!program.ok) return program.reason;
  for (const word of segment) {
    const problem = wordProblem(word, cwd);
    if (problem !== null) return problem;
  }
  return program.recursive ? recursionProblem(segment.slice(1), cwd) : null;
}

function classify(command: string, cwd: string | null): RiskVerdict {
  const lexed = lexCommand(command);
  if (!lexed.ok) return tier1(lexed.reason);
  for (const segment of lexed.segments) {
    const problem = segmentProblem(segment, cwd);
    if (problem !== null) return tier1(problem);
  }
  return { tier: 0, reason: 'read-only command' };
}

/** The read-only classifier. Without a cwd, anything that depends on it is tier 1. */
export function classifyCommand(command: string): { tier: 0 | 1; reason: string } {
  return classify(command, null);
}

/** Like classifyCommand, but resolves relative paths and recursive searches against `cwd`. */
export function classifyExec(command: string, cwd: string): RiskVerdict {
  if (!cwd.startsWith('/')) return tier1('working directory must be an absolute path');
  if (referencesDeniedPath(cwd)) return tier1('working directory is a protected path');
  return classify(command, posix.normalize(cwd));
}
