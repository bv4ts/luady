/**
 * Notes for the people who write docs/ (never a failure): code block lines longer than about 78 characters and inline
 * code longer than about 40 render cramped on a phone. Each one is listed with its file and line in the test output.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LONG_CODE, LONG_LINE } from '../lib/markdown.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

export function crampedLines(markdown) {
  const notes = [];
  let fence = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const marker = /^\s{0,3}(```|~~~)/.exec(line);
    if (marker !== null) {
      if (fence === null) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      return;
    }
    if (fence !== null) {
      if (line.length > LONG_LINE) notes.push({ line: index + 1, what: `code line of ${line.length} characters` });
      return;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      if (match[1].length > LONG_CODE) notes.push({ line: index + 1, what: `inline code of ${match[1].length} characters: ${match[1].slice(0, 50)}` });
    }
  });
  return notes;
}

test('long code in the docs (a note, never a failure)', (t) => {
  const files = readdirSync(DOCS).filter((name) => name.endsWith('.md')).sort();
  let count = 0;
  for (const file of files) {
    for (const note of crampedLines(readFileSync(join(DOCS, file), 'utf8'))) {
      t.diagnostic(`docs/${file}:${note.line}: ${note.what}`);
      count += 1;
    }
  }
  t.diagnostic(`${count} long code lines or chips in docs/ (they scroll or wrap at spaces on the site)`);
});
