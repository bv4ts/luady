/** Most entries one memo keeps; the least recently used one goes first. */
export const MEMO_LIMIT = 32;

/** A small bounded cache of frozen values, so callers that rebuild on every update get the same objects back. */
export interface Memo<V> {
  get(key: string, make: () => V): V;
  size(): number;
}

/** A least-recently-used cache. Only for values that never change (frozen data). */
export function createMemo<V>(limit = MEMO_LIMIT): Memo<V> {
  const entries = new Map<string, V>();
  return Object.freeze({
    get(key: string, make: () => V): V {
      if (entries.has(key)) {
        const hit = entries.get(key) as V;
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const value = make();
      entries.set(key, value);
      if (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      return value;
    },
    size: (): number => entries.size,
  });
}
