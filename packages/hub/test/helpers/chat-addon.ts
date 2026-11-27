import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {} from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Capabilities } from '@luady/shared';
import type { EventBus } from '../../src/core/contracts.js';

/**
 * A chat add-on for the tests of the composed app, connected the way every add-on connects: declared in the config,
 * with its own token, over the hub's add-on route (`/internal/addon/<id>`), in process through `injectWS`.
 */
export const TEST_CHAT_ID = 'test-chat';

/** The config entry of the test chat: a channel, the primary one, whose owner is `owner`. */
export function testChatDecl(owner: string) {
  return { id: TEST_CHAT_ID, kind: 'channel', name: 'Test chat', owner, primary: true } as const;
}

/** Every capability, so a test sees every frame the hub can send. */
export const ALL_CAPS: Capabilities = {
  text: true, files: true, edit: true, pin: true, revoke: true, typing: true, played: true, profile: true,
  replyQuote: true, voiceNotes: true, maxText: 4000, maxFileBytes: 50_000_000,
};

export interface ChatAddon {
  /** Every frame the hub sent, in order. */
  readonly frames: Array<Record<string, unknown>>;
  /** Sends one frame to the hub, as the add-on. */
  receive(frame: object): void;
  close(): void;
}

interface Hub {
  readonly internal: FastifyInstance;
  readonly services: { readonly bus: EventBus };
}

/** How a test chat behaves: what it says in `hello`, and whether it acknowledges each `send` as a real chat does. */
export interface TestChatOptions {
  readonly id?: string;
  readonly capabilities?: Capabilities;
  /** More fields of `hello` (a panel, tools). */
  readonly hello?: Record<string, unknown>;
  /** Answers every `send` with `sent` and a message id of its own. */
  readonly autoAck?: boolean;
}

/** Connects the add-on `id` with the token the hub wrote for it in `<dataDir>/addons/<id>.token`. */
export async function connectAddon(hub: Hub, dataDir: string, id = TEST_CHAT_ID, autoAck = false): Promise<ChatAddon> {
  const token = readFileSync(join(dataDir, 'addons', `${id}.token`), 'utf8').trim();
  await hub.internal.ready();
  const ws = await hub.internal.injectWS(`/internal/addon/${id}`, { headers: { authorization: `Bearer ${token}` } });
  const frames: Array<Record<string, unknown>> = [];
  const receive = (frame: object): void => ws.send(JSON.stringify(frame));
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    frames.push(frame);
    if (autoAck && frame.t === 'send') receive({ t: 'sent', ref: frame.ref, msgId: `chat-${frames.length}`, error: null });
  });
  return { frames, receive, close: () => ws.close() };
}

/**
 * Connects the test chat, says `hello` and `status: up`, and resolves once the hub has the channel up, so what the test
 * sends next goes to the chat.
 */
export async function openTestChat(hub: Hub, dataDir: string, opts: TestChatOptions = {}): Promise<ChatAddon> {
  const id = opts.id ?? TEST_CHAT_ID;
  const addon = await connectAddon(hub, dataDir, id, opts.autoAck === true);
  const up = new Promise<void>((resolve) => {
    const off = hub.services.bus.on('channel.status', ({ channel }) => {
      if (channel.id !== id || channel.state !== 'up') return;
      off();
      resolve();
    });
  });
  const capabilities = opts.capabilities ?? ALL_CAPS;
  addon.receive({ t: 'hello', protocol: 1, kind: 'channel', version: '1', capabilities, ...opts.hello });
  addon.receive({ t: 'status', state: 'up', detail: null });
  await up;
  return addon;
}
