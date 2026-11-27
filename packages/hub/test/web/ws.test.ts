import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, WsServerMessageSchema } from '@luady/shared';
import { createSessionStore, SESSION_IDLE_MS } from '../../src/web/auth/sessions.js';
import {
  harnessFactory,
  ISO,
  LUADY_STATUS,
  sampleAction,
  sampleActivity,
  sampleDetail,
  sampleChat,
  sampleItem,
  sampleNotice,
  sampleQuestion,
  sampleServer,
  sampleSession,
  SESSION_ID,
  PRESENCE_AWAY,
} from './helpers.js';
import { connectWs, listen, rejectedStatus, sleep, wsHeaders } from './ws-helpers.js';

const harness = harnessFactory();
const FAST = { wsSessionCheckMs: 50, transcriptDebounceMs: 20, transcriptPollMs: 60_000 };
const HELLO = { type: 'hello', now: ISO };

async function setup() {
  const h = await harness({}, FAST);
  const base = await listen(h);
  return { h, url: `${base}/ws`, session: h.login() };
}

describe('/ws authentication', () => {
  it('rejects an upgrade without an Access JWT with 403', async () => {
    const { h, url, session } = await setup();
    expect(await rejectedStatus(url, wsHeaders(h, session, { token: null }))).toBe(403);
  });

  it('rejects an upgrade without an app session with 401', async () => {
    const { h, url } = await setup();
    expect(await rejectedStatus(url, wsHeaders(h))).toBe(401);
  });

  it('rejects an upgrade from a foreign Origin with 403', async () => {
    const { h, url, session } = await setup();
    expect(await rejectedStatus(url, wsHeaders(h, session, { origin: 'https://evil.example' }))).toBe(403);
  });
});

describe('/ws messages', () => {
  it('sends hello on connect and answers ping with hello', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    expect(await probe.next()).toEqual(HELLO);
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await probe.next()).toEqual(HELLO);
    probe.ws.close();
  });

  it('fans out every website-facing bus event to all connected clients', async () => {
    const { h, url, session } = await setup();
    const clients = [await connectWs(url, wsHeaders(h, session)), await connectWs(url, wsHeaders(h, session))];
    for (const client of clients) await client.next();
    const bus = h.deps.bus;
    bus.emit('server.updated', sampleServer());
    bus.emit('session.updated', sampleSession());
    bus.emit('session.removed', { id: SESSION_ID });
    bus.emit('question.updated', sampleQuestion());
    bus.emit('action.updated', sampleAction());
    bus.emit('manager.message', sampleChat());
    bus.emit('manager.status', LUADY_STATUS);
    const expected = [
      { type: 'server.updated', server: sampleServer() },
      { type: 'session.updated', session: sampleSession() },
      { type: 'session.removed', id: SESSION_ID },
      { type: 'question.updated', question: sampleQuestion() },
      { type: 'action.updated', action: sampleAction() },
      { type: 'manager.message', message: sampleChat() },
      { type: 'manager.status', status: LUADY_STATUS },
    ];
    for (const client of clients) {
      const received = await client.take(expected.length);
      expect(received).toEqual(expected);
      expect(received.every((message) => WsServerMessageSchema.safeParse(message).success)).toBe(true);
      client.ws.close();
    }
  });

  it('does not forward bus events that have no WebSocket message', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    h.deps.bus.emit('settings.updated', DEFAULT_SETTINGS);
    h.deps.bus.emit('turn.finished', {
      session: sampleSession(),
      durationSec: 130,
      remote: false,
      lastMessage: 'done',
      replay: false,
    });
    h.deps.bus.emit('meters.updated', { host: 'cedar', sessionId: SESSION_ID, fiveHour: null, sevenDay: null, at: ISO });
    h.deps.bus.emit('steps.appended', { sessionId: SESSION_ID, steps: sampleDetail().steps, todos: null, helpers: null });
    h.deps.bus.emit('manager.status', LUADY_STATUS);
    expect(await probe.next()).toEqual({ type: 'manager.status', status: LUADY_STATUS });
    probe.ws.close();
  });

  it('closes with 1008 on an invalid client message', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'subscribe.transcript' }));
    expect((await probe.closed).code).toBe(1008);
  });

  it.each([
    [{ type: 'subscribe.steps', sessionId: SESSION_ID }],
    [{ type: 'unsubscribe.steps', sessionId: SESSION_ID }],
    [{ type: 'presence.hello', visible: true }],
    [{ type: 'presence.active' }],
    [{ type: 'notice.ack', ids: ['n_01'] }],
  ])('keeps the socket open on the client message %j', async (message) => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify(message));
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    const closedEarly = probe.closed.then(({ code }) => ({ type: 'closed', code }));
    expect(await Promise.race([probe.next(), closedEarly])).toEqual(HELLO);
    expect(probe.ws.readyState).toBe(probe.ws.OPEN);
    probe.ws.close();
  });

  it('closes with 4401 once the app session expires', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    h.clock.advance(SESSION_IDLE_MS);
    expect((await probe.closed).code).toBe(4401);
  });
});

