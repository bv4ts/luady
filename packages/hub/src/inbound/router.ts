import type { Channel, MediaRef, QuestionDTO } from '@luady/shared';
import { chatNoAllowReason } from '../notify/permission-text.js';
import type { IncomingFrame } from '../channels/host.js';
import type { LinkStore } from '../channels/link-store.js';
import type {
  ActionService, BoardService, Clock, Fleet, LuadyService, Logger, MissionTracker, OutboundChannel, OutboundLink, PhoneService, QuestionService,
  SessionService, SettingsService,
} from '../core/contracts.js';
import {
  PIN_LIKE_NOTICE, TEXT_ONLY_NOTICE, actionFailedNotice, actionReplyHelp, alreadyNotice, answerDeliveredAck,
  approvedAck, cancelledAck, questionGoneNotice, questionLabel, sessionLabel,
} from '../notify/format.js';
import { codeInMessage } from '../claude-login/code.js';
import type { ChatLogin } from '../claude-login/chat-login.js';
import { describeQuotedMedia, textWithAttachment, voiceNoteText, type IncomingMedia } from './attachment.js';
import type { NoticeRouter } from '../notices/router.js';
import { runCommand, type CommandDeps, type Reply } from './commands.js';
import { postToLuady } from './held.js';
import { noticeForError } from './errors.js';
import { importMedia } from './media.js';
import {
  isOptionList, looksLikePin, parseActionReply, parseCommand, parsePermissionReply, parseQuestionReply,
  soleSimpleQuestion, soundsLikePin, type Command,
} from './parse.js';

/** The kinds a stored reply link may have (channel_links.kind; the registry in db/name-map.ts reads it here). */
export { LINK_KINDS } from '../channels/link-store.js';

export interface RouterDeps {
  clock: Clock;
  log: Logger;
  links: LinkStore;
  /** The owner channel facade (the primary channel). */
  outbound: OutboundChannel;
  /** The sender bound to the channel a message came from: replies go back there. The primary when absent. */
  outboundFor?: (channel: Channel) => OutboundChannel;
  questions: QuestionService;
  sessions: SessionService;
  actions: ActionService;
  luady: LuadyService;
  settings: SettingsService;
  phone: PhoneService;
  fleet: Fleet;
  /** Where an add-on's files may come from, and where the manager reads them (the brain inbox). */
  media: { root(channel: string): string; inboxDir: string };
  missions?: Pick<MissionTracker, 'list'>;
  todos?: { render(): string };
  /** /todo <text> adds a card. */
  board?: Pick<BoardService, 'add'>;
  googleStatus?: () => string | null;
  login?: ChatLogin;
  wispr?: { command(arg: string | null): Promise<string> };
  /** /q marks what it re-sent as sent, so a website-first fallback never repeats it. */
  notices?: Pick<NoticeRouter, 'sentElsewhere'>;
}

/** One owner message, as the router reads it: the add-on's `incoming`, its files checked and moved to the inbox. */
interface Message {
  readonly channel: Channel;
  readonly msgId: string;
  readonly text: string;
  readonly quotedId: string | null;
  readonly quotedText: string | undefined;
  readonly quotedFromMe: boolean | undefined;
  readonly quotedMedia: MediaRef | undefined;
  readonly media: IncomingMedia | undefined;
}

/** Tells the manager which message a chat reply answers, quoting it, so "this" or "do it" has a referent. */
export function replyNote(msg: Pick<Message, 'quotedId' | 'quotedText' | 'quotedFromMe'>, about: string | null): string {
  if (msg.quotedId === null) return '';
  const whose = about !== null ? `your message about ${about}`
    : msg.quotedFromMe === true ? 'your message' : msg.quotedFromMe === false ? 'their own message' : 'an earlier message';
  return `\n(Reply to ${whose}${msg.quotedText ? `: "${msg.quotedText}"` : ''})`;
}

/** The owner's text, or the words of a voice note, is shaped like a PIN. */
function carriesPin(msg: Pick<Message, 'text' | 'media'>): boolean {
  const transcript = msg.media?.voice?.transcript ?? null;
  return looksLikePin(msg.text) || (transcript !== null && soundsLikePin(transcript));
}

