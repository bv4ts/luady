import type { Capabilities, PanelSpec } from '@luady/shared';
import { createAddonClient, type AddonClient, type AddonClientOptions, type AddonLogger } from '../client.js';

/**
 * The example add-on: a channel that is a terminal. What the owner types goes to the hub as their message; what the
 * hub sends comes back as text. It also offers the manager one tool, `echo_back`, and a panel with one button.
 * It is small on purpose: copy it to start your own add-on. The tests use it as their stand-in channel.
 */
export const ECHO_CAPABILITIES: Capabilities = {
  text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
  replyQuote: true, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
};

export const ECHO_PANEL: PanelSpec = {
  title: 'Echo',
  blocks: [
    { type: 'text', text: 'The example add-on: messages typed in its terminal reach the hub, and its answers are printed there.' },
    { type: 'button', id: 'ping', label: 'Ping', action: 'ping' },
  ],
};

export const ECHO_TOOL = {
  name: 'echo_back',
  description: 'Answers with the text it was given. An example of an add-on tool.',
  input: { type: 'object', properties: { text: { type: 'string', maxLength: 1000 } }, required: ['text'], additionalProperties: false },
} as const;

/** What the hub sent to this channel, in order. */
export interface EchoOut {
  readonly kind: 'send' | 'typing' | 'unlink';
  readonly text: string | null;
  readonly replyTo: string | null;
  readonly msgId: string | null;
}

export interface EchoAddon {
  readonly client: AddonClient;
  start(): void;
  stop(): Promise<void>;
  /** The owner writes a message (from the owner the hub named in its welcome). Its id, or null before the welcome. */
  say(text: string, replyTo?: string): string | null;
  outbox(): readonly EchoOut[];
}

export interface EchoOptions extends Pick<AddonClientOptions, 'id' | 'token' | 'socketPath' | 'url' | 'initialBackoffMs' | 'maxBackoffMs'> {
  readonly log?: AddonLogger;
  /** Called with every text the hub sends (the terminal prints it). */
  readonly onText?: (text: string) => void;
  readonly now?: () => number;
}

/** The `echo_back` tool validates its own arguments, as every add-on tool must (the hub checks only their size). */
function echoBack(args: unknown): { ok: boolean; text: string } {
  const text = typeof args === 'object' && args !== null ? (args as { text?: unknown }).text : undefined;
  if (typeof text !== 'string' || text.length > 1000) return { ok: false, text: 'echo_back needs { text } of at most 1000 characters' };
  return { ok: true, text };
}

export function createEchoAddon(opts: EchoOptions): EchoAddon {
  const now = opts.now ?? Date.now;
  let outbox: readonly EchoOut[] = [];
  let said = 0;
  let sent = 0;
  const record = (item: EchoOut): void => {
    outbox = [...outbox, item];
  };

  const client = createAddonClient({
    id: opts.id, token: opts.token,
    ...(opts.socketPath === undefined ? {} : { socketPath: opts.socketPath }),
    ...(opts.url === undefined ? {} : { url: opts.url }),
    ...(opts.initialBackoffMs === undefined ? {} : { initialBackoffMs: opts.initialBackoffMs }),
    ...(opts.maxBackoffMs === undefined ? {} : { maxBackoffMs: opts.maxBackoffMs }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
    hello: { kind: 'channel', version: '1.0.0', capabilities: ECHO_CAPABILITIES, panel: ECHO_PANEL, tools: [ECHO_TOOL],
      brainNotes: 'The echo add-on is an example channel: the owner types in a terminal.' },
    handlers: {
      onConnected: () => {
        client.status('up', null);
      },
      onSend: (frame) => {
        sent += 1;
        const msgId = `echo-out-${sent}`;
        record({ kind: 'send', text: frame.text, replyTo: frame.replyTo, msgId });
        opts.onText?.(frame.text);
        client.sent(frame.ref, msgId, null);
      },
      onTyping: (frame) => record({ kind: 'typing', text: null, replyTo: null, msgId: frame.on ? 'on' : 'off' }),
      onUnlink: () => {
        record({ kind: 'unlink', text: null, replyTo: null, msgId: null });
        client.status('unlinked', 'Unlinked from the website');
      },
      onUiAction: (frame) => {
        if (frame.action === 'ping') client.status('up', 'Pong');
      },
      onToolCall: (call) => (call.name === ECHO_TOOL.name ? echoBack(call.args) : { ok: false, text: `No tool ${call.name}` }),
    },
  });

  return {
    client,
    start: () => client.start(),
    stop: () => client.stop(),
    say(text, replyTo) {
      const owner = client.welcome()?.owner ?? null;
      if (owner === null) return null;
      said += 1;
      const msgId = `echo-in-${said}`;
      client.incoming({
        msgId, from: owner, text, ts: Math.floor(now() / 1000),
        ...(replyTo === undefined ? {} : { replyTo: { msgId: replyTo } }),
      });
      return msgId;
    },
    outbox: () => outbox,
  };
}