describe('/ws transcript subscriptions', () => {
  it('delivers transcript.appended only to subscribers, diffed by uuid', async () => {
    const { h, url, session } = await setup();
    const transcript = vi.mocked(h.deps.sessions.transcript);
    transcript.mockResolvedValue({ items: [sampleItem('u1')], nextCursor: null });
    const subscriber = await connectWs(url, wsHeaders(h, session));
    const bystander = await connectWs(url, wsHeaders(h, session));
    await subscriber.next();
    await bystander.next();
    subscriber.ws.send(JSON.stringify({ type: 'subscribe.transcript', sessionId: SESSION_ID }));
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledTimes(1));
    await sleep(30);
    transcript.mockResolvedValue({ items: [sampleItem('u1'), sampleItem('u2')], nextCursor: null });
    h.deps.bus.emit('session.updated', sampleSession());
    const received = await subscriber.until('transcript.appended');
    expect(received.at(-1)).toEqual({ type: 'transcript.appended', sessionId: SESSION_ID, items: [sampleItem('u2')] });
    h.deps.bus.emit('manager.status', LUADY_STATUS);
    const seen = await bystander.until('manager.status');
    expect(seen.map((message) => message.type)).toEqual(['session.updated', 'manager.status']);
    subscriber.ws.close();
    bystander.ws.close();
  });

  it('forwards bus transcript.appended through the same uuid diff', async () => {
    const { h, url, session } = await setup();
    const transcript = vi.mocked(h.deps.sessions.transcript);
    transcript.mockResolvedValue({ items: [sampleItem('u1')], nextCursor: null });
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'subscribe.transcript', sessionId: SESSION_ID }));
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledTimes(1));
    await sleep(30);
    h.deps.bus.emit('transcript.appended', { sessionId: SESSION_ID, items: [sampleItem('u1'), sampleItem('u5')] });
    expect(await probe.next()).toEqual({ type: 'transcript.appended', sessionId: SESSION_ID, items: [sampleItem('u5')] });
    probe.ws.close();
  });

  it('keeps a transcript subscription when the same session is unsubscribed from steps', async () => {
    const { h, url, session } = await setup();
    const transcript = vi.mocked(h.deps.sessions.transcript);
    transcript.mockResolvedValue({ items: [sampleItem('u1')], nextCursor: null });
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'subscribe.transcript', sessionId: SESSION_ID }));
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledTimes(1));
    await sleep(30);
    probe.ws.send(JSON.stringify({ type: 'unsubscribe.steps', sessionId: SESSION_ID }));
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await probe.next()).toEqual(HELLO);
    h.deps.bus.emit('transcript.appended', { sessionId: SESSION_ID, items: [sampleItem('u5')] });
    h.deps.bus.emit('manager.status', LUADY_STATUS);
    const seen = await probe.until('manager.status');
    expect(seen.map((message) => message.type)).toEqual(['transcript.appended', 'manager.status']);
    probe.ws.close();
  });

  it('ignores subscriptions to unknown sessions', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'subscribe.transcript', sessionId: 'cedar:cc-unknown:0.0' }));
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await probe.next()).toEqual(HELLO);
    expect(h.deps.sessions.transcript).not.toHaveBeenCalled();
    probe.ws.close();
  });
});