export interface InboundRouter {
  /** One `incoming` from a channel add-on that passed the owner gate (channels/host.ts). */
  handle(channel: Channel, frame: IncomingFrame): Promise<void>;
}

export function createInboundRouter(deps: RouterDeps): InboundRouter {
  const outboundOf = (channel: Channel): OutboundChannel => deps.outboundFor?.(channel) ?? deps.outbound;

  function replier(channel: Channel, msgId: string): Reply {
    const outbound = outboundOf(channel);
    return async (text) => {
      try {
        await outbound.send(text, null, msgId);
      } catch (err) {
        deps.log.error({ err, msgId }, 'inbound: reply failed');
      }
    };
  }

  async function answerQuestion(msg: Message, question: QuestionDTO, text: string, reply: Reply): Promise<void> {
    // Each line answers one question: none may be the PIN, which a session's question could be fishing for.
    if (text.split(/\r?\n/).some(looksLikePin)) return reply(PIN_LIKE_NOTICE);
    const label = questionLabel(question, deps.sessions.get(question.sessionId));
    try {
      if (question.kind === 'permission') {
        const decision = parsePermissionReply(text);
        // The same rule as the chat text (notify/permission-text.ts): part hidden, or cut by the chat, and a yes here
        // would allow what the owner could not read. The refusal says which.
        const noAllow = question.permission === null ? null : chatNoAllowReason(question.permission);
        if (decision.behavior === 'allow' && noAllow !== null) return reply(`ℹ️ ${noAllow}`);
        await deps.questions.answerPermission(question.qid, decision.behavior, decision.message, msg.channel);
      } else {
        const parsed = parseQuestionReply(question.qid, question.questions, text);
        if (!parsed.ok) return reply(parsed.help);
        await deps.questions.answer(question.qid, parsed.value, msg.channel);
      }
      return reply(answerDeliveredAck(label));
    } catch (err) {
      return reply(noticeForError(err, { log: deps.log, qid: question.qid, label }));
    }
  }

  async function replyToQuestion(msg: Message, qid: string, reply: Reply): Promise<void> {
    const question = deps.questions.get(qid);
    if (!question) return reply(questionGoneNotice(qid));
    if (question.state !== 'pending') return reply(alreadyNotice(qid, question.state));
    return answerQuestion(msg, question, msg.text, reply);
  }

  /** What the quoted message was about: the session for mission/session messages, else null. */
  function quotedAbout(link: OutboundLink | null): string | null {
    if (link?.kind !== 'session') return null;
    const session = deps.sessions.get(link.refId);
    return `${session ? sessionLabel(session) : link.refId} (${link.refId})`;
  }

  /** Every linked message is one the hub sent, so it counts as the manager's even when the add-on did not say so. */
  function noteFor(msg: Message, link: OutboundLink | null): string {
    const fromMe = link !== null ? true : msg.quotedFromMe;
    const picture = msg.quotedMedia ? `\n${describeQuotedMedia(msg.quotedMedia)}` : '';
    return `${picture}${replyNote({ ...msg, quotedFromMe: fromMe }, quotedAbout(link))}`;
  }

  async function replyToAction(msg: Message, actionId: string, reply: Reply): Promise<void> {
    const parsed = parseActionReply(msg.text);
    if (parsed.kind === 'unknown') return reply(actionReplyHelp(actionId));
    try {
      if (parsed.kind === 'deny') {
        await deps.actions.deny(actionId, msg.channel);
        return reply(cancelledAck(actionId));
      }
      const result = await deps.actions.confirm(actionId, parsed.pin, msg.channel);
      return reply(result.status === 'failed' ? actionFailedNotice(actionId, result.error) : approvedAck(actionId, result.result));
    } catch (err) {
      return reply(noticeForError(err, { log: deps.log }));
    }
  }

  /** Voice notes come transcribed by the add-on; every file then goes to the manager with its path. */
  async function forwardMedia(msg: Message, media: IncomingMedia, reply: Reply): Promise<void> {
    let text = textWithAttachment(msg.text, media);
    if (media.kind === 'audio' && media.voice !== undefined) {
      text = voiceNoteText(media.voice, media);
      if (media.voice.transcript !== null) outboundOf(msg.channel).markPlayed?.(msg.msgId);
    }
    const note = noteFor(msg, deps.links.find(msg.channel, msg.quotedId));
    try {
      await postToLuady(deps.luady, `${text}${note}`, reply, msg.channel);
    } catch (err) {
      await reply(noticeForError(err, { log: deps.log }));
    }
  }

  /** The PIN check runs on the owner's own words, before any reply note is added. */
  async function forwardToLuady(msg: Message, text: string, reply: Reply, note = ''): Promise<void> {
    if (looksLikePin(text)) return reply(PIN_LIKE_NOTICE);
    try {
      await postToLuady(deps.luady, `${text}${note}`, reply, msg.channel);
    } catch (err) {
      await reply(noticeForError(err, { log: deps.log }));
    }
  }

  /** A pasted sign-in code goes to the waiting /login, never to the manager. */
  async function submitCode(msg: Message, code: string, reply: Reply): Promise<void> {
    try {
      await reply(await deps.login!.submit(code, msg.channel));
    } catch (err) {
      await reply(noticeForError(err, { log: deps.log }));
    }
  }

  async function runCommandSafely(msg: Message, command: Command, reply: Reply): Promise<void> {
    const commandDeps: CommandDeps = { ...deps, channel: msg.channel, outbound: outboundOf(msg.channel) };
    try {
      await runCommand(command, commandDeps, reply);
    } catch (err) {
      await reply(noticeForError(err, { log: deps.log }));
    }
  }

  async function routeLinked(link: OutboundLink, msg: Message, reply: Reply): Promise<void> {
    switch (link.kind) {
      case 'question':
        return replyToQuestion(msg, link.refId, reply);
      case 'action':
        return replyToAction(msg, link.refId, reply);
      case 'session':
      case 'manager':
        // The manager controls the sessions: a reply to a mission or manager message goes to it with that context.
        return forwardToLuady(msg, msg.text, reply, noteFor(msg, link));
    }
  }

  async function route(msg: Message): Promise<void> {
    const reply = replier(msg.channel, msg.msgId);
    const link = deps.links.find(msg.channel, msg.quotedId);
    // The PIN belongs only in a text reply to a confirmation message. Anywhere else (an answer, a caption, a voice note,
    // a message to the manager) it is never delivered or stored.
    const confirming = link?.kind === 'action' && msg.media === undefined;
    if (!confirming && carriesPin(msg)) return reply(PIN_LIKE_NOTICE);
    if (msg.media !== undefined) return forwardMedia(msg, msg.media, reply);
    if (msg.text.trim() === '') return reply(TEXT_ONLY_NOTICE);
    const code = deps.login === undefined ? null : codeInMessage(msg.text, deps.login.waiting());
    if (code !== null) return submitCode(msg, code, reply);
    if (link) return routeLinked(link, msg, reply);
    const command = parseCommand(msg.text);
    if (command) return runCommandSafely(msg, command, reply);
    const sole = soleSimpleQuestion(deps.questions.pending());
    if (sole && isOptionList(msg.text)) return answerQuestion(msg, sole, msg.text, reply);
    return forwardToLuady(msg, msg.text, reply, noteFor(msg, null));
  }

  /** The add-on's files are checked and copied into the inbox; a refused path becomes the file's error. */
  async function read(channel: Channel, frame: IncomingFrame): Promise<Message> {
    const where = { root: deps.media.root(channel), inboxDir: deps.media.inboxDir, msgId: frame.msgId, nowMs: deps.clock.now().getTime() };
    const quoted = frame.replyTo?.media;
    return {
      channel, msgId: frame.msgId, text: frame.text, quotedId: frame.replyTo?.msgId ?? null,
      quotedText: frame.replyTo?.text, quotedFromMe: frame.replyTo?.fromMe,
      quotedMedia: quoted === undefined ? undefined : await importMedia(quoted, { ...where, msgId: `q${frame.replyTo?.msgId ?? ''}` }),
      media: frame.media === undefined ? undefined : await importMedia(frame.media, where),
    };
  }

  async function handle(channel: Channel, frame: IncomingFrame): Promise<void> {
    try {
      if (!deps.links.firstSighting(channel, frame.msgId, deps.clock.now().toISOString())) return;
      await route(await read(channel, frame));
    } catch (err) {
      deps.log.error({ err, msgId: frame.msgId }, 'inbound: routing failed');
    }
  }

  return { handle };
}
