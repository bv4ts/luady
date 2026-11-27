import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import type { AccessVerifier } from '../../src/core/contracts.js';
import { createAccessVerifier } from '../../src/web/auth/access.js';

export const TEST_TEAM = 'luady-test.cloudflareaccess.com';
export const TEST_ISSUER = `https://${TEST_TEAM}`;
export const TEST_AUD = 'aud-0123456789abcdef';
export const TEST_KID = 'test-kid';
export const OWNER_EMAIL = 'owner@example.com';
export const PUBLIC_ORIGIN = 'https://luady.test.example';
export const RP_ID = 'luady.test.example';
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef-0123456789abcdef';

export interface TestKeys {
  privateKey: CryptoKey;
  getKey: JWTVerifyGetKey;
}

export interface TokenOptions {
  /** null omits the email claim. */
  email?: string | null;
  aud?: string;
  iss?: string;
  expiresInSec?: number;
  key?: CryptoKey;
}

let cached: Promise<TestKeys> | undefined;

export async function createTestKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  return { privateKey, getKey: createLocalJWKSet({ keys: [{ ...jwk, kid: TEST_KID, alg: 'RS256', use: 'sig' }] }) };
}

/** One RSA key per test worker; generating keys per test is slow. */
export function testKeys(): Promise<TestKeys> {
  cached ??= createTestKeys();
  return cached;
}

export async function signAccessToken(opts: TokenOptions = {}): Promise<string> {
  const keys = await testKeys();
  const now = Math.floor(Date.now() / 1000);
  const claims = opts.email === null ? {} : { email: opts.email ?? OWNER_EMAIL };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
    .setIssuer(opts.iss ?? TEST_ISSUER)
    .setAudience(opts.aud ?? TEST_AUD)
    .setIssuedAt(now - 5)
    .setExpirationTime(now + (opts.expiresInSec ?? 300))
    .sign(opts.key ?? keys.privateKey);
}

export async function testAccessVerifier(ownerEmail: string = OWNER_EMAIL): Promise<AccessVerifier> {
  const keys = await testKeys();
  return createAccessVerifier({ teamDomain: TEST_TEAM, aud: TEST_AUD, ownerEmail, getKey: keys.getKey });
}