describe('/ws activity', () => {
  const STEPS = { sessionId: SESSION_ID, steps: sampleDetail().steps, todos: null, helpers: null };

  async function subscribed(h: Awaited<ReturnType<typeof setup>>['h'], url: string, session: Awaited<ReturnType<typeof setup>>['session']) {
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    return probe;
  }

  /** A ping answered means every earlier client message was handled. */
  async function barrier(probe: Awaited<ReturnType<typeof connectWs>>): Promise<void> {
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await probe.next()).toEqual(HELLO);
  }

  it('every connected client receives activity.updated', async () => {
    const { h, url, session } = await setup();
    const clients = [await subscribed(h, url, session), await subscribed(h, url, session)];
    h.deps.bus.emit('activity.updated', { items: [sampleActivity()] });
    for (const client of clients) {
      const message = await client.next();
      expect(message).toEqual({ type: 'activity.updated', items: [sampleActivity()] });
      expect(WsServerMessageSchema.safeParse(message).success).toBe(true);
      client.ws.close();
    }
  });

  it('steps.appended reaches only the client subscribed to that session', async () => {
    const { h, url, session } = await setup();
    const watcher = await subscribed(h, url, session);
    const bystander = await subscribed(h, url, session);
    watcher.ws.send(JSON.stringify({ type: 'subscribe.steps', sessionId: SESSION_ID }));
    await barrier(watcher);
    expect(h.deps.activity.watch).toHaveBeenCalledWith(SESSION_ID);
    h.deps.bus.emit('steps.appended', STEPS);
    h.deps.bus.emit('manager.status', LUADY_STATUS);
    const received = await watcher.until('manager.status');
    expect(received[0]).toEqual({ type: 'steps.appended', ...STEPS });
    expect(WsServerMessageSchema.safeParse(received[0]).success).toBe(true);
    expect((await bystander.until('manager.status')).map((message) => message.type)).toEqual(['manager.status']);
    watcher.ws.close();
    bystander.ws.close();
  });

  it('subscribing twice then unsubscribing once watches once and unwatches once; no more steps after that', async () => {
    const { h, url, session } = await setup();
    const probe = await subscribed(h, url, session);
    probe.ws.send(JSON.stringify({ type: 'subscribe.steps', sessionId: SESSION_ID }));
    probe.ws.send(JSON.stringify({ type: 'subscribe.steps', sessionId: SESSION_ID }));
    probe.ws.send(JSON.stringify({ type: 'unsubscribe.steps', sessionId: SESSION_ID }));
    await barrier(probe);
    expect(h.deps.activity.watch).toHaveBeenCalledTimes(1);
    expect(h.deps.activity.unwatch).toHaveBeenCalledTimes(1);
    h.deps.bus.emit('steps.appended', STEPS);
    h.deps.bus.emit('manager.status', LUADY_STATUS);
    expect((await probe.until('manager.status')).map((message) => message.type)).toEqual(['manager.status']);
    probe.ws.close();
  });

  it('closing the socket releases its step subscriptions', async () => {
    const { h, url, session } = await setup();
    const probe = await subscribed(h, url, session);
    probe.ws.send(JSON.stringify({ type: 'subscribe.steps', sessionId: SESSION_ID }));
    await barrier(probe);
    probe.ws.close();
    await probe.closed;
    await vi.waitFor(() => expect(h.deps.activity.unwatch).toHaveBeenCalledWith(SESSION_ID));
    expect(h.deps.activity.unwatch).toHaveBeenCalledTimes(1);
  });

  it('subscribe.steps for an unknown session is ignored and the socket stays open', async () => {
    const { h, url, session } = await setup();
    const probe = await subscribed(h, url, session);
    probe.ws.send(JSON.stringify({ type: 'subscribe.steps', sessionId: 'cedar:cc-unknown:0.0' }));
    probe.ws.send(JSON.stringify({ type: 'unsubscribe.steps', sessionId: 'cedar:cc-unknown:0.0' }));
    await barrier(probe);
    expect(h.deps.activity.watch).not.toHaveBeenCalled();
    expect(h.deps.activity.unwatch).not.toHaveBeenCalled();
    expect(probe.ws.readyState).toBe(probe.ws.OPEN);
    probe.ws.close();
  });
});


