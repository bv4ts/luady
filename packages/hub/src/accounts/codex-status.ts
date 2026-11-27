import type { Clock, Logger } from '../core/contracts.js';
import type { CodexLogin } from '../media/codex-login.js';

/** A Codex sign-in status is kept this long; an older one is answered while a fresh check runs. */
export const CODEX_STATUS_TTL_MS = 60_000;
/** The accounts answer never waits longer than this for a check: it says the last known state or "unknown". */
export const CODEX_STATUS_WAIT_MS = 1_000;

type CodexState = Awaited<ReturnType<CodexLogin['status']>>;
interface Known { readonly state: CodexState; readonly atMs: number }

/** Resolves with the promise, or with `fallback()` after `ms`, whichever comes first. */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * The same Codex login, with `codex login status` run at most once a minute instead of on every `GET /api/accounts`.
 * A sign-in that finishes and a sign-out drop the kept status at once; a check that started before that is not kept.
 */
export function withCachedStatus(inner: CodexLogin, deps: { clock: Clock; log: Logger }): CodexLogin {
  let known: Known | null = null;
  let running: Promise<CodexState | null> | null = null;
  /** Bumped by every sign-in and sign-out: a check from an older generation is thrown away. */
  let generation = 0;
  const nowMs = (): number => deps.clock.now().getTime();

  function forget(): void {
    generation += 1;
    known = null;
    running = null;
  }

  /** One check at a time; null when it failed (the last known state then stands). */
  function check(): Promise<CodexState | null> {
    if (running !== null) return running;
    const started = generation;
    const current = inner.status().then(
      (state) => {
        if (started === generation) known = { state, atMs: nowMs() };
        return state;
      },
      (err: unknown) => {
        deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'accounts: codex status check failed');
        return null;
      },
    ).finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  }

  inner.onResult(() => forget());

  return {
    begin: () => inner.begin(),
    beginData: () => inner.beginData(),
    onResult: (listener) => inner.onResult(listener),
    async logout() {
      const ok = await inner.logout();
      forget();
      return ok;
    },
    async status() {
      const last = known;
      if (last !== null && nowMs() - last.atMs < CODEX_STATUS_TTL_MS) return last.state;
      const fresh = check();
      if (last !== null) return last.state;
      const state = await withDeadline(fresh, CODEX_STATUS_WAIT_MS, () => null);
      return state ?? known?.state ?? 'unknown';
    },
  };
}
