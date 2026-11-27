import { LIMITS, type HubToAddon } from '@luady/shared';
import type { Clock, EventBus, Logger, OutboundChannel, OutboundLink, OutboundMedia, OutboundMediaPath, OwnerChannel } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { splitForChat } from '../notify/format.js';
import type { AddonRegistry } from './addons-file.js';
import type { AddonLink, ChannelHost } from './host.js';
import type { LinkStore } from './link-store.js';
import type { Outbox, OutboxFile } from './outbox.js';
import type { FileIdentity } from './paths.js';

/** Text frames held while the primary channel is connected but still starting (flushed when it is up). */
export const QUEUE_LIMIT = 200;
export const ACK_TIMEOUT_MS = 30_000;
/** A file sent inline: uploads are slower than text. */
export const MEDIA_ACK_TIMEOUT_MS = 330_000;
/** A file the add-on reads from disk (up to about 2 GB). */
export const LOCAL_FILE_ACK_TIMEOUT_MS = 50 * 60_000;
const PENDING_LIMIT = 1000;

/** A file for the owner: inline (`b64`) or on this machine (`path`). */
export interface OwnerFile {
  readonly kind: 'image' | 'document' | 'video' | 'audio';
  readonly mime: string;
  readonly fileName: string;
  readonly caption: string;
  readonly b64?: string;
  readonly path?: string;
  /** For a path an add-on handed over: the file the path check saw, which the copy must still find. */
  readonly identity?: FileIdentity;
}

/** Where a file went: the chat, or the website's outbox while no channel can take it. */
export type FileDelivery =
  | { readonly via: 'chat'; readonly msgId: string }
  | { readonly via: 'website'; readonly noticeId: string | null; readonly file: OutboxFile };

/** The website side: what cannot go to the chat is kept there as a notice (the notice router, bound late). */
export interface WebsiteFallback {
  /** Stores a notice; returns its id. */
  keep(input: { readonly text: string; readonly link: OutboundLink | null; readonly file?: OutboxFile }): Promise<string | null>;
}

declare module '../core/contracts.js' {
  interface OutboundChannel {
    /** A file for the owner: on the chat when a channel is up and takes files, otherwise kept on the website. */
    sendFile?(file: OwnerFile): Promise<FileDelivery>;
  }
}

/** The facade every owner-facing sender of the hub uses. */
export interface OwnerChannelFacade extends OwnerChannel {
  /** The primary channel's id while it is up, else null. */
  channelId(): string | null;
  /** A primary channel is declared (so a notice kept on the website may still go to the chat later). */
  declared(): boolean;
  sendFile(file: OwnerFile): Promise<FileDelivery>;
  /**
   * The sender for replies to a message that came from channel `id`: the facade itself for the primary channel, else
   * one bound to that channel (its own capabilities; the website when it is not up).
   */
  onChannel(id: string): OutboundChannel;
  stop(): void;
}

export interface OwnerChannelDeps {
  host: ChannelHost;
  addons: AddonRegistry;
  links: LinkStore;
  outbox: Outbox;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  website: () => WebsiteFallback;
}

interface Ack { msgId: string | null; refused: boolean }
interface PendingAck { channel: string; link: OutboundLink | null; resolve: ((ack: Ack) => void) | null; timer: ReturnType<typeof setTimeout> | null }
interface Queued { text: string; link: OutboundLink | null; quotedId: string | null }

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** What a file notice says on the website (and on the chat, should it go there later). */
export function fileNoticeText(caption: string, fileName: string): string {
  const line = `📎 ${fileName}: download it on the website.`;
  return caption.trim() === '' ? line : `${caption.trim()}\n${line}`;
}

