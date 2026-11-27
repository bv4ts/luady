/** How long the client waits before it reconnects: 1 s, doubling, never more than 30 s. */
export const BACKOFF = { initialMs: 1000, maxMs: 30_000 } as const;

/** Exponential back-off: initialMs · 2^attempt, capped at maxMs (attempt 0 → initialMs). */
export function backoffDelay(attempt: number, initialMs: number = BACKOFF.initialMs, maxMs: number = BACKOFF.maxMs): number {
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, initialMs * 2 ** exponent);
}