describe('/ws presence and notices', () => {
  const lastSeen = (h: Awaited<ReturnType<typeof setup>>['h'], sid: string): string | undefined =>
    createSessionStore({ db: h.deps.db, clock: h.clock }).peek(sid)?.lastSeenAt;

  it('each socket is one presence client: connect on open, disconnect with the same id on close', async () => {
    const { h, url, session } = await setup();
    const first = await connectWs(url, wsHeaders(h, session));
    const second = await connectWs(url, wsHeaders(h, session));
    await first.next();
    await second.next();
    const connect = vi.mocked(h.deps.presence.connect);
    expect(connect).toHaveBeenCalledTimes(2);
    const [firstId, secondId] = connect.mock.calls.map((args) => args[0]);
    expect(firstId).not.toBe(secondId);
    expect(connect.mock.calls.map((args) => args[1])).toEqual([session.sid, session.sid]);
    first.ws.close();
    await vi.waitFor(() => expect(h.deps.presence.disconnect).toHaveBeenCalledWith(firstId));
    expect(h.deps.presence.disconnect).not.toHaveBeenCalledWith(secondId);
    second.ws.close();
    await vi.waitFor(() => expect(h.deps.presence.disconnect).toHaveBeenCalledWith(secondId));
  });

  it('only presence.active keeps the app session alive; hello, ack and ping are automatic and do not', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    const id = vi.mocked(h.deps.presence.connect).mock.calls[0]?.[0];
    expect(lastSeen(h, session.sid)).toBe(ISO);
    h.clock.advance(10 * 60_000);
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    await probe.next();
    expect(h.deps.presence.seen).toHaveBeenCalledWith(id);
    probe.ws.send(JSON.stringify({ type: 'presence.hello', visible: true }));
    await vi.waitFor(() => expect(h.deps.presence.hello).toHaveBeenCalledWith(id, true));
    probe.ws.send(JSON.stringify({ type: 'notice.ack', ids: ['n_01', 'n_02'] }));
    await vi.waitFor(() => expect(h.deps.notices.ack).toHaveBeenCalledWith(['n_01', 'n_02']));
    expect(lastSeen(h, session.sid)).toBe(ISO);
    h.clock.advance(10 * 60_000);
    probe.ws.send(JSON.stringify({ type: 'presence.active' }));
    await vi.waitFor(() => expect(h.deps.presence.active).toHaveBeenCalledWith(id));
    expect(lastSeen(h, session.sid)).toBe('2026-10-09T12:20:00.000Z');
    probe.ws.close();
  });

  it('an acknowledgement from a tab whose last hello said hidden is ignored', async () => {
    const { h, url, session } = await setup();
    vi.mocked(h.deps.presence.canAck).mockReturnValue(false);
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'presence.hello', visible: false }));
    probe.ws.send(JSON.stringify({ type: 'notice.ack', ids: ['n_01'] }));
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    await probe.next();
    expect(h.deps.presence.canAck).toHaveBeenCalled();
    expect(h.deps.notices.ack).not.toHaveBeenCalled();
    probe.ws.close();
  });

  it('an acknowledgement with more than 50 ids closes the socket with 1008', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    await probe.next();
    probe.ws.send(JSON.stringify({ type: 'notice.ack', ids: Array.from({ length: 51 }, (_, i) => `n_${i}`) }));
    expect((await probe.closed).code).toBe(1008);
    expect(h.deps.notices.ack).not.toHaveBeenCalled();
  });

  it('forwards accounts.changed to every client', async () => {
    const { h, url, session } = await setup();
    const client = await connectWs(url, wsHeaders(h, session));
    await client.next();
    h.deps.bus.emit('accounts.changed', { at: ISO });
    const [message] = await client.take(1);
    expect(message).toEqual({ type: 'accounts.changed', at: ISO });
    expect(WsServerMessageSchema.safeParse(message).success).toBe(true);
    client.ws.close();
  });

  it('forwards notice.created, notice.updated and presence.updated to every client, never notice.delivered', async () => {
    const { h, url, session } = await setup();
    const clients = [await connectWs(url, wsHeaders(h, session)), await connectWs(url, wsHeaders(h, session))];
    for (const client of clients) await client.next();
    const notice = sampleNotice();
    h.deps.bus.emit('notice.delivered', { notice, msgId: 'wamid.1' });
    h.deps.bus.emit('notice.created', notice);
    h.deps.bus.emit('notice.updated', { ...notice, settledVia: 'web', settledAt: ISO });
    h.deps.bus.emit('presence.updated', PRESENCE_AWAY);
    const expected = [
      { type: 'notice.created', notice },
      { type: 'notice.updated', notice: { ...notice, settledVia: 'web', settledAt: ISO } },
      { type: 'presence.updated', presence: PRESENCE_AWAY },
    ];
    for (const client of clients) {
      const received = await client.take(expected.length);
      expect(received).toEqual(expected);
      for (const message of received) expect(WsServerMessageSchema.safeParse(message).success).toBe(true);
      client.ws.close();
    }
  });
});
