import { LIMITS, kbSlug } from '@luady/shared';

const MAX_TRIES = 500;

/**
 * The page's slug: `kbSlug(title)`, or with `-2`, `-3`… when that slug is taken in the same scope, server and project.
 * The number always fits inside the 60-character limit.
 */
export function uniqueSlug(title: string, taken: (slug: string) => boolean): string {
  const base = kbSlug(title);
  if (!taken(base)) return base;
  for (let n = 2; n < MAX_TRIES; n += 1) {
    const suffix = `-${n}`;
    const head = base.slice(0, LIMITS.kbSlugMax - suffix.length).replace(/-+$/, '');
    const candidate = `${head}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('no free knowledge-page slug');
}
