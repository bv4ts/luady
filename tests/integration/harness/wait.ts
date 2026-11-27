export interface WaitOptions { timeoutMs?: number; intervalMs?: number; what?: string }

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns something other than null/undefined/false; reports the last probe error on timeout. */
export async function waitFor<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError ? `; last error: ${String(lastError)}` : '';
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${opts.what ?? 'a condition'}${reason}`);
    }
    await sleep(opts.intervalMs ?? 250);
  }
}
