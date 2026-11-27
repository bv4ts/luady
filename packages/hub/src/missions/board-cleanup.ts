import type { Db, Logger, OutboundChannel } from '../core/contracts.js';

export interface RetireBoardDeps {
  db: Db;
  /** Needs the raw-capable members only: the chat's state, unpin and delete. */
  outbound: Pick<OutboundChannel, 'isUp' | 'pin' | 'revoke'>;
  log: Logger;
}

/**
 * One-time retirement of the pinned "running" board message the previous release kept (table `board`, row 1).
 * The table is emptied, never dropped: a rolled-back release still prepares statements on it. True when nothing is
 * left to do; false while the chat is down (try again later).
 */
export function retireBoard(deps: RetireBoardDeps): boolean {
  let row: { chat_msg_id: string } | undefined;
  try {
    row = deps.db.prepare<[], { chat_msg_id: string }>('SELECT chat_msg_id FROM board WHERE id = 1').get();
  } catch {
    return true; // a later release dropped the table
  }
  if (row === undefined) return true;
  if (!deps.outbound.isUp()) return false;
  deps.outbound.pin?.(row.chat_msg_id, false);
  deps.outbound.revoke?.(row.chat_msg_id);
  try {
    deps.db.prepare('DELETE FROM board').run();
  } catch {
    return true;
  }
  deps.log.info({ msgId: row.chat_msg_id }, 'missions: retired the pinned board message');
  return true;
}
