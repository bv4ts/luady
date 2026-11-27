export const MAX_QUERY_TERMS = 12;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * Safe FTS5 MATCH expression: every whitespace-separated term becomes a quoted string (`"` doubled),
 * so operators such as OR, NEAR, `*` and parentheses are plain words. Terms are AND-joined.
 * Terms without a letter or digit are dropped; returns null when nothing searchable remains.
 */
export function buildFtsQuery(query: string): string | null {
  const terms = query
    .split(/\s+/u)
    .filter((term) => WORD_CHAR_RE.test(term))
    .slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}
