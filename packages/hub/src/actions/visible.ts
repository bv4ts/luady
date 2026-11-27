import { createHash } from 'node:crypto';
import { clipText } from './text.js';

/**
 * Characters that can hide text or change the order it reads in: the C0 and C1 controls and DEL, the soft hyphen, the
 * Arabic letter mark, the Mongolian vowel separator, the zero-width spaces and joiners, the bidirectional marks,
 * embeddings, overrides and isolates, the line and paragraph separators, the invisible operators, the byte order mark
 * and the invisible tag characters.
 */
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const NEWLINE_RE = /\r\n|\r|\n/g;

const PREVIEW_LINES = 5;
const PREVIEW_LINE_MAX = 120;
const SHA_SHOWN = 12;

function escapeOf(char: string): string {
  return `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Every hidden character becomes a visible `<U+XXXX>` mark, so an approval shows exactly what it holds. */
export function visibleText(text: string): string {
  return text.replace(HIDDEN_RE, escapeOf);
}

/** Keeps every character of the command; newlines become a visible ⏎, any other hidden character a `<U+XXXX>` mark. */
export function visibleCommand(command: string): string {
  return visibleText(command.replace(NEWLINE_RE, ' ⏎ '));
}

function contentLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function countText(lines: number): string {
  if (lines === 0) return 'empty';
  return lines === 1 ? '1 line' : `${lines} lines`;
}

/**
 * A file write as the owner approves it: the path (hidden characters marked), the size, the line count, a short SHA-256
 * of the whole content, then its first lines, each cut and marked, one per line after `| `.
 */
export function fileWriteSummary(server: string, path: string, content: string): string {
  const lines = contentLines(content);
  const head = `write ${visibleText(path)} on ${server} (${Buffer.byteLength(content, 'utf8')} bytes, ${countText(lines.length)}, sha256 ${shortSha(content)})`;
  return [head, ...previewLines(lines)].join('\n');
}

/** The first 12 hex digits of the SHA-256 of `text`: the website's full view of the same text shows the same mark. */
export function shortSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, SHA_SHOWN);
}

/** The first lines, each cut and marked, one per line after `| `, then how many more there are. */
function previewLines(lines: readonly string[]): string[] {
  const shown = lines.slice(0, PREVIEW_LINES).map((line) => `| ${visibleText(clipText(line, PREVIEW_LINE_MAX))}`);
  const rest = lines.length - PREVIEW_LINES;
  return rest > 0 ? [...shown, `| … ${rest} more line${rest === 1 ? '' : 's'}`] : shown;
}

/**
 * Text the manager wants typed into a session, as the owner approves it: `head`, then the size in characters, the line
 * count and a short SHA-256 of the whole text, then its first lines the way a file write shows them.
 */
export function typedTextSummary(head: string, text: string): string {
  const lines = contentLines(text);
  const size = Array.from(text).length;
  const facts = `${size} character${size === 1 ? '' : 's'}, ${countText(lines.length)}, sha256 ${shortSha(text)}`;
  return [`${head} (${facts})`, ...previewLines(lines)].join('\n');
}

/** The whole text for the website's full view: line breaks kept, every other hidden character marked. */
export function visibleLines(text: string): string {
  return text.split(NEWLINE_RE).map(visibleText).join('\n');
}
