import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';

/**
 * argon2id parameters for the owner PIN.
 * - RFC 9106 §4 second recommended option (t = 3, m = 64 MiB), with p = 2 to match
 *   luady-hub.service's CPUQuota=200% (two CPUs).
 * - 64 MiB per hash is small next to MemoryMax=2G; PIN checks are serialized (mutex.ts),
 *   so only one hash runs at a time. About 0.1–0.3 s per check.
 * - Above the OWASP minimum (m = 19 MiB, t = 2, p = 1).
 */
export const PIN_HASH_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 2,
  hashLength: 32,
} as const;

/**
 * Returns the PHC string ($argon2id$v=19$m=…,p=…,t=…$salt$hash, the parameter order argon2 0.45.1 emits;
 * read the parameters by key, never by position). The plain PIN is never stored.
 */
export function hashPin(pin: string): Promise<string> {
  return argon2Hash(pin, PIN_HASH_OPTIONS);
}

export function verifyPinHash(digest: string, pin: string): Promise<boolean> {
  return argon2Verify(digest, pin);
}
