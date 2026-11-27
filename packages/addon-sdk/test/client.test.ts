import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ADDON_CLOSE, type HubToAddon } from '@luady/shared';
import { BACKOFF, backoffDelay } from '../src/backoff.js';
import { BUFFER_MAX, createAddonClient, type AddonClient, type AddonClientOptions } from '../src/client.js';

const TOKEN = 'ab'.repeat(32);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const CAPS = {
  text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
  replyQuote: true, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
};

interface FakeHub {
  readonly url: string;
  readonly frames: Array<Record<string, unknown>>;
  readonly headers: Array<string | undefined>;
  next(): Promise<WebSocket>;
  close(): Promise<void>;
}

/** A WebSocket server standing in for the hub: records every frame and the bearer it was offered. */
async function fakeHub(): Promise<FakeHub> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const frames: Array<Record<string, unknown>> = [];
  const headers: Array<string | undefined> = [];
  const waiting: Array<(socket: WebSocket) => void> = [];
  const arrived: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    headers.push(request.headers.authorization);
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    const resolve = waiting.shift();
    if (resolve !== undefined) resolve(socket);
    else arrived.push(socket);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    headers,
    next: () => {
      const ready = arrived.shift();
      return ready !== undefined ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
    },
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let hub: FakeHub | null = null;
let client: AddonClient | null = null;

afterEach(async () => {
  await client?.stop();
  client = null;
  await hub?.close();
  hub = null;
});

function channelClient(url: string, over: Partial<AddonClientOptions> = {}): AddonClient {
  return createAddonClient({
    id: 'echo', token: TOKEN, url, log: silent, initialBackoffMs: 10, maxBackoffMs: 40,
    hello: { kind: 'channel', version: '1.0.0', capabilities: CAPS },
    handlers: {},
    ...over,
  });
}

const types = (frames: ReadonlyArray<Record<string, unknown>>): unknown[] => frames.map((frame) => frame.t);

describe('backoffDelay (the add-on reconnects from 1 to 30 s)', () => {
  it('doubles from 1 s and stays at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 12].map((attempt) => backoffDelay(attempt))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(BACKOFF).toEqual({ initialMs: 1000, maxMs: 30_000 });
  });

  it('treats a negative or fractional attempt as the first', () => {
    expect(backoffDelay(-3)).toBe(1000);
    expect(backoffDelay(0.7)).toBe(1000);
    expect(backoffDelay(2, 10, 40)).toBe(40);
  });
});

