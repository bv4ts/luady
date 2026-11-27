import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PAGE_KEY_HEADER, PAGE_KEY_STORAGE, type WsServerMessage } from '@luady/shared';
import { createHttp, type FetchLike } from '../../src/api/http.js';
import { createWsClient, type WsClient } from '../../src/api/ws.js';
import { clearPageKey, keepPageKey, readPageKey } from '../../src/auth/page-key.js';
import { FakeSocket } from '../helpers/fake-socket.js';

const KEY = 'k'.repeat(43);
const Ok = z.object({ ok: z.literal(true) });
const HELLO = { type: 'hello', now: '2026-11-21T08:00:00.000Z' };
const ROOMS = { type: 'rooms.changed', rooms: [], at: '2026-11-21T08:00:00.000Z' } as const;

function recordingFetch() {
  const headers: Array<Record<string, string>> = [];
  const fetch: FetchLike = vi.fn(async (_url: string, init: RequestInit) => {
    headers.push({ ...(init.headers as Record<string, string>) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch, headers };
}

afterEach(() => {
  clearPageKey();
});

describe('the page key', () => {
  it('is kept from a sign-in answer in localStorage, and an older hub that sends none leaves it unset', () => {
    keepPageKey({});
    expect(readPageKey()).toBeNull();
    keepPageKey({ pageKey: KEY });
    expect(localStorage.getItem(PAGE_KEY_STORAGE)).toBe(KEY);
    expect(readPageKey()).toBe(KEY);
  });

  it('http.ts sends x-hub-key on every request, GET included, once a key is stored, and none before', async () => {
    const { fetch, headers } = recordingFetch();
    const http = createHttp({ fetch });
    await http.request('GET', '/api/me', Ok);
    keepPageKey({ pageKey: KEY });
    await http.request('GET', '/api/me', Ok);
    await http.request('POST', '/api/sessions', Ok, {});
    expect(headers[0]?.[PAGE_KEY_HEADER]).toBeUndefined();
    expect(headers[1]?.[PAGE_KEY_HEADER]).toBe(KEY);
    expect(headers[2]?.[PAGE_KEY_HEADER]).toBe(KEY);
  });
});

describe('the live socket', () => {
  const clients: WsClient[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.reset();
  });

  afterEach(() => {
    clients.splice(0).forEach((client) => client.stop());
    vi.useRealTimers();
  });

  function setup() {
    const messages: WsServerMessage[] = [];
    const client = createWsClient({
      url: 'wss://hub.example/ws', createSocket: (url) => new FakeSocket(url), random: () => 0.5,
      onMessage: (message) => messages.push(message),
    });
    clients.push(client);
    return { client, messages };
  }

  it('sends auth with the stored key as the very first message, then the presence hello', () => {
    keepPageKey({ pageKey: KEY });
    const { client } = setup();
    client.setVisible(true);
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    expect(socket.sentJson().slice(0, 2)).toEqual([{ type: 'auth', key: KEY }, { type: 'presence.hello', visible: true }]);
  });

  it('sends no auth while no key is stored (an older hub)', () => {
    const { client } = setup();
    client.start();
    FakeSocket.last().open();
    expect(FakeSocket.last().sentJson().some((frame) => (frame as { type: string }).type === 'auth')).toBe(false);
  });

  it('subscribeHost and unsubscribeHost count references, and the subscriptions come back after a reconnect', () => {
    const { client } = setup();
    client.start();
    const first = FakeSocket.last();
    first.open();
    first.receive(HELLO);
    client.subscribeHost('mars');
    client.subscribeHost('mars');
    expect(first.sentJson().filter((f) => (f as { type: string }).type === 'subscribe.host')).toEqual([{ type: 'subscribe.host', host: 'mars' }]);
    client.unsubscribeHost('mars');
    expect(first.sentJson().some((f) => (f as { type: string }).type === 'unsubscribe.host')).toBe(false);
    first.close(1006);
    vi.advanceTimersByTime(2_000);
    const second = FakeSocket.last();
    second.open();
    expect(second.sentJson()).toContainEqual({ type: 'subscribe.host', host: 'mars' });
    client.unsubscribeHost('mars');
    expect(second.sentJson()).toContainEqual({ type: 'unsubscribe.host', host: 'mars' });
  });

  it('on(type) hands every message of that type to its listener until released', () => {
    const { client, messages } = setup();
    const rooms: unknown[] = [];
    const off = client.on('rooms.changed', (message) => rooms.push(message.rooms));
    client.start();
    const socket = FakeSocket.last();
    socket.open();
    socket.receive(HELLO);
    socket.receive(ROOMS);
    off();
    socket.receive(ROOMS);
    expect(rooms).toEqual([[]]);
    expect(messages.filter((message) => message.type === 'rooms.changed')).toHaveLength(2);
  });
});
