type Key<T> = (value: T) => string;

export function upsertBy<T>(items: readonly T[], item: T, key: Key<T>): readonly T[] {
  const id = key(item);
  const index = items.findIndex((existing) => key(existing) === id);
  if (index === -1) return [...items, item];
  return items.map((existing, i) => (i === index ? item : existing));
}

export function removeBy<T>(items: readonly T[], id: string, key: Key<T>): readonly T[] {
  return items.some((existing) => key(existing) === id) ? items.filter((existing) => key(existing) !== id) : items;
}

export function appendUnique<T>(items: readonly T[], added: readonly T[], key: Key<T>): readonly T[] {
  const seen = new Set(items.map(key));
  const fresh: T[] = [];
  for (const item of added) {
    const id = key(item);
    if (!seen.has(id)) {
      seen.add(id);
      fresh.push(item);
    }
  }
  return fresh.length === 0 ? items : [...items, ...fresh];
}

export function prependUnique<T>(items: readonly T[], older: readonly T[], key: Key<T>): readonly T[] {
  const seen = new Set(items.map(key));
  const fresh: T[] = [];
  for (const item of older) {
    const id = key(item);
    if (!seen.has(id)) {
      seen.add(id);
      fresh.push(item);
    }
  }
  return fresh.length === 0 ? items : [...fresh, ...items];
}

/**
 * Merges a freshly fetched newest page into what is on screen. When the page overlaps the
 * loaded items it is spliced in at its first item (older pages and newer live items stay).
 * Without overlap there is a gap, so the page replaces everything.
 */
export function mergeNewestPage<T>(items: readonly T[], page: readonly T[], key: Key<T>): { items: readonly T[]; anchored: boolean } {
  const first = page[0];
  if (first === undefined) return { items, anchored: true };
  const anchor = items.findIndex((existing) => key(existing) === key(first));
  if (anchor === -1) return { items: appendUnique([], page, key), anchored: false };
  const pageIds = new Set(page.map(key));
  const after = items.slice(anchor).filter((existing) => !pageIds.has(key(existing)));
  return { items: [...items.slice(0, anchor), ...page, ...after], anchored: true };
}
