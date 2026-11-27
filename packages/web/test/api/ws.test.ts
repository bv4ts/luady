import type { WsServerMessage } from '@luady/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, createWsClient, wsUrl, type WsClient, type WsStatus } from '../../src/api/ws.js';
import { session } from '../fixtures.js';
import { FakeSocket } from '../helpers/fake-socket.js';

const HELLO = { type: 'hello', now: '2026-10-09T12:00:00.000Z' };
const clients: WsClient[] = [];

function setup() {
  const messages: WsServerMessage[] = [];
  const statuses: Array<{ status: WsStatus; epoch: number }> = [];
  const warnings: string[] = [];
  const client = createWsClient({
    url: 'wss://luady.example/ws',
    createSocket: (url) => new FakeSocket(url),
    random: () => 0.5,
    onMessage: (message) => messages.push(message),
    onStatus: (status, info) => statuses.push({ status, epoch: info.epoch }),
    onWarning: (warning) => warnings.push(warning),
  });
  clients.push(client);
  return { client, messages, statuses, warnings };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
});

afterEach(() => {
  clients.splice(0).forEach((client) => client.stop());
  vi.useRealTimers();
});

describe('createWsClient', () => {
  it('opens /ws, reports open after hello and validates every message', () => {
    const { client, messages, statuses, warnings } = setup();
    client.start();
    const socket = FakeSocket.last();
    expect(socket.url).toBe('wss://luady.example/ws');
    socket.open();
    socket.receive(HELLO);
    expect(client.status()).toBe('open');
    expect(client.epoch()).toBe(1);
    socket.receive({ type: 'session.updated', session: session({ state: 'working' }) });
    socket.receive({ type: 'session.updated', session: { id: 'broken' } });
    socket.receive('not json');
    expect(messages.map((message) => message.type)).toEqual(['hello', 'session.updated']);
    expect(warnings).toHaveLength(2);
    expect(statuses.map((entry) => entry.status)).toEqual(['connecting', 'open']);
  });

  it('drops a frame of a type this bundle does not know, warns once and keeps the socket open (an old tab after a deploy)', () => {
    const { client, messages, warnings } = setup();
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    socket.receive(HELLO);
    socket.receive({ type: 'future.thing', x: 1 });
    expect(messages.map((message) => message.type)).toEqual(['hello']);
    expect(warnings).toHaveLength(1);
    expect(socket.closedWith).toBeNull();
    expect(client.status()).toBe('open');
  });

  it('reconnects with exponential backoff after a server restart and re-sends transcript subscriptions', () => {
    const { client, statuses } = setup();
    client.subscribeTranscript('cedar:cc-meadow-hr:0.0');
    client.start();
    const first = FakeSocket.last();
    first.open();
    first.receive(HELLO);
    expect(first.sentJson()).toContainEqual({ type: 'subscribe.transcript', sessionId: 'cedar:cc-meadow-hr:0.0' });

    first.drop(1012);
    expect(client.status()).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.last().drop(1006);
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    const third = FakeSocket.last();
    third.open();
    third.receive(HELLO);
    expect(third.sentJson()).toContainEqual({ type: 'subscribe.transcript', sessionId: 'cedar:cc-meadow-hr:0.0' });
    expect(client.epoch()).toBe(2);
    expect(statuses.at(-1)).toEqual({ status: 'open', epoch: 2 });

    third.drop(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('stops re-subscribing after the last unsubscribe', () => {
    const { client } = setup();
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    const unsubscribe = client.subscribeTranscript('cedar:cc-a:0.0');
    unsubscribe();
    unsubscribe();
    expect(socket.sentJson()).toEqual([
      { type: 'subscribe.transcript', sessionId: 'cedar:cc-a:0.0' },
      { type: 'unsubscribe.transcript', sessionId: 'cedar:cc-a:0.0' },
    ]);
    socket.drop();
    vi.advanceTimersByTime(1000);
    FakeSocket.last().open();
    expect(FakeSocket.last().sentJson()).toEqual([]);
  });

  it('pings the hub and reconnects when no reply arrives', () => {
    const { client, warnings } = setup();
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    socket.receive(HELLO);
    vi.advanceTimersByTime(25_000);
    expect(socket.sentJson()).toContainEqual({ type: 'ping' });
    vi.advanceTimersByTime(10_000);
    expect(client.status()).toBe('reconnecting');
    expect(socket.closedWith).toBe(4000);
    expect(warnings.some((warning) => /ping/i.test(warning))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('stop() closes the socket and never reconnects', () => {
    const { client } = setup();
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    client.stop();
    expect(socket.closedWith).toBe(1000);
    expect(client.status()).toBe('stopped');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects at once when the browser comes back online', () => {
    const { client } = setup();
    client.start();
    FakeSocket.last().drop();
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.status()).toBe('reconnecting');
  });

  it('stops and reports an expired session on close code 4401', () => {
    const expired = vi.fn();
    const client = createWsClient({
      url: 'wss://luady.example/ws', createSocket: (url) => new FakeSocket(url), random: () => 0.5,
      onMessage: () => undefined, onAuthExpired: expired,
    });
    clients.push(client);
    client.start();
    FakeSocket.last().open();
    FakeSocket.last().drop(4401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(client.status()).toBe('stopped');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('step subscriptions, presence and acknowledgements', () => {
  function connected(now: () => number = () => 0) {
    const messages: WsServerMessage[] = [];
    const client = createWsClient({
      url: 'wss://luady.example/ws', createSocket: (url) => new FakeSocket(url), random: () => 0.5, now,
      onMessage: (message) => messages.push(message),
    });
    clients.push(client);
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    socket.receive(HELLO);
    return { client, socket };
  }

  function reconnect(socket: FakeSocket): FakeSocket {
    socket.drop(1006);
    vi.advanceTimersByTime(1000);
    const next = FakeSocket.last();
    next.open();
    next.receive(HELLO);
    return next;
  }

  it('reference-counts step subscriptions and sends them again after a reconnect', () => {
    const { client, socket } = connected();
    const first = client.subscribeSteps('cedar:a:0.0');
    const second = client.subscribeSteps('cedar:a:0.0');
    expect(socket.sentJson()).toEqual([{ type: 'subscribe.steps', sessionId: 'cedar:a:0.0' }]);
    const next = reconnect(socket);
    expect(next.sentJson()).toEqual([{ type: 'subscribe.steps', sessionId: 'cedar:a:0.0' }]);
    first();
    first();
    expect(next.sentJson()).toHaveLength(1);
    second();
    expect(next.sentJson().at(-1)).toEqual({ type: 'unsubscribe.steps', sessionId: 'cedar:a:0.0' });
    expect(reconnect(next).sentJson()).toEqual([]);
  });

  it('sends the hello at once when open, and the last value first after every reconnect', () => {
    const { client, socket } = connected();
    client.subscribeTranscript('cedar:a:0.0');
    client.subscribeSteps('cedar:a:0.0');
    client.setVisible(true);
    expect(socket.sentJson().at(-1)).toEqual({ type: 'presence.hello', visible: true });
    client.setVisible(false);
    const next = reconnect(socket);
    expect(next.sentJson()[0]).toEqual({ type: 'presence.hello', visible: false });
    expect(next.sentJson()).toContainEqual({ type: 'subscribe.steps', sessionId: 'cedar:a:0.0' });
    expect(next.sentJson()).toContainEqual({ type: 'subscribe.transcript', sessionId: 'cedar:a:0.0' });
  });

  it('remembers visibility set before the socket opens and sends no hello while closed', () => {
    const client = createWsClient({ url: 'wss://x/ws', createSocket: (url) => new FakeSocket(url), onMessage: () => undefined });
    clients.push(client);
    client.setVisible(true);
    client.touch();
    client.ackNotices(['n1']);
    client.start();
    const socket = FakeSocket.last();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sentJson()).toEqual([{ type: 'presence.hello', visible: true }, { type: 'presence.active' }]);
  });

  it('sends presence.active at most once a minute, only from a visible tab', () => {
    let clock = 0;
    const { client, socket } = connected(() => clock);
    const actives = () => socket.sentJson().filter((frame) => (frame as { type: string }).type === 'presence.active').length;
    client.touch();
    expect(actives()).toBe(0);
    client.setVisible(true);
    client.touch();
    clock = 30_000;
    client.touch();
    expect(actives()).toBe(1);
    clock = 61_000;
    client.touch();
    expect(actives()).toBe(2);
    clock = 200_000;
    client.setVisible(false);
    client.touch();
    expect(actives()).toBe(2);
  });

  it('owes a touch made while disconnected to the next visible hello, never to a hidden one', () => {
    let clock = 0;
    const { client, socket } = connected(() => clock);
    client.setVisible(true);
    socket.drop(1006);
    clock = 100_000;
    client.touch();
    vi.advanceTimersByTime(1000);
    const next = FakeSocket.last();
    next.open();
    expect(next.sentJson()).toEqual([{ type: 'presence.hello', visible: true }, { type: 'presence.active' }]);
    next.drop(1006);
    clock = 300_000;
    client.touch();
    client.setVisible(false);
    vi.advanceTimersByTime(2000);
    FakeSocket.last().open();
    expect(FakeSocket.last().sentJson()).toEqual([{ type: 'presence.hello', visible: false }]);
  });

  it('acknowledges in chunks of at most fifty ids, skipping empty and oversized ones', () => {
    const { client, socket } = connected();
    const ids = Array.from({ length: 120 }, (_, i) => `n${i}`);
    client.ackNotices([...ids, '', 'x'.repeat(65), 'n1']);
    const frames = socket.sentJson() as Array<{ type: string; ids: string[] }>;
    expect(frames.map((frame) => frame.ids.length)).toEqual([50, 50, 20]);
    expect(frames.flatMap((frame) => frame.ids)).toEqual(ids);
    client.ackNotices([]);
    expect(socket.sentJson()).toHaveLength(3);
  });

  it('sends nothing and throws nothing while the socket is closed', () => {
    const { client, socket } = connected();
    socket.drop(1006);
    expect(() => {
      client.subscribeSteps('cedar:a:0.0')();
      client.setVisible(true);
      client.touch();
      client.ackNotices(['n1']);
    }).not.toThrow();
    expect(socket.sentJson()).toEqual([]);
  });
});

describe('ws helpers', () => {
  it('backoffDelay doubles from 1 s up to 30 s with ±20% jitter', () => {
    const middle = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, 1000, 30_000, middle)))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(1, 1000, 30_000, () => 0)).toBe(800);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
  });

  it('wsUrl follows the page protocol', () => {
    expect(wsUrl('/ws', { protocol: 'https:', host: 'luady.example.com' })).toBe('wss://luady.example.com/ws');
    expect(wsUrl('/ws', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
  });
});
