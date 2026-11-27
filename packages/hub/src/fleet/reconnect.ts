import type { LinkStatus } from './executor.js';

export interface ReconnectPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  /** Consecutive failed attempts after which the link is reported `offline`. */
  readonly offlineAfter: number;
  /**
   * Spread of every back-off delay, as a fraction (0.2 = ±20 %): a hundred links that dropped together do not retry
   * together. 0 or absent: the exact delay.
   */
  readonly jitter?: number;
  /** A number in [0, 1); Math.random when absent (tests pass their own). */
  readonly random?: () => number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { initialMs: 1_000, maxMs: 60_000, offlineAfter: 3 };
/** The fleet's SSH links (fleet/fleet.ts): the default with ±20 % jitter on every back-off. */
export const FLEET_RECONNECT_POLICY: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, jitter: 0.2 };

/** Delay before the next attempt after `failures` consecutive failures: 1 s, 2 s, 4 s … capped at 60 s. */
export function backoffDelay(failures: number, policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(policy.maxMs, policy.initialMs * 2 ** exponent);
}

/** A back-off delay spread by ±jitter: `delay × (1 − jitter + 2 × jitter × random)`. */
export function jitteredDelay(delayMs: number, jitter: number, random: () => number = Math.random): number {
  if (jitter <= 0) return delayMs;
  const spread = Math.min(Math.max(random(), 0), 1);
  return Math.round(delayMs * (1 - jitter + 2 * jitter * spread));
}

export interface ReconnectorOptions {
  connect: () => Promise<void>;
  policy?: ReconnectPolicy;
  onFailure?: (err: unknown, failures: number) => void;
}

export interface Reconnector {
  start(): void;
  stop(): void;
  status(): LinkStatus;
  /** Report that an established connection dropped; a reconnect is scheduled. */
  connectionLost(): void;
  onStatus(listener: (status: LinkStatus) => void): () => void;
}

export function createReconnector(opts: ReconnectorOptions): Reconnector {
  const policy = opts.policy ?? DEFAULT_RECONNECT_POLICY;
  const listeners = new Set<(status: LinkStatus) => void>();
  let current: LinkStatus = 'connecting';
  let failures = 0;
  let running = false;
  let attempting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(next: LinkStatus): void {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener(next);
  }

  function schedule(delayMs: number): void {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, delayMs);
  }

  async function attempt(): Promise<void> {
    if (!running || attempting) return;
    attempting = true;
    try {
      await opts.connect();
      failures = 0;
      if (running) setStatus('online');
    } catch (err) {
      failures += 1;
      opts.onFailure?.(err, failures);
      if (failures >= policy.offlineAfter) setStatus('offline');
      schedule(jitteredDelay(backoffDelay(failures, policy), policy.jitter ?? 0, policy.random));
    } finally {
      attempting = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void attempt();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    status: () => current,
    connectionLost() {
      if (!running) return;
      failures = 0;
      setStatus('connecting');
      schedule(jitteredDelay(policy.initialMs, policy.jitter ?? 0, policy.random));
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
