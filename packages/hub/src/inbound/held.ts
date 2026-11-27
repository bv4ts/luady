import type { Channel } from '@luady/shared';
import { HELD_FIRST, HELD_MORE } from '../claude-login/text.js';
import type { LuadyService } from '../core/contracts.js';
import type { Reply } from './commands.js';

/**
 * Hands an owner message from a chat channel to the manager, as from that channel. While the manager is signed out
 * the service keeps it in its queue; the owner is told so (the first kept message explains, the next ones confirm).
 */
export async function postToLuady(
  luady: Pick<LuadyService, 'postOwnerMessage' | 'signedOut' | 'status'>, text: string, reply: Reply, channel: Channel,
): Promise<void> {
  const held = luady.signedOut?.() === true;
  const first = held && luady.status().queued === 0;
  await luady.postOwnerMessage(text, channel);
  if (held) await reply(first ? HELD_FIRST : HELD_MORE);
}
