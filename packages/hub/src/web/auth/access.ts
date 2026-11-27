import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AccessIdentity, AccessVerifier } from '../../core/contracts.js';
import { AuthError } from '../../core/errors.js';

export interface AccessVerifierOptions {
  teamDomain: string;
  aud: string;
  ownerEmail: string;
  getKey?: JWTVerifyGetKey;
}

export function accessIssuer(teamDomain: string): string {
  return `https://${teamDomain}`;
}

export function accessCertsUrl(teamDomain: string): URL {
  return new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function verifiedEmail(token: string, getKey: JWTVerifyGetKey, issuer: string, audience: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'email'],
    });
    return typeof payload.email === 'string' ? normalizeEmail(payload.email) : '';
  } catch {
    throw new AuthError('Cloudflare Access token is invalid');
  }
}

/**
 * `local` mode: no Access gate in front. Every request carries the owner's label as its identity; the
 * session, its page key, the Origin check and CSRF (web/auth/chain.ts) are what protect the hub.
 */
export function createLocalIdentity(ownerLabel: string): AccessVerifier {
  if (ownerLabel.trim() === '') throw new Error('createLocalIdentity needs the owner label');
  const identity: AccessIdentity = Object.freeze({ email: ownerLabel });
  return { verify: async () => identity };
}

/**
 * Verifies Cf-Access-Jwt-Assertion tokens. RS256 keys come from the team JWKS: jose caches it and
 * refetches when it sees an unknown kid. Only the owner email passes.
 */
export function createAccessVerifier(opts: AccessVerifierOptions): AccessVerifier {
  if (opts.teamDomain === '' || opts.aud === '' || opts.ownerEmail === '') {
    throw new Error('createAccessVerifier needs teamDomain, aud and ownerEmail');
  }
  const issuer = accessIssuer(opts.teamDomain);
  const getKey: JWTVerifyGetKey = opts.getKey ?? createRemoteJWKSet(accessCertsUrl(opts.teamDomain));
  const owner = normalizeEmail(opts.ownerEmail);
  return {
    async verify(token: string | undefined): Promise<AccessIdentity> {
      if (token === undefined || token === '') throw new AuthError('Cloudflare Access token is missing');
      const email = await verifiedEmail(token, getKey, issuer, opts.aud);
      if (email !== owner) throw new AuthError('Cloudflare Access identity is not the owner');
      return { email };
    },
  };
}
