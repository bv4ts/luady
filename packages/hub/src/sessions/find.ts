import { isHostId } from '@luady/shared';
import type { SessionRow } from './registry.js';

function pickUnique(rows: readonly SessionRow[], name: string): SessionRow | undefined {
  const wanted = name.toLowerCase();
  const matches = rows.filter((row) => row.displayName.toLowerCase() === wanted);
  const live = matches.filter((row) => row.state !== 'ended');
  if (live.length > 0) return live.length === 1 ? live[0] : undefined;
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Exact id first; then "<host>/<display name>" or a bare display name, compared case-insensitively.
 * Live rows win over ended ones, an ambiguous name resolves to nothing, and the brain
 * (origin `system`) is only reachable by its exact id.
 */
export function findSessionByRef(rows: readonly SessionRow[], ref: string): SessionRow | undefined {
  const wanted = ref.trim();
  if (wanted === '') return undefined;
  const exact = rows.find((row) => row.id === wanted);
  if (exact !== undefined) return exact;
  const named = rows.filter((row) => row.origin !== 'system');
  const slash = wanted.indexOf('/');
  if (slash > 0) {
    const host = wanted.slice(0, slash);
    if (isHostId(host)) return pickUnique(named.filter((row) => row.host === host), wanted.slice(slash + 1));
  }
  return pickUnique(named, wanted);
}
