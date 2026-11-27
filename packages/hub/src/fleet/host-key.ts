import { createHash } from 'node:crypto';
import { HOST_KEY_FP_RE } from '../config/schema.js';
import { ValidationError } from '../core/errors.js';

/** OpenSSH fingerprint of a raw SSH public-key blob: `SHA256:` + unpadded base64 of its sha256. */
export function fingerprintSha256(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** The key type a raw SSH public-key blob names (its first string), or `unknown` when the blob is malformed. */
export function keyTypeOf(keyBlob: Buffer): string {
  if (keyBlob.length < 4) return 'unknown';
  const length = keyBlob.readUInt32BE(0);
  if (length < 1 || length > 64 || keyBlob.length < 4 + length) return 'unknown';
  const type = keyBlob.subarray(4, 4 + length).toString('latin1');
  return /^[a-z0-9@.-]{1,64}$/.test(type) ? type : 'unknown';
}

/** ssh2 `hostVerifier` (sync form: receives the raw K_S blob) that accepts only the pinned fingerprint. */
export function createHostVerifier(expectedFp: string, onMismatch: (actualFp: string) => void): (keyBlob: Buffer) => boolean {
  if (!HOST_KEY_FP_RE.test(expectedFp)) {
    throw new ValidationError(`invalid pinned host key fingerprint: ${expectedFp}`);
  }
  return (keyBlob) => {
    const actual = fingerprintSha256(keyBlob);
    if (actual === expectedFp) return true;
    onMismatch(actual);
    return false;
  };
}
