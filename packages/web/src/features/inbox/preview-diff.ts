export type DiffLine = { readonly kind: 'same' | 'removed' | 'added' | 'gap'; readonly text: string };
type Change = { readonly kind: 'same' | 'removed' | 'added'; readonly text: string };

/** Above this many cells (old lines × new lines) the table is not built: every old line is removed, every new one added. */
const MAX_CELLS = 250_000;

const toLines = (text: string): readonly string[] => (text === '' ? [] : text.split('\n'));

const gap = (count: number): DiffLine => ({ kind: 'gap', text: count === 1 ? '1 unchanged line' : `${count} unchanged lines` });
const same = (lines: readonly string[]): readonly DiffLine[] => lines.map((text) => ({ kind: 'same', text }));
const removed = (text: string): Change => ({ kind: 'removed', text });
const added = (text: string): Change => ({ kind: 'added', text });

/** lcs[i * width + j] = length of the longest common run of lines of a[i..] and b[j..]. */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  return table;
}

/**
 * A line diff on the longest common subsequence: kept lines are `same`, and between two kept lines every removed
 * line comes before the added ones. Small and dependency-free; a preview is at most a few hundred lines.
 */
function changes(a: readonly string[], b: readonly string[]): readonly Change[] {
  if (a.length * b.length > MAX_CELLS) return [...a.map(removed), ...b.map(added)];
  const table = lcsTable(a, b);
  const width = b.length + 1;
  const out: Change[] = [];
  let pending: { gone: string[]; fresh: string[] } = { gone: [], fresh: [] };
  const flush = (): void => {
    out.push(...pending.gone.map(removed), ...pending.fresh.map(added));
    pending = { gone: [], fresh: [] };
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      out.push({ kind: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))) {
      pending.gone.push(a[i] ?? '');
      i += 1;
    } else {
      pending.fresh.push(b[j] ?? '');
      j += 1;
    }
  }
  flush();
  return out;
}

/** One run of kept lines, cut to `context` lines next to each change; the rest becomes one gap line. */
function keptRun(lines: readonly string[], context: number, changeBefore: boolean, changeAfter: boolean): readonly DiffLine[] {
  const head = changeBefore ? context : 0;
  const tail = changeAfter ? context : 0;
  if (!changeBefore && !changeAfter) return keptRun(lines, context, false, true);
  if (lines.length <= head + tail + 1) return same(lines);
  return [...same(lines.slice(0, head)), gap(lines.length - head - tail), ...same(lines.slice(lines.length - tail))];
}

/**
 * The changed lines of one edit, the way the approval card shows them: a real line diff, where each run of lines
 * both texts keep is cut to `context` lines next to a change (a longer run becomes one gap line). A whole new file
 * (empty old text) is all added.
 */
export function diffLines(oldText: string, newText: string, context = 2): readonly DiffLine[] {
  const all = changes(toLines(oldText), toLines(newText));
  const out: DiffLine[] = [];
  let at = 0;
  while (at < all.length) {
    const change = all[at];
    if (change !== undefined && change.kind !== 'same') {
      out.push(change);
      at += 1;
      continue;
    }
    let end = at;
    while (all[end]?.kind === 'same') end += 1;
    const run = all.slice(at, end).map((line) => line.text);
    out.push(...keptRun(run, context, at > 0, end < all.length));
    at = end;
  }
  return out;
}