describe('the client: hello, buffer and status on every connect', () => {
  it('connects with its token, says hello first and hears the welcome', async () => {
    hub = await fakeHub();
    const onWelcome = vi.fn();
    client = channelClient(hub.url, { handlers: { onWelcome } });
    client.start();
    const socket = await hub.next();
    await vi.waitFor(() => expect(hub?.frames.length).toBe(1));
    expect(hub.headers).toEqual([`Bearer ${TOKEN}`]);
    expect(hub.frames[0]).toEqual({ t: 'hello', protocol: 1, kind: 'channel', version: '1.0.0', capabilities: CAPS });
    const welcome: HubToAddon = { t: 'welcome', protocol: 1, hub: '0.1.0', manager: { name: 'Luady' }, owner: '447700900001' };
    socket.send(JSON.stringify(welcome));
    await vi.waitFor(() => expect(onWelcome).toHaveBeenCalledWith(welcome));
    expect(client.welcome()).toEqual(welcome);
  });

  it('buffers at most 500 frames while the hub is away and drops the oldest, but never a status or hello', () => {
    client = channelClient('ws://127.0.0.1:9');
    for (let i = 0; i < BUFFER_MAX + 3; i += 1) client.incoming({ msgId: `m${i}`, from: 'me', text: `n${i}`, ts: i });
    expect(client.buffered()).toBe(BUFFER_MAX);
    expect(client.status('down', 'no network')).toBe(false);
    expect(client.buffered()).toBe(BUFFER_MAX);
  });

  it('on a reconnect sends hello, then the buffered frames in order, then the last status', async () => {
    hub = await fakeHub();
    // Long enough that the frames below are said while the link is down.
    client = channelClient(hub.url, { initialBackoffMs: 300, maxBackoffMs: 300 });
    client.status('up', null);
    client.incoming({ msgId: 'm1', from: 'me', text: 'one', ts: 1 });
    client.sent('r1', 'out-1', null);
    client.start();
    const first = await hub.next();
    await vi.waitFor(() => expect(hub?.frames.length).toBe(4));
    expect(types(hub.frames)).toEqual(['hello', 'incoming', 'sent', 'status']);
    // The link drops: what is said meanwhile waits, and the next connection gets it in the same order.
    hub.frames.length = 0;
    first.terminate();
    const current = client;
    await vi.waitFor(() => expect(current.isConnected()).toBe(false));
    client.incoming({ msgId: 'm2', from: 'me', text: 'two', ts: 2 });
    client.status('down', 'phone offline');
    await hub.next();
    await vi.waitFor(() => expect(hub?.frames.length).toBe(3));
    expect(types(hub.frames)).toEqual(['hello', 'incoming', 'status']);
    expect(hub.frames[2]).toEqual({ t: 'status', state: 'down', detail: 'phone offline' });
  });

  it('refuses a frame the shared schema refuses, and sends nothing for it', () => {
    client = channelClient('ws://127.0.0.1:9');
    expect(client.incoming({ msgId: '', from: 'me', text: 'x', ts: 1 })).toBe(false);
    expect(client.buffered()).toBe(0);
  });

  it('runs the typed handlers and answers a tool call with its result', async () => {
    hub = await fakeHub();
    const onSend = vi.fn();
    client = channelClient(hub.url, {
      hello: { kind: 'channel', version: '1', capabilities: CAPS, tools: [{ name: 'echo_back', description: 'Echo', input: { type: 'object' } }] },
      handlers: {
        onSend,
        onToolCall: async (call) => ({ ok: true, text: `you said ${String((call.args as { text?: string }).text)}` }),
      },
    });
    client.start();
    const socket = await hub.next();
    socket.send(JSON.stringify({ t: 'send', ref: 'r9', text: 'hi', replyTo: null }));
    socket.send(JSON.stringify({ t: 'tool.call', callId: 'c1', name: 'echo_back', args: { text: 'ping' } }));
    socket.send('{"t":"nonsense"}');
    await vi.waitFor(() => expect(hub?.frames.some((frame) => frame.t === 'tool.result')).toBe(true));
    expect(onSend).toHaveBeenCalledWith({ t: 'send', ref: 'r9', text: 'hi', replyTo: null });
    expect(hub.frames.find((frame) => frame.t === 'tool.result')).toEqual({ t: 'tool.result', callId: 'c1', ok: true, text: 'you said ping' });
  });

  it('a tool handler that throws answers ok: false, never a crash', async () => {
    hub = await fakeHub();
    client = channelClient(hub.url, { handlers: { onToolCall: async () => { throw new Error('bad args'); } } });
    client.start();
    const socket = await hub.next();
    socket.send(JSON.stringify({ t: 'tool.call', callId: 'c2', name: 'echo_back', args: {} }));
    await vi.waitFor(() => expect(hub?.frames.some((frame) => frame.t === 'tool.result')).toBe(true));
    expect(hub.frames.find((frame) => frame.t === 'tool.result')).toEqual({ t: 'tool.result', callId: 'c2', ok: false, text: 'bad args' });
  });

  it('stops for good when the hub says the protocol does not match, or that a newer copy took over', async () => {
    for (const code of [ADDON_CLOSE.protocolMismatch, ADDON_CLOSE.replaced]) {
      hub = await fakeHub();
      const onStopped = vi.fn();
      client = channelClient(hub.url, { handlers: { onStopped } });
      client.start();
      const socket = await hub.next();
      socket.close(code, 'test');
      await vi.waitFor(() => expect(onStopped).toHaveBeenCalledWith(code));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(client.isConnected()).toBe(false);
      await client.stop();
      client = null;
      await hub.close();
      hub = null;
    }
  });
});
