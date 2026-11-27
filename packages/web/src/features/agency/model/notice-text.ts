import { NOTICE_SETTLED_VIA, isChatChannel, type ChannelInfoDTO, type NoticeDTO, type NoticeKind } from '@luady/shared';
import type { IconName } from '../../../ui/Icon.js';
import { formatClock } from '../hud/Clock.js';

/** What a chat channel is called when the hub has not named one. */
export const CHAT_FALLBACK = 'your chat channel';

const at = (iso: string | null): string => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? formatClock(ms) : '';
};

/** A chat channel's name for the owner: that channel's, else the primary channel's, else "your chat channel". */
export function chatChannelName(channels: readonly ChannelInfoDTO[], id: string | null = null): string {
  const named = channels.find((channel) => channel.id === id) ?? channels.find((channel) => channel.primary);
  return named === undefined || named.name.trim() === '' ? CHAT_FALLBACK : named.name;
}

/** Settled by a chat channel: a channel id, not one of the hub's own reasons (web, answer, expired). */
const viaChat = (via: string | null): boolean => via !== null && !(NOTICE_SETTLED_VIA as readonly string[]).includes(via) && isChatChannel(via);

/**
 * Where a notice went, in words. No fallback time means it stays on the website (the hub also drops the time after
 * the chat channel refused it three times; that is not a state of its own). `channel`: the chat channel's name.
 */
export function noticeStatus(notice: NoticeDTO, _now: Date, channel: string = CHAT_FALLBACK): string {
  if (notice.settledVia === 'web') return 'Seen';
  if (notice.settledVia === 'answer') return 'Answered';
  if (viaChat(notice.settledVia) || notice.chatSentAt !== null) return `Sent to ${channel} ${at(notice.chatSentAt ?? notice.settledAt)}`.trim();
  if (notice.settledAt !== null) return '';
  return notice.chatDueAt === null ? 'Website only' : `Goes to ${channel} at ${at(notice.chatDueAt)}`;
}

/** The hub writes notices for the chat channel; its "↩️ Reply …" lines say how to answer there and mean nothing here. */
const REPLY_HINT = /^\s*↩️\s*Reply\b/u;

/** A notice's text as the website shows it: without the chat channel's reply hints. */
export function noticeBody(text: string): string {
  return text.split('\n').filter((line) => !REPLY_HINT.test(line)).join('\n').trimEnd();
}

const ICONS: Readonly<Record<NoticeKind, IconName>> = Object.freeze({
  reply: 'message', result: 'check', question: 'alert', permission: 'key', alert: 'alert', mail: 'message',
  meeting: 'book', morning: 'manager', system: 'server',
});

export function noticeIcon(kind: NoticeKind): IconName {
  return ICONS[kind];
}
