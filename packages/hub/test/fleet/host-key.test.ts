import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { createHostVerifier, fingerprintSha256 } from '../../src/fleet/host-key.js';

// GitHub publishes this ed25519 host key and its fingerprint: a real-world vector for the OpenSSH format.
const GITHUB_ED25519 = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl', 'base64');
const GITHUB_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

describe('host key pinning', () => {
  it('computes OpenSSH SHA256 fingerprints', () => {
    expect(fingerprintSha256(GITHUB_ED25519)).toBe(GITHUB_FP);
  });

  it('accepts only the pinned key and reports the key it saw', () => {
    const seen: string[] = [];
    const verify = createHostVerifier(GITHUB_FP, (actual) => {
      seen.push(actual);
    });
    expect(verify(GITHUB_ED25519)).toBe(true);
    const other = Buffer.from('not the pinned key');
    expect(verify(other)).toBe(false);
    expect(seen).toEqual([fingerprintSha256(other)]);
  });

  it('rejects malformed pins', () => {
    expect(() => createHostVerifier('MD5:aa:bb', () => undefined)).toThrow(ValidationError);
  });
});
