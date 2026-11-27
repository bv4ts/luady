/**
 * Per-host loops for any number of hosts: at most a few hosts at once, and a time limit per host, so one
 * slow or silent host never holds up the others.
 */

/** How many hosts a per-host loop works on at once. */
export const PER_HOST_CONCURRENCY = 4;

/**
 * Runs `work` for every item, at most `limit` at a time, in order of start. Resolves once all have settled; a rejected
 * item is reported to `onError` (default: ignored) and never stops the rest.
 */
export async function forEachLimit<T>(
  items: readonly T[], limit: number, work: (item: T) => Promise<unknown>, onError?: (item: T, err: unknown) => void,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await work(item);
      } catch (err) {
        onError?.(item, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

/** Rejects with `what timed out` when `promise` takes longer than `ms`; the timer never keeps the process alive. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
