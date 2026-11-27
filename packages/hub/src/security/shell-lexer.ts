/**
 * Minimal POSIX-shell lexer for the read-only classifier.
 * Splits a command into pipeline segments of words (with quote removal) and rejects every
 * construct that could chain, redirect, substitute or expand commands. When unsure, it rejects.
 */

export interface Word {
  readonly text: string;
  /** True when the word has an unquoted `*`, `?` or `[` (pathname expansion). */
  readonly glob: boolean;
}

export type Segment = readonly Word[];

export type LexResult =
  | { readonly ok: true; readonly segments: readonly Segment[] }
  | { readonly ok: false; readonly reason: string };

class LexRejection extends Error {}

const BLANKS: ReadonlySet<string> = new Set([' ', '\t']);
const GLOB_CHARS: ReadonlySet<string> = new Set(['*', '?', '[']);
/** Inside double quotes a backslash only escapes these characters. */
const DQ_ESCAPABLE: ReadonlySet<string> = new Set(['$', '`', '"', '\\']);
const NEWLINE = 'newline (multiple commands)';

function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code < 0x20 && ch !== '\t') || code === 0x7f;
}

function dollarReason(next: string): string {
  if (next === '(') return 'command substitution "$("';
  if (next === '{') return 'parameter expansion "${"';
  if (next === "'" || next === '"') return 'ANSI-C or locale quoting "$\'"';
  return 'variable expansion "$"';
}

function inputReason(next: string, after: string): string {
  if (next === '<') return after === '<' ? 'here-string "<<<"' : 'here-document "<<"';
  if (next === '(') return 'process substitution "<("';
  return 'input redirection "<"';
}

/** Why an unquoted character leaves the read-only path, or null for an ordinary character. */
function operatorReason(ch: string, next: string, after: string): string | null {
  if (ch === '\n' || ch === '\r') return NEWLINE;
  if (isControl(ch)) return 'control character';
  switch (ch) {
    case ';':
      return 'command separator ";"';
    case '&':
      if (next === '&') return 'command chaining "&&"';
      return next === '>' ? 'redirection "&>"' : 'background operator "&"';
    case '>':
      return next === '>' ? 'append redirection ">>"' : 'output redirection ">"';
    case '<':
      return inputReason(next, after);
    case '`':
      return 'backtick command substitution';
    case '$':
      return dollarReason(next);
    case '(':
    case ')':
      return 'subshell parentheses';
    case '{':
    case '}':
      return 'brace expansion';
    default:
      return null;
  }
}

function doubleQuoteReason(ch: string, next: string): string | null {
  if (ch === '$') return dollarReason(next);
  if (ch === '`') return 'backtick command substitution';
  if (ch === '\n' || ch === '\r') return NEWLINE;
  return isControl(ch) ? 'control character' : null;
}

class Lexer {
  private readonly segments: Segment[] = [];
  private words: Word[] = [];
  private text = '';
  private glob = false;
  private started = false;
  private pos = 0;

  constructor(private readonly src: string) {}

  run(): readonly Segment[] {
    while (this.pos < this.src.length) this.step(this.src.charAt(this.pos));
    this.endWord();
    this.endSegment(true);
    return this.segments;
  }

  private at(offset: number): string {
    return this.src.charAt(this.pos + offset);
  }

  private step(ch: string): void {
    if (BLANKS.has(ch)) {
      this.endWord();
      this.pos += 1;
    } else if (ch === '\\') {
      this.escaped();
    } else if (ch === "'") {
      this.singleQuoted();
    } else if (ch === '"') {
      this.doubleQuoted();
    } else if (ch === '|') {
      this.pipe();
    } else {
      const reason = operatorReason(ch, this.at(1), this.at(2));
      if (reason !== null) throw new LexRejection(reason);
      this.append(ch, GLOB_CHARS.has(ch));
      this.pos += 1;
    }
  }

  private escaped(): void {
    const next = this.at(1);
    if (next === '') throw new LexRejection('trailing backslash');
    if (next === '\n' || next === '\r') throw new LexRejection(NEWLINE);
    if (isControl(next)) throw new LexRejection('control character');
    this.append(next, false);
    this.pos += 2;
  }

  private singleQuoted(): void {
    const close = this.src.indexOf("'", this.pos + 1);
    if (close === -1) throw new LexRejection('unterminated single quote');
    const body = this.src.slice(this.pos + 1, close);
    if ([...body].some((c) => isControl(c))) throw new LexRejection('newline or control character inside quotes');
    this.append(body, false);
    this.pos = close + 1;
  }

  private doubleQuoted(): void {
    let j = this.pos + 1;
    let body = '';
    while (j < this.src.length) {
      const c = this.src.charAt(j);
      const next = this.src.charAt(j + 1);
      if (c === '"') {
        this.append(body, false);
        this.pos = j + 1;
        return;
      }
      if (c === '\\' && DQ_ESCAPABLE.has(next)) {
        body += next;
        j += 2;
        continue;
      }
      const reason = doubleQuoteReason(c, next);
      if (reason !== null) throw new LexRejection(reason);
      body += c;
      j += 1;
    }
    throw new LexRejection('unterminated double quote');
  }

  private pipe(): void {
    const next = this.at(1);
    if (next === '|') throw new LexRejection('command chaining "||"');
    if (next === '&') throw new LexRejection('pipe with stderr "|&"');
    this.endWord();
    this.endSegment(false);
    this.pos += 1;
  }

  private append(chunk: string, glob: boolean): void {
    this.text += chunk;
    this.glob = this.glob || glob;
    this.started = true;
  }

  private endWord(): void {
    if (!this.started) return;
    this.words = [...this.words, { text: this.text, glob: this.glob }];
    this.text = '';
    this.glob = false;
    this.started = false;
  }

  private endSegment(final: boolean): void {
    if (this.words.length === 0) {
      throw new LexRejection(final && this.segments.length === 0 ? 'empty command' : 'empty pipeline segment');
    }
    this.segments.push(this.words);
    this.words = [];
  }
}

export function lexCommand(command: string): LexResult {
  try {
    return { ok: true, segments: new Lexer(command).run() };
  } catch (err) {
    if (err instanceof LexRejection) return { ok: false, reason: err.message };
    throw err;
  }
}
