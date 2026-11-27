import { LOGIN_LINK_PATH } from '../features/setup/steps.js';

/**
 * The login link's token: it arrives in the fragment of `/setup/login#<token>`, which the browser never
 * sends to a server. It is taken out of the address bar the first time the page looks (before anything is drawn), and
 * kept in memory only, never in Web Storage, until it is used or found dead.
 */
let held: string | null = null;

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Takes the token from the address bar once (and clears the fragment there); later calls return what was taken. */
export function takeLinkToken(win: Pick<Window, 'location' | 'history'> = window): string | null {
  const { pathname, search, hash } = win.location;
  if (pathname === LOGIN_LINK_PATH && hash.length > 1) {
    const raw = hash.slice(1);
    // The fragment goes away whatever it held; only a well-formed token is kept.
    win.history.replaceState(win.history.state, '', `${pathname}${search}`);
    held = TOKEN_RE.test(raw) ? raw : held;
  }
  return held;
}

/** A token from the router's own location (the same address under a browser router; a test's memory router otherwise). */
export function tokenOfHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return TOKEN_RE.test(raw) ? raw : null;
}

/** The token was used, or the hub said it is dead: forget it. */
export function dropLinkToken(): void {
  held = null;
}
