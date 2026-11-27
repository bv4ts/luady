import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The preview's sign-in: there is no open login route. Each run makes a random token that signs
 * a browser in once (`/__preview/login?t=…`); using it makes the next one, which the preview prints in its terminal.
 */
export interface LoginTokens {
  /** The token the next sign-in must carry. */
  current(): string;
  /** True, once, for the current token; it is then replaced. False for anything else. */
  take(candidate: string | undefined): boolean;
}

export const LOGIN_PATH = '/__preview/login';
const TOKEN_BYTES = 32;

const newToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

function sameToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `onNext` hears each replacement token (never the one in use). */
export function createLoginTokens(onNext?: (token: string) => void): LoginTokens {
  let token = newToken();
  return {
    current: () => token,
    take(candidate) {
      if (candidate === undefined || candidate === '' || !sameToken(token, candidate)) return false;
      token = newToken();
      onNext?.(token);
      return true;
    },
  };
}

/** The sign-in link for a token on the preview at `url`. */
export function loginLink(url: string, token: string): string {
  return `${url}${LOGIN_PATH}?t=${encodeURIComponent(token)}`;
}
