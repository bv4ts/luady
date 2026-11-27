import { LIMITS, LinkUrlSchema, type LinkDTO } from '@luady/shared';

export type UrlCheck = { readonly url: string } | { readonly error: string };

/**
 * A link as the owner typed it: trimmed, `https://` added when no scheme was typed ("github.com/x" means the https
 * address). Anything else that is not `https://` is refused in plain words.
 */
export function checkUrl(text: string): UrlCheck {
  const raw = text.trim();
  if (raw === '') return { error: 'Paste the address.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  if (!/^https:\/\//i.test(withScheme)) return { error: 'Only https:// links can go on the shelf.' };
  if (withScheme.length > LIMITS.linkUrlMax) return { error: 'That address is too long (500 characters at most).' };
  const parsed = LinkUrlSchema.safeParse(withScheme);
  if (!parsed.success) return { error: 'That does not look like a web address.' };
  try {
    if (!new URL(withScheme).hostname.includes('.')) return { error: 'That does not look like a web address.' };
  } catch {
    return { error: 'That does not look like a web address.' };
  }
  return { url: withScheme };
}

/** What the label box is missing; null when it is fine. */
export function labelError(label: string): string | null {
  const text = label.trim();
  if (text === '') return 'Give the link a short name.';
  return text.length > LIMITS.linkLabelMax ? 'Keep the name under 40 characters.' : null;
}

/** "github.com" from an address, for the card's small line. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** One office's links in shelf order (position, then the oldest first). */
export function officeLinks(items: readonly LinkDTO[], server: string): readonly LinkDTO[] {
  return items.filter((link) => link.server === server).toSorted((a, b) => a.position - b.position || a.id - b.id);
}

/**
 * Moving a link one place up or down: the new shelf order numbered 0, 1, 2… and only the links whose position
 * changed (each one is a `PUT` with its new position). Nothing when it is already at that end.
 */
export function moveLink(shelf: readonly LinkDTO[], id: number, direction: -1 | 1): readonly { readonly id: number; readonly position: number }[] {
  const from = shelf.findIndex((link) => link.id === id);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= shelf.length) return [];
  const order = shelf.map((link) => link.id);
  const swapped = order.map((value, index) => (index === from ? order[to] : index === to ? order[from] : value)) as number[];
  return swapped.flatMap((linkId, position) => {
    const link = shelf.find((item) => item.id === linkId);
    return link !== undefined && link.position !== position ? [{ id: linkId, position }] : [];
  });
}

/** A shelf holds at most 12 links. */
export const shelfFull = (shelf: readonly LinkDTO[]): boolean => shelf.length >= LIMITS.linksPerOfficeMax;
