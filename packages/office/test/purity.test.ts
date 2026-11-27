import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const FORBIDDEN = /\b(document|window|HTMLCanvasElement|require\(|from 'node:|from "node:|Buffer\b)/;

const sourceFiles = (): readonly string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SRC, name));

const importSpecifiers = (text: string): readonly string[] =>
  Array.from(text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), (m) => m[1] ?? '');

describe('src purity', () => {
  it('finds the source files', () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it.each(sourceFiles())('%s uses no browser or Node API', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(FORBIDDEN);
  });

  it.each(sourceFiles())('%s imports only local modules, @luady/shared or @luady/shared/pure', (file) => {
    const bad = importSpecifiers(readFileSync(file, 'utf8'))
      .filter((s) => !s.startsWith('./') && !s.startsWith('../') && s !== '@luady/shared' && s !== '@luady/shared/pure');
    expect(bad).toEqual([]);
  });

  // Runtime imports may come from @luady/shared/pure only: it has no runtime imports outside itself.
  it.each(sourceFiles())('%s takes only types from @luady/shared', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => /from\s+['"]@luady\/shared['"]/.test(line));
    expect(lines.filter((line) => !/^(import|export) type\b/.test(line.trim()))).toEqual([]);
  });
});
