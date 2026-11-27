import type { NoticeKind, NoticeRef } from '@luady/shared';
import type { OutboundChannel, OutboundLink, QuestionService } from '../core/contracts.js';
import type { NoticeSource } from './policy.js';
import type { NoticeRouter } from './router.js';

export interface ChannelDefaults {
  /** A function is read at every send (the manager's tools: `morning` during the morning brief turn). */
  readonly kind: NoticeKind | (() => NoticeKind);
  readonly source: NoticeSource | (() => NoticeSource);
  /**
   * Send only when the route says "the chat now", straight to the chat and not kept as a notice; otherwise do nothing
   * and return null (for messages the map already shows, like the edited-in-place mission status).
   */
  readonly awayOnly?: boolean;
  /** Every send is time-critical (calendar reminders, sign-in alerts): the chat at once, and the website too. */
  readonly urgent?: boolean;
}

export interface NoticeChannelDeps {
  router: Pick<NoticeRouter, 'post' | 'wouldSendNow'>;
  /** The raw chat channel (the owner channel facade). */
  chat: OutboundChannel;
  questions: Pick<QuestionService, 'get'>;
}

const toRef = (link: OutboundLink | null): NoticeRef | null => (link === null ? null : { kind: link.kind, id: link.refId });

/**
 * The `OutboundChannel` every owner-facing sender gets: `send` goes through the notice router (website first while
 * the owner is there, the chat otherwise); everything else (edit, pin, files, typing…) is the raw chat channel.
 */
export function noticeChannel(deps: NoticeChannelDeps, defaults: ChannelDefaults): OutboundChannel {
  const raw = deps.chat;
  const sourceNow = (): NoticeSource => (typeof defaults.source === 'function' ? defaults.source() : defaults.source);

  function kindOf(link: OutboundLink | null): NoticeKind {
    if (link?.kind === 'question') return deps.questions.get(link.refId)?.kind === 'permission' ? 'permission' : 'question';
    if (link?.kind === 'action') return 'permission';
    return typeof defaults.kind === 'function' ? defaults.kind() : defaults.kind;
  }

  async function route(text: string, link: OutboundLink | null, quotedId: string | null, urgent: boolean) {
    // Quoting the owner's chat message makes it a reply to that message: it goes back on the chat.
    const source: NoticeSource = quotedId !== null ? 'chat' : sourceNow();
    const kind = kindOf(link);
    if (defaults.awayOnly === true) {
      return { msgId: deps.router.wouldSendNow(kind, source) ? await raw.send(text, link, quotedId) : null, held: false };
    }
    const result = await deps.router.post({ kind, source, text, ref: toRef(link), quotedId, urgent: urgent || defaults.urgent === true });
    return { msgId: result.msgId, held: result.notice !== null && result.notice.chatSentAt === null };
  }

  return {
    isUp: () => raw.isUp(),
    send: async (text, link, quotedId = null) => (await route(text, link, quotedId, false)).msgId,
    deliver: (text, link, opts = {}) => route(text, link, null, opts.urgent === true),
    ...(raw.sendMedia === undefined ? {} : { sendMedia: raw.sendMedia }),
    ...(raw.sendMediaPath === undefined ? {} : { sendMediaPath: raw.sendMediaPath }),
    ...(raw.sendFile === undefined ? {} : { sendFile: raw.sendFile }),
    ...(raw.typing === undefined ? {} : { typing: raw.typing }),
    ...(raw.markPlayed === undefined ? {} : { markPlayed: raw.markPlayed }),
    ...(raw.edit === undefined ? {} : { edit: raw.edit }),
    ...(raw.pin === undefined ? {} : { pin: raw.pin }),
    ...(raw.revoke === undefined ? {} : { revoke: raw.revoke }),
  };
}