export function createOwnerChannel(deps: OwnerChannelDeps): OwnerChannelFacade {
  const pending = new Map<string, PendingAck>();
  let queue: readonly Queued[] = [];
  let profile: { about: string; description: string } | null = null;

  const primaryId = (): string | null => deps.addons.primary()?.id ?? null;
  const primaryLink = (): AddonLink | null => {
    const id = primaryId();
    return id === null ? null : deps.host.link(id);
  };
  /** The primary channel, when it is up. */
  const upLink = (): AddonLink | null => {
    const link = primaryLink();
    return link !== null && link.ready() && link.state() === 'up' ? link : null;
  };
  const caps = (link: AddonLink) => link.capabilities();
  const canText = (link: AddonLink | null): link is AddonLink => link !== null && caps(link)?.text === true;

  function remember(ref: string, entry: PendingAck): void {
    pending.set(ref, entry);
    const oldest = pending.size > PENDING_LIMIT ? pending.keys().next().value : undefined;
    if (oldest !== undefined) pending.delete(oldest);
  }

  function waitForAck(ref: string, channel: string, link: OutboundLink | null, timeoutMs: number): Promise<Ack> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = pending.get(ref);
        if (entry !== undefined) pending.set(ref, { ...entry, resolve: null, timer: null });
        resolve({ msgId: null, refused: false });
      }, timeoutMs);
      remember(ref, { channel, link, resolve, timer });
    });
  }

  /** Splits by the channel's maxText; only the first chunk quotes, and only when the channel can quote. */
  function framesFor(link: AddonLink, text: string, quotedId: string | null): Array<Extract<HubToAddon, { t: 'send' }>> {
    const max = caps(link)?.maxText ?? LIMITS.addonMaxTextMin;
    const quotes = caps(link)?.replyQuote === true;
    return splitForChat(text, max).map((chunk, index) => ({
      t: 'send' as const, ref: newId(), text: chunk, replyTo: index === 0 && quotes ? quotedId : null,
    }));
  }

  function transmitText(link: AddonLink, text: string, outLink: OutboundLink | null, quotedId: string | null): Promise<Ack> | null {
    const frames = framesFor(link, text, quotedId);
    const last = frames[frames.length - 1];
    if (last === undefined) return Promise.resolve({ msgId: null, refused: false });
    const ack = waitForAck(last.ref, link.decl.id, outLink, ACK_TIMEOUT_MS);
    for (const frame of frames) {
      if (!link.send(frame)) return null;
    }
    return ack;
  }

  async function toWebsite(text: string, link: OutboundLink | null): Promise<void> {
    try {
      await deps.website().keep({ text, link });
    } catch (err) {
      deps.log.error({ err }, 'channels: a message for the owner could not be kept on the website');
    }
  }

  /** The held texts go to the website once the channel leaves `starting` without coming up. */
  function releaseQueue(): void {
    const held = queue;
    queue = [];
    if (held.length > 0) deps.log.warn({ messages: held.length }, 'channels: the chat channel did not come up; held messages go to the website');
    for (const item of held) void toWebsite(item.text, item.link);
  }

  function flushQueue(link: AddonLink): void {
    const held = queue;
    queue = [];
    for (const item of held) {
      const ack = transmitText(link, item.text, item.link, item.quotedId);
      if (ack === null) void toWebsite(item.text, item.link);
    }
  }

  async function sendChecked(text: string, link: OutboundLink | null, quotedId: string | null = null): Promise<Ack> {
    const up = upLink();
    if (canText(up)) {
      const ack = transmitText(up, text, link, quotedId);
      if (ack !== null) return ack;
    }
    const starting = primaryLink();
    if (starting !== null && starting.ready() && starting.state() === 'starting') {
      const combined = [...queue, { text, link, quotedId }];
      const overflow = Math.max(0, combined.length - QUEUE_LIMIT);
      if (overflow > 0) deps.log.warn({ dropped: overflow }, 'channels: outbound queue full, dropped the oldest');
      queue = combined.slice(overflow);
      return { msgId: null, refused: false };
    }
    // Nothing can take it: the notice fallback tries again later; it is refused here, never turned into a notice.
    return { msgId: null, refused: true };
  }

  /** A plain send: the chat when it is up, otherwise the website. Never throws for a missing channel. */
  async function send(text: string, link: OutboundLink | null, quotedId: string | null = null): Promise<string | null> {
    const ack = await sendChecked(text, link, quotedId);
    if (ack.refused && ack.msgId === null && upLink() === null) await toWebsite(text, link);
    return ack.msgId;
  }

  async function sendFileFrame(frame: Omit<Extract<HubToAddon, { t: 'send_file' }>, 'ref'>, bytes: number | null, timeoutMs: number): Promise<string> {
    const link = upLink();
    const capabilities = link === null ? null : caps(link);
    if (link === null || capabilities?.files !== true) throw new RefusedError('No chat channel that takes files is up');
    if (bytes !== null && bytes > capabilities.maxFileBytes) throw new RefusedError(`The chat channel takes files up to ${capabilities.maxFileBytes} bytes`);
    const ref = newId();
    const ack = waitForAck(ref, link.decl.id, null, timeoutMs);
    if (!link.send({ ...frame, ref, caption: clip(frame.caption, 1000) })) throw new RefusedError('The chat channel went away');
    const { msgId } = await ack;
    if (msgId === null) throw new RefusedError('The chat channel could not send the file');
    return msgId;
  }

  const sendMedia = (media: OutboundMedia): Promise<string> =>
    sendFileFrame({ t: 'send_file', kind: media.kind, mime: media.mime, fileName: media.fileName, caption: media.caption, b64: media.b64 },
      b64Bytes(media.b64), MEDIA_ACK_TIMEOUT_MS);

  const sendMediaPath = (media: OutboundMediaPath): Promise<string> =>
    sendFileFrame({ t: 'send_file', kind: media.kind, mime: media.mime, fileName: media.fileName, caption: media.caption, path: media.path },
      null, LOCAL_FILE_ACK_TIMEOUT_MS);

  async function sendFile(file: OwnerFile): Promise<FileDelivery> {
    const link = upLink();
    if (link !== null && caps(link)?.files === true) {
      try {
        const msgId = file.b64 !== undefined
          ? await sendFileFrame({ t: 'send_file', kind: file.kind, mime: file.mime, fileName: file.fileName, caption: file.caption, b64: file.b64 },
            b64Bytes(file.b64), MEDIA_ACK_TIMEOUT_MS)
          : await sendFileFrame({ t: 'send_file', kind: file.kind, mime: file.mime, fileName: file.fileName, caption: file.caption, path: file.path ?? '' },
            null, LOCAL_FILE_ACK_TIMEOUT_MS);
        return { via: 'chat', msgId };
      } catch (err) {
        deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'channels: the chat channel did not take a file; it goes to the website');
      }
    }
    const kept = await deps.outbox.put(file.b64 !== undefined
      ? { name: file.fileName, mime: file.mime, data: Buffer.from(file.b64, 'base64') }
      : { name: file.fileName, mime: file.mime, fromPath: file.path ?? '', ...(file.identity === undefined ? {} : { identity: file.identity }) });
    const noticeId = await deps.website().keep({ text: fileNoticeText(file.caption, kept.name), link: null, file: kept });
    if (noticeId !== null) deps.outbox.attach(kept.id, noticeId);
    return { via: 'website', noticeId, file: noticeId === null ? kept : { ...kept, noticeId } };
  }

  /** Best effort: only when the primary channel is up and declared the capability. */
  function bestEffort(capability: 'typing' | 'played' | 'pin' | 'revoke' | 'profile', frame: HubToAddon, link: AddonLink | null = upLink()): void {
    if (link !== null && caps(link)?.[capability] === true) link.send(frame);
  }

  /** Channel `id` when it is up (any declared channel, not only the primary). */
  const upLinkOf = (id: string): AddonLink | null => {
    const link = deps.host.link(id);
    return link !== null && link.ready() && link.state() === 'up' ? link : null;
  };

  /** A sender bound to one non-primary channel: no queue; what it cannot take waits on the website. */
  function boundTo(id: string): OutboundChannel {
    const checked = async (text: string, link: OutboundLink | null, quotedId: string | null = null): Promise<Ack> => {
      const up = upLinkOf(id);
      const ack = canText(up) ? transmitText(up, text, link, quotedId) : null;
      return ack ?? { msgId: null, refused: true };
    };
    return {
      isUp: () => canText(upLinkOf(id)),
      sendChecked: checked,
      async send(text, link, quotedId = null) {
        const ack = await checked(text, link, quotedId);
        if (ack.refused) await toWebsite(text, link);
        return ack.msgId;
      },
      typing: (on) => bestEffort('typing', { t: 'typing', on }, upLinkOf(id)),
      markPlayed: (msgId) => bestEffort('played', { t: 'played', msgId }, upLinkOf(id)),
    };
  }

  async function edit(msgId: string, text: string): Promise<boolean> {
    const link = upLink();
    const capabilities = link === null ? null : caps(link);
    if (link === null || capabilities?.edit !== true) return false;
    const ref = newId();
    const ack = waitForAck(ref, link.decl.id, null, ACK_TIMEOUT_MS);
    if (!link.send({ t: 'edit', ref, msgId, text: clip(text, capabilities.maxText) })) return false;
    const result = await ack;
    return result.msgId !== null && !result.refused;
  }

  function sendProfile(): void {
    if (profile === null) return;
    bestEffort('profile', {
      t: 'profile', about: clip(profile.about, LIMITS.addonProfileAboutMax), description: clip(profile.description, LIMITS.addonProfileDescriptionMax),
    });
  }

  const unsubscribe = deps.host.subscribe({
    sent(id, frame) {
      const entry = pending.get(frame.ref);
      if (entry === undefined || entry.channel !== id) return;
      pending.delete(frame.ref);
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (frame.error !== null) deps.log.warn({ addon: id, ref: frame.ref }, 'channels: the chat channel could not send');
      if (frame.msgId !== null && entry.link !== null) deps.links.link(id, frame.msgId, entry.link, deps.clock.now().toISOString());
      entry.resolve?.({ msgId: frame.msgId, refused: frame.error !== null });
    },
    up(id) {
      if (id !== primaryId()) return;
      const link = upLink();
      if (link !== null) flushQueue(link);
      sendProfile();
    },
    status(id, state) {
      if (id === primaryId() && state !== 'up' && state !== 'starting') releaseQueue();
    },
    gone(id) {
      if (id === primaryId()) releaseQueue();
    },
  });

  const facade: OwnerChannelFacade = {
    isUp: () => canText(upLink()),
    channelId: () => (canText(upLink()) ? primaryId() : null),
    declared: () => primaryId() !== null,
    send,
    sendChecked,
    sendMedia,
    sendMediaPath,
    sendFile,
    typing: (on) => bestEffort('typing', { t: 'typing', on }),
    markPlayed: (msgId) => bestEffort('played', { t: 'played', msgId }),
    edit,
    pin: (msgId, on, seconds) => bestEffort('pin', { t: 'pin', msgId, on, ...(seconds === undefined ? {} : { seconds }) }),
    revoke: (msgId) => bestEffort('revoke', { t: 'revoke', msgId }),
    setProfile(about, description) {
      profile = { about, description };
      sendProfile();
    },
    async unlink() {
      const link = primaryLink();
      if (link === null || !link.ready()) throw new RefusedError('No chat channel is connected.');
      link.send({ t: 'unlink' });
    },
    onChannel: (id) => (id === primaryId() ? facade : boundTo(id)),
    stop() {
      unsubscribe();
      for (const entry of pending.values()) if (entry.timer !== null) clearTimeout(entry.timer);
      pending.clear();
    },
  };
  return facade;
}
