import { PAGE_KEY_STORAGE } from '@luady/shared';

/**
 * The page key: returned by a passkey sign-in or registration, a login link or a claim, and kept in
 * this origin's localStorage (scoped by port, unlike the cookie). Every /api call sends it, and the live socket sends
 * it first. Storage can be unavailable (a private window, blocked site data): then there is no key.
 */
export function readPageKey(): string | null {
  try {
    return globalThis.localStorage?.getItem(PAGE_KEY_STORAGE) ?? null;
  } catch {
    return null;
  }
}

export function storePageKey(key: string): void {
  try {
    globalThis.localStorage?.setItem(PAGE_KEY_STORAGE, key);
  } catch {
    // Nothing to keep it in: the next sign-in returns a new one.
  }
}

export function clearPageKey(): void {
  try {
    globalThis.localStorage?.removeItem(PAGE_KEY_STORAGE);
  } catch {
    // Nothing stored.
  }
}

/** Keeps the key a sign-in answer carries; an older hub sends none. */
export function keepPageKey(answer: { pageKey?: string | undefined }): void {
  if (answer.pageKey !== undefined) storePageKey(answer.pageKey);
}
