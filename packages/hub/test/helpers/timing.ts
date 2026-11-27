/** How long a synchronous call takes, in milliseconds. */
export function elapsedMs(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** A hostile input must be handled well under a second; a quadratic pattern takes minutes on these sizes. */
export const HOSTILE_INPUT_BUDGET_MS = 500;
