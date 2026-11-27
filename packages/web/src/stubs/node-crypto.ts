/**
 * Browser stand-in for `node:crypto` (aliased in vite.config.ts).
 * @luady/shared re-exports promptHash for the hub; the SPA never calls it, so reaching this is a bug.
 */
export function createHash(_algorithm: string): never {
  throw new Error('node:crypto is not available in the browser');
}
