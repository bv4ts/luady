import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../src/core/errors.js';
import { accessCertsUrl, accessIssuer, createAccessVerifier, normalizeEmail } from '../../src/web/auth/access.js';
import {
  createTestKeys,
  OWNER_EMAIL,
  signAccessToken,
  TEST_AUD,
  TEST_ISSUER,
  TEST_KID,
  TEST_TEAM,
  testAccessVerifier,
} from './fixtures.js';

describe('createAccessVerifier', () => {
  it('accepts a valid owner token and returns the normalized email', async () => {
    const verifier = await testAccessVerifier();
    await expect(verifier.verify(await signAccessToken())).resolves.toEqual({ email: OWNER_EMAIL });
  });

  it('compares the owner email case-insensitively', async () => {
    const verifier = await testAccessVerifier('Owner@Example.COM');
    const token = await signAccessToken({ email: ' OWNER@example.com ' });
    await expect(verifier.verify(token)).resolves.toEqual({ email: 'owner@example.com' });
  });

  it('rejects another email', async () => {
    const verifier = await testAccessVerifier();
    await expect(verifier.verify(await signAccessToken({ email: 'intruder@gmail.com' }))).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token without an email claim', async () => {
    const verifier = await testAccessVerifier();
    await expect(verifier.verify(await signAccessToken({ email: null }))).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a wrong audience', async () => {
    const verifier = await testAccessVerifier();
    await expect(verifier.verify(await signAccessToken({ aud: 'some-other-app' }))).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a wrong issuer', async () => {
    const verifier = await testAccessVerifier();
    const token = await signAccessToken({ iss: 'https://evil.cloudflareaccess.com' });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an expired token', async () => {
    const verifier = await testAccessVerifier();
    await expect(verifier.verify(await signAccessToken({ expiresInSec: -60 }))).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token signed by another key (forged)', async () => {
    const verifier = await testAccessVerifier();
    const forger = await createTestKeys();
    await expect(verifier.verify(await signAccessToken({ key: forger.privateKey }))).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an HS256 token (algorithm confusion)', async () => {
    const verifier = await testAccessVerifier();
    const token = await new SignJWT({ email: OWNER_EMAIL })
      .setProtectedHeader({ alg: 'HS256', kid: TEST_KID })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUD)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects missing, empty and malformed tokens', async () => {
    const verifier = await testAccessVerifier();
    for (const token of [undefined, '', 'not-a-jwt', 'a.b.c']) {
      await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthError);
    }
  });

  it('derives the issuer and the JWKS URL from the team domain', () => {
    expect(accessIssuer(TEST_TEAM)).toBe('https://luady-test.cloudflareaccess.com');
    expect(accessCertsUrl(TEST_TEAM).href).toBe('https://luady-test.cloudflareaccess.com/cdn-cgi/access/certs');
    expect(normalizeEmail('  Owner@EXAMPLE.com ')).toBe('owner@example.com');
  });

  it('builds a remote-JWKS verifier without fetching when no getKey is injected', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(() => createAccessVerifier({ teamDomain: TEST_TEAM, aud: TEST_AUD, ownerEmail: OWNER_EMAIL })).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses to build without team domain, audience or owner email', () => {
    expect(() => createAccessVerifier({ teamDomain: '', aud: TEST_AUD, ownerEmail: OWNER_EMAIL })).toThrow(/teamDomain/);
    expect(() => createAccessVerifier({ teamDomain: TEST_TEAM, aud: '', ownerEmail: OWNER_EMAIL })).toThrow(/aud/);
    expect(() => createAccessVerifier({ teamDomain: TEST_TEAM, aud: TEST_AUD, ownerEmail: '' })).toThrow(/ownerEmail/);
  });
});
