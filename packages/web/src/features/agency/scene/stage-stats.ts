import type { StageStats } from '../stage-types.js';

/**
 * The stats hook (`window.__luadyStageStats()`): on in dev builds (`import.meta.env.DEV`, tests
 * included) and wherever a page sets the demo flag `globalThis.__LUADY_DEMO__ = true` before the stage starts (the
 * demo, a measuring script); never in a plain production page.
 */
export function statsEnabled(): boolean {
  return import.meta.env.DEV || (globalThis as { __LUADY_DEMO__?: unknown }).__LUADY_DEMO__ === true;
}

/** Display objects under a node, the node itself not counted: what the renderer walks. */
export function countNodes(root: { readonly children: readonly unknown[] }): number {
  let n = 0;
  const stack: { readonly children: readonly unknown[] }[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    node?.children.forEach((child) => {
      n += 1;
      stack.push(child as { readonly children: readonly unknown[] });
    });
  }
  return n;
}

/** Installs `window.__luadyStageStats` (when enabled); the returned function removes it if it is still this one. */
export function installStats(read: () => StageStats): () => void {
  if (!statsEnabled() || typeof window === 'undefined') return () => undefined;
  window.__luadyStageStats = read;
  return () => {
    if (window.__luadyStageStats === read) delete window.__luadyStageStats;
  };
}
