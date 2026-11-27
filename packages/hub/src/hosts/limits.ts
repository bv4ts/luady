import type { Clock } from '../core/contracts.js';
import { HostRateError } from './errors.js';

/**
 * The hosts buckets: 20 changes a minute per client, and 6 scans or checks a minute per host, so
 * SSRF-like probing stays slow even with the PIN. Counted in memory with a sliding minute; kept small by pruning.
 */
export const HOSTS_BUCKET = { limit: 20, windowMs: 60_000 } as const;
export const PROBE_BUCKET = { limit: 6, windowMs: 60_000 } as const;
const KEYS_MAX = 10_000;

export interface RateLimiter {
  /** Counts one request under `key`; throws HostRateError when the bucket is full. */
  take(key: string, bucket: { readonly limit: number; readonly windowMs: number }): void;
}

export function createRateLimiter(clock: Clock): RateLimiter {
  let hits: ReadonlyMap<string, readonly number[]> = new Map();
  return {
    take(key, bucket) {
      const at = clock.now().getTime();
      const recent = (hits.get(key) ?? []).filter((time) => time > at - bucket.windowMs);
      if (recent.length >= bucket.limit) {
        const oldest = recent[0] ?? at;
        throw new HostRateError(Math.max(1, Math.ceil((oldest + bucket.windowMs - at) / 1000)));
      }
      const next = new Map(hits);
      next.set(key, [...recent, at]);
      if (next.size > KEYS_MAX) next.delete(next.keys().next().value as string);
      hits = next;
    },
  };
}
