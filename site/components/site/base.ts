/**
 * The site's base path ('' at the root of a host, '/luady' under a folder), set by next.config.mjs from SITE_URL.
 * Every link and file the pages write starts with it; Next.js adds it to its own links and scripts.
 */
export const BASE_PATH: string = process.env.LUADY_BASE_PATH ?? '';

/** The site's address from SITE_URL ('' when the build had none). */
export const SITE_URL: string = process.env.LUADY_SITE_URL ?? '';

/** `asset('pixel/sprites.png')` is `/luady/pixel/sprites.png` under /luady/. */
export function asset(path: string): string {
  return `${BASE_PATH}/${path.replace(/^\/+/, '')}`;
}

/** A link to a page of the site by its folder address: `href('docs/rooms/')`; `href('')` is the home page. */
export const href = asset;
