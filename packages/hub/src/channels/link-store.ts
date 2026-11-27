import type { Db, OutboundLink } from '../core/contracts.js';

/** The kinds a stored reply link may have (channel_links.kind). */
export const LINK_KINDS = ['question', 'session', 'action', 'manager'] as const;
const isLinkKind = (kind: string): kind is OutboundLink['kind'] => (LINK_KINDS as readonly string[]).includes(kind);

/**
 * Reply links and dedupe for every chat channel (`channel_links`, `channel_seen`), keyed by the channel's add-on id.
 * A link says which question, action, session or manager message a sent chat message belongs to, so the owner's reply
 * to it is routed there.
 */
export interface LinkStore {
  link(channel: string, msgId: string, link: OutboundLink, at: string): void;
  find(channel: string, msgId: string | null | undefined): OutboundLink | null;
  /** True the first time this channel's message id is seen; false for a repeat (the add-on re-sent it). */
  firstSighting(channel: string, msgId: string, at: string): boolean;
}

export function createLinkStore(db: Db): LinkStore {
  const insert = db.prepare<[string, string, string, string, string]>(
    'INSERT OR REPLACE INTO channel_links (channel, msg_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const select = db.prepare<[string, string], { kind: string; ref_id: string }>(
    'SELECT kind, ref_id FROM channel_links WHERE channel = ? AND msg_id = ?',
  );
  const seen = db.prepare<[string, string, string]>('INSERT OR IGNORE INTO channel_seen (channel, msg_id, seen_at) VALUES (?, ?, ?)');
  return {
    link(channel, msgId, link, at) {
      insert.run(channel, msgId, link.kind, link.refId, at);
    },
    find(channel, msgId) {
      if (msgId === null || msgId === undefined || msgId === '') return null;
      const row = select.get(channel, msgId);
      return row !== undefined && isLinkKind(row.kind) ? { kind: row.kind, refId: row.ref_id } : null;
    },
    firstSighting: (channel, msgId, at) => seen.run(channel, msgId, at).changes === 1,
  };
}
