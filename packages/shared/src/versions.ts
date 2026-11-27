/** The first kit version with step events, the pause verbs, sign-out and structured permission previews. */
export const KIT_V2 = '2.0.0';
/** The first kit version with the `skills`, `kb-put` and `git-status` verbs and the knowledge-base line at session start. */
export const KIT_V21 = '2.1.0';

const VERSION_RE = /^\d+(?:\.\d+)*$/;

function parts(version: string): readonly number[] | null {
  return VERSION_RE.test(version) ? version.split('.').map(Number) : null;
}

/**
 * Dotted numeric compare: is `version` the same as or newer than `min`? Missing parts count as 0 ('2.1' ≥ '2.0.0').
 * Null, undefined, an empty string or any non-numeric part (on either side) is false, so an unknown kit is treated as too old.
 */
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  if (version === null || version === undefined) return false;
  const have = parts(version);
  const need = parts(min);
  if (have === null || need === null) return false;
  const length = Math.max(have.length, need.length);
  for (let i = 0; i < length; i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
