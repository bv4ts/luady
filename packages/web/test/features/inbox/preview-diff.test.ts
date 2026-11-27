import { describe, expect, it } from 'vitest';
import { diffLines } from '../../../src/features/inbox/preview-diff.js';
import { buildPermissionAnswer } from '../../../src/features/inbox/answer-mapping.js';

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const kinds = (text: ReturnType<typeof diffLines>) => text.map((line) => line.kind);

describe('diffLines', () => {
  it('marks the changed middle and keeps the shared lines around it', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'x' }, { kind: 'same', text: 'c' },
    ]);
  });

  it('replaces a long shared run by one gap, keeping two lines of context', () => {
    const before = [...lines(10), 'old'].join('\n');
    const after = [...lines(10), 'new'].join('\n');
    const diff = diffLines(before, after);
    expect(kinds(diff)).toEqual(['gap', 'same', 'same', 'removed', 'added']);
    expect(diff[0]?.text).toContain('8');
    expect(diff[1]?.text).toBe('line 9');
  });

  it('a long shared tail is cut the same way', () => {
    const diff = diffLines(['x', ...lines(6)].join('\n'), ['y', ...lines(6)].join('\n'));
    expect(kinds(diff)).toEqual(['removed', 'added', 'same', 'same', 'gap']);
  });

  it('identical texts give only same and gap lines', () => {
    const text = lines(9).join('\n');
    expect(new Set(kinds(diffLines(text, text)))).toEqual(new Set(['same', 'gap']));
    expect(kinds(diffLines('a', 'a'))).toEqual(['same']);
  });

  it('a whole new file is all added', () => {
    expect(diffLines('', 'one\ntwo')).toEqual([{ kind: 'added', text: 'one' }, { kind: 'added', text: 'two' }]);
  });

  it('an inserted line is only added: the lines after it are not removed and added again', () => {
    expect(diffLines('a\nb\nc', 'a\nnew\nb\nc')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'added', text: 'new' }, { kind: 'same', text: 'b' }, { kind: 'same', text: 'c' },
    ]);
    expect(kinds(diffLines('a\nb\nc', 'a\nc'))).toEqual(['same', 'removed', 'same']);
  });

  it('a line both texts keep between two changes stays unchanged', () => {
    const before = 'export function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}';
    const after = 'export function total(items: Item[]): number {\n  let sum = 0;\n  for (const item of items) sum += item.price * item.quantity;\n'
      + '  return Math.round(sum * 100) / 100;\n}';
    expect(kinds(diffLines(before, after))).toEqual(['removed', 'added', 'same', 'removed', 'removed', 'added', 'added', 'same']);
    expect(diffLines(before, after)[2]).toEqual({ kind: 'same', text: '  let sum = 0;' });
  });

  it('a long unchanged run between two changes becomes one gap with context on both sides', () => {
    const diff = diffLines(['x', ...lines(10), 'y'].join('\n'), ['X', ...lines(10), 'Y'].join('\n'));
    expect(kinds(diff)).toEqual(['removed', 'added', 'same', 'same', 'gap', 'same', 'same', 'removed', 'added']);
    expect(diff[4]?.text).toBe('6 unchanged lines');
    expect(diff[5]?.text).toBe('line 9');
  });

  it('a very large change falls back to all removed then all added, quickly', () => {
    const before = lines(2_000, 'a').join('\n');
    const after = lines(2_000, 'b').join('\n');
    const started = Date.now();
    const diff = diffLines(before, after);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(diff.filter((line) => line.kind === 'removed')).toHaveLength(2_000);
    expect(diff.at(-1)).toEqual({ kind: 'added', text: 'b 2000' });
  });

  it('takes the context size it is given', () => {
    const diff = diffLines([...lines(4), 'old'].join('\n'), [...lines(4), 'new'].join('\n'), 0);
    expect(kinds(diff)).toEqual(['gap', 'removed', 'added']);
  });
});

describe('buildPermissionAnswer', () => {
  it('allows always only together with allow', () => {
    expect(buildPermissionAnswer('allow', '', true)).toEqual({ ok: true, value: { behavior: 'allow', always: true } });
    expect(buildPermissionAnswer('allow', ' go ')).toEqual({ ok: true, value: { behavior: 'allow', message: 'go' } });
    expect(buildPermissionAnswer('deny', 'no', true).ok).toBe(false);
    expect(buildPermissionAnswer('deny', 'no')).toEqual({ ok: true, value: { behavior: 'deny', message: 'no' } });
  });
});
