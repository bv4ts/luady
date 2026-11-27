import { isBuiltinChannel, isChatChannel, type BuiltinChannel, type Channel } from '@luady/shared';

export const CHANNEL_LABEL: Readonly<Record<BuiltinChannel, string>> = {
  web: 'Web', phone: 'Phone', event: 'Event', scheduled: 'Scheduled', remote_control: 'Claude app',
};

/** Every chat channel (an add-on's id) reads the same, like the manager's `[Chat · …]` prompt prefix. */
export const CHAT_CHANNEL_LABEL = 'Chat';

/** The label of any channel: a built-in one by name, a chat add-on's as "Chat", anything else as it is. */
export function channelLabel(channel: Channel): string {
  if (isBuiltinChannel(channel)) return CHANNEL_LABEL[channel];
  return isChatChannel(channel) ? CHAT_CHANNEL_LABEL : channel;
}
