import { argon2id, needsRehash } from 'argon2';
import { describe, expect, it } from 'vitest';
import { hashPin, PIN_HASH_OPTIONS, verifyPinHash } from '../../src/security/pin-hash.js';

describe('PIN hashing', { timeout: 30_000 }, () => {
  it('uses argon2id with the documented parameters', async () => {
    expect(PIN_HASH_OPTIONS).toEqual({ type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 2, hashLength: 32 });
    const digest = await hashPin('482915');
    const [, id, version, params, salt, hash] = digest.split('$');
    expect(id).toBe('argon2id');
    expect(version).toBe('v=19');
    expect(Object.fromEntries((params ?? '').split(',').map((pair) => pair.split('=')))).toEqual({ m: '65536', t: '3', p: '2' });
    expect(salt).toHaveLength(22);
    expect(hash).toHaveLength(43);
    expect(needsRehash(digest, { memoryCost: 65_536, timeCost: 3, parallelism: 2 })).toBe(false);
  });

  it('verifies the right PIN and rejects others', async () => {
    const digest = await hashPin('482915');
    await expect(verifyPinHash(digest, '482915')).resolves.toBe(true);
    await expect(verifyPinHash(digest, '482916')).resolves.toBe(false);
  });

  it('salts every hash and never embeds the PIN', async () => {
    const [first, second] = await Promise.all([hashPin('482915'), hashPin('482915')]);
    expect(first).not.toBe(second);
    expect(first).not.toContain('482915');
  });
});
