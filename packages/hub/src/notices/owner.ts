import { isChatChannel, type Channel } from '@luady/shared';
import type { OutboundChannel } from '../core/contracts.js';
import { noticeChannel, type ChannelDefaults, type NoticeChannelDeps } from './channel.js';
import type { NoticeSource } from './policy.js';

export interface OwnerChannelsDeps extends NoticeChannelDeps {
  /** The source of the manager's running turn, or null when idle (LuadyService.turnSource). */
  turnSource: () => Channel | null;
}

/**
 * The factory for every owner-facing channel. Whatever is produced while the manager answers a chat (or phone)
 * message is part of that answer: it goes to the chat at once, whichever facade sends it. Otherwise the facade's own source.
 */
export function ownerChannels(deps: OwnerChannelsDeps): (defaults: ChannelDefaults) => OutboundChannel {
  const replyingOnChat = (): boolean => {
    const turn = deps.turnSource();
    return turn === 'phone' || isChatChannel(turn);
  };
  return (defaults) => {
    const own = defaults.source;
    const source = (): NoticeSource => {
      if (replyingOnChat()) return 'chat';
      return typeof own === 'function' ? own() : own;
    };
    return noticeChannel(deps, { ...defaults, source });
  };
}
