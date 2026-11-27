import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities, HubToAddon } from '@luady/shared';
import { loadAddons, type AddonRegistry } from '../../src/channels/addons-file.js';
import { createChannelHost, type AddonSocket, type ChannelHost } from '../../src/channels/host.js';
import { createLinkStore, type LinkStore } from '../../src/channels/link-store.js';
import { createOutbox, type Outbox } from '../../src/channels/outbox.js';
import { createOwnerChannel, type OwnerChannelFacade, type WebsiteFallback } from '../../src/channels/owner-channel.js';
import { createBus } from '../../src/core/bus.js';
import type { Clock, EventBus, HubConfig, OutboundLink } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { Db } from '../../src/core/contracts.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

/** The owner's address in the test chat (a fictional number). */
export const OWNER = '447700900001';
export const STRANGER = '447700900999';

export const FULL_CAPS: Capabilities = {
  text: true, files: true, edit: true, pin: true, revoke: true, typing: true, played: true, profile: true,
  replyQuote: true, voiceNotes: true, maxText: 100, maxFileBytes: 1_000_000,
};
export const TEXT_CAPS: Capabilities = {
  text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
  replyQuote: false, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
};

type Listener = (...args: unknown[]) => void;

/** An in-process add-on socket: records what the hub sends and plays the add-on's side. */
export interface FakeAddonSocket extends AddonSocket {
  readonly frames: Array<Record<string, unknown>>;
  readonly closed: Array<{ code: number | undefined; reason: string | undefined }>;
  /** The add-on sends one frame (an object is JSON-encoded; a string goes as is). */
  say(frame: Record<string, unknown> | string): void;
  /** Frames of one type the hub sent. */
  of(type: string): Array<Record<string, unknown>>;
  /** The connection drops from the add-on's side. */
  drop(): void;
}

export function fakeAddonSocket(): FakeAddonSocket {
  let listeners: ReadonlyMap<string, readonly Listener[]> = new Map();
  const fire = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const socket = {
    readyState: 1,
    frames: [] as Array<Record<string, unknown>>,
    closed: [] as Array<{ code: number | undefined; reason: string | undefined }>,
    send(data: string, callback?: (err?: Error) => void) {
      socket.frames.push(JSON.parse(data) as Record<string, unknown>);
      callback?.();
    },
    close(code?: number, reason?: string) {
      if (socket.readyState === 3) return;
      socket.closed.push({ code, reason });
      socket.readyState = 3;
      fire('close', code);
    },
    on(event: string, listener: (...args: never[]) => void) {
      listeners = new Map([...listeners, [event, [...(listeners.get(event) ?? []), listener as unknown as Listener]]]);
      return socket;
    },
    say(frame: Record<string, unknown> | string) {
      fire('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame), 'utf8'));
    },
    of: (type: string) => socket.frames.filter((frame) => frame.t === type),
    drop() {
      socket.readyState = 3;
      fire('close', 1006);
    },
  };
  return socket;
}

export const hello = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: 'hello', protocol: 1, kind: 'channel', version: '1.0.0', capabilities: FULL_CAPS, ...over,
});

export type Decl = NonNullable<HubConfig['addons']>[number];
export const CHAT: Decl = { id: 'test-channel', kind: 'channel', name: 'Test chat', owner: OWNER, primary: true };
export const TOOLS: Decl = { id: 'helper-tools', kind: 'tools', name: 'Helper tools' };

export interface KeptNotice { text: string; link: OutboundLink | null; fileId: string | null }

export interface Rig {
  readonly db: Db;
  readonly bus: EventBus;
  readonly clock: Clock & { advance(ms: number): void };
  readonly addons: AddonRegistry;
  readonly host: ChannelHost;
  readonly links: LinkStore;
  readonly outbox: Outbox;
  readonly owner: OwnerChannelFacade;
  readonly dataDir: string;
  /** What went to the website instead of the chat. */
  readonly website: KeptNotice[];
  /** Connects an add-on, says hello (and `up` for a channel unless told not to) and returns its socket. */
  connect(id: string, opts?: { hello?: Record<string, unknown>; up?: boolean }): FakeAddonSocket;
}

export function rig(decls: readonly Decl[] = [CHAT]): Rig {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'luady-addons-')), 'data');
  const db = openMemoryDb();
  const bus = createBus(() => undefined);
  const clock = createFakeClock('2026-11-21T08:00:00.000Z');
  const log = silentLogger();
  const addons = loadAddons({ config: { dataDir, addons: [...decls] }, log });
  const host = createChannelHost({ addons, bus, clock, log });
  const links = createLinkStore(db);
  const outbox = createOutbox({ config: { dataDir }, clock, log });
  const website: KeptNotice[] = [];
  const fallback: WebsiteFallback = {
    keep: async (input) => {
      website.push({ text: input.text, link: input.link, fileId: input.file?.id ?? null });
      return `notice-${website.length}`;
    },
  };
  const owner = createOwnerChannel({ host, addons, links, outbox, bus, clock, log, website: () => fallback });
  return {
    db, bus, clock, addons, host, links, outbox, owner, dataDir, website,
    connect(id, opts = {}) {
      const socket = fakeAddonSocket();
      host.attach(id, socket);
      const decl = decls.find((d) => d.id === id);
      socket.say(opts.hello ?? hello(decl?.kind === 'tools' ? { kind: 'tools', capabilities: undefined } : {}));
      if (decl?.kind === 'channel' && opts.up !== false) socket.say({ t: 'status', state: 'up', detail: null });
      return socket;
    },
  };
}

/** Answers every `send`, `send_file` and `edit` the hub sent so far with an acknowledgement. */
export function ackAll(socket: FakeAddonSocket, prefix = 'out'): void {
  let n = 0;
  for (const frame of socket.frames.filter((f) => ['send', 'send_file', 'edit'].includes(String(f.t)))) {
    n += 1;
    socket.say({ t: 'sent', ref: frame.ref, msgId: `${prefix}-${n}`, error: null });
  }
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export type { HubToAddon };
