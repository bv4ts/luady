import type { RawData, WebSocket } from 'ws';
import { WsClientMessageSchema, type TranscriptItemDTO, type WsClientMessage, type WsServerMessage } from '@luady/shared';
import type { EventBus } from '../core/contracts.js';
import { newId } from '../core/ids.js';
import { isoNow } from '../core/time.js';
import type { RouteModule, WebContext } from './context.js';
import { createTranscriptWatcher, DEFAULT_REMEMBERED_UUIDS, type TranscriptWatcher } from './transcript-watcher.js';
import { parseJsonMessage, sendJson, sendText, sessionStillLive } from './ws-common.js';

/** 4401: the session ended, or the socket did not prove its page key. */
export const WS_CLOSE = { badMessage: 1008, sessionExpired: 4401 } as const;

/** The bus events every authenticated /ws client receives. Returns the unsubscribe functions. */
export function fanOut(bus: EventBus, broadcast: (message: WsServerMessage) => void): Array<() => void> {
  return [
    bus.on('server.updated', (server) => broadcast({ type: 'server.updated', server })),
    bus.on('session.updated', (session) => broadcast({ type: 'session.updated', session })),
    bus.on('session.removed', ({ id }) => broadcast({ type: 'session.removed', id })),
    bus.on('question.updated', (question) => broadcast({ type: 'question.updated', question })),
    bus.on('action.updated', (action) => broadcast({ type: 'action.updated', action })),
    bus.on('manager.message', (message) => broadcast({ type: 'manager.message', message })),
    bus.on('manager.status', (status) => broadcast({ type: 'manager.status', status })),
    bus.on('activity.updated', ({ items }) => broadcast({ type: 'activity.updated', items })),
    bus.on('notice.created', (notice) => broadcast({ type: 'notice.created', notice })),
    bus.on('notice.updated', (notice) => broadcast({ type: 'notice.updated', notice })),
    bus.on('presence.updated', (presence) => broadcast({ type: 'presence.updated', presence })),
    bus.on('accounts.changed', ({ at }) => broadcast({ type: 'accounts.changed', at })),
    bus.on('board.updated', ({ items }) => broadcast({ type: 'board.updated', items })),
    bus.on('board.removed', ({ ids }) => broadcast({ type: 'board.removed', ids })),
    bus.on('mission.updated', (mission) => broadcast({ type: 'mission.updated', mission })),
    bus.on('mission.removed', (removed) => broadcast({ type: 'mission.removed', ...removed })),
    bus.on('session.said', (said) => broadcast({ type: 'session.said', ...said })),
    bus.on('notes.changed', ({ at }) => broadcast({ type: 'notes.changed', at })),
    bus.on('kb.changed', ({ at }) => broadcast({ type: 'kb.changed', at })),
    bus.on('library.changed', ({ at }) => broadcast({ type: 'library.changed', at })),
    bus.on('jira.changed', ({ room, at }) => broadcast({ type: 'jira.changed', room, at })),
    bus.on('schedules.changed', ({ at }) => broadcast({ type: 'schedules.changed', at })),
    bus.on('links.changed', ({ at }) => broadcast({ type: 'links.changed', at })),
    bus.on('prefs.changed', ({ at }) => broadcast({ type: 'prefs.changed', at })),
    // Rooms, hosts, host jobs, channels and the first run; `host.log` goes to subscribers only.
    bus.on('rooms.changed', ({ rooms, at }) => broadcast({ type: 'rooms.changed', rooms, at })),
    bus.on('hosts.changed', ({ hosts, at }) => broadcast({ type: 'hosts.changed', hosts, at })),
    bus.on('host.job', (job) => broadcast({ type: 'host.job', ...job })),
    bus.on('channel.status', ({ channel }) => broadcast({ type: 'channel.status', channel })),
    bus.on('setup.changed', ({ state }) => broadcast({ type: 'setup.changed', state })),
  ];
}

interface WsClient {
  readonly socket: WebSocket;
  readonly sid: string;
  /** This socket as a presence client (notices/presence.ts). */
  readonly clientId: string;
  readonly subs: ReadonlySet<string>;
  /** Sessions whose step stream this client follows (`subscribe.steps`). */
  readonly stepSubs: ReadonlySet<string>;
  /** Hosts whose job log this client follows (`subscribe.host`). */
  readonly hostSubs: ReadonlySet<string>;
  /**
   * False until the socket's `auth` matched, while the page-key rule is on; true from the start while it is off. Until
   * then the socket receives nothing at all and does not count as the owner being on the website (presence).
   */
  readonly authed: boolean;
  readonly timer: ReturnType<typeof setInterval>;
  /** Closes the socket when no `auth` arrived in time (the page-key rule only). */
  readonly authTimer: ReturnType<typeof setTimeout> | null;
}

class WsHub {
  private clients: ReadonlyMap<WebSocket, WsClient> = new Map();
  private readonly ctx: WebContext;
  private readonly watcher: TranscriptWatcher;
  private readonly offs: ReadonlyArray<() => void>;

  constructor(ctx: WebContext) {
    this.ctx = ctx;
    const { bus, sessions, log } = ctx.deps;
    this.watcher = createTranscriptWatcher(
      { bus, sessions, log, deliver: (sessionId, items) => this.deliver(sessionId, items) },
      {
        debounceMs: ctx.options.transcriptDebounceMs,
        pollMs: ctx.options.transcriptPollMs,
        pageSize: ctx.options.transcriptPageSize,
        maxRemembered: DEFAULT_REMEMBERED_UUIDS,
      },
    );
    this.offs = [
      ...fanOut(bus, (message) => this.broadcast(message)),
      bus.on('transcript.appended', ({ sessionId, items }) => this.watcher.ingest(sessionId, items)),
      bus.on('steps.appended', (payload) => this.deliverSteps({ type: 'steps.appended', ...payload })),
      bus.on('host.log', (entry) => this.deliverHostLog({ type: 'host.log', ...entry })),
    ];
  }

  /** On once the page-key rule is switched on; off without a check. */
  private pageKeyRequired(): boolean {
    return this.ctx.deps.pageKey?.required() === true;
  }

  connect(socket: WebSocket, sid: string): void {
    const timer = setInterval(() => this.checkSession(socket, sid), this.ctx.options.wsSessionCheckMs);
    const clientId = newId();
    const authed = !this.pageKeyRequired();
    // No valid `auth` within the time (5 s): closed with 4401, having received nothing.
    const authTimer = authed
      ? null
      : setTimeout(() => socket.close(WS_CLOSE.sessionExpired, 'page key required'), this.ctx.options.wsAuthTimeoutMs);
    this.put({ socket, sid, clientId, subs: new Set<string>(), stepSubs: new Set<string>(), hostSubs: new Set<string>(), authed, timer, authTimer });
    socket.on('message', (raw) => this.onMessage(socket, raw));
    socket.on('close', () => this.disconnect(socket));
    // A socket that still owes its page key receives nothing, not even hello.
    if (authed) this.admit(socket, clientId, sid);
  }

  /** The socket is in: it counts for presence and gets its hello. */
  private admit(socket: WebSocket, clientId: string, sid: string): void {
    this.ctx.deps.presence.connect(clientId, sid);
    sendJson(socket, this.hello());
  }

  close(): void {
    for (const off of this.offs) off();
    for (const client of this.clients.values()) {
      clearInterval(client.timer);
      if (client.authTimer !== null) clearTimeout(client.authTimer);
      for (const sessionId of client.stepSubs) this.ctx.deps.activity.unwatch(sessionId);
      if (client.authed) this.ctx.deps.presence.disconnect(client.clientId);
    }
    this.clients = new Map();
    this.watcher.close();
  }

  private hello(): WsServerMessage {
    return { type: 'hello', now: isoNow(this.ctx.deps.clock) };
  }

  /** peek, not touch: an open socket must not keep the 1 h idle window alive by itself. */
  private checkSession(socket: WebSocket, sid: string): void {
    if (!sessionStillLive(() => this.ctx.store.peek(sid))) socket.close(WS_CLOSE.sessionExpired, 'session expired');
  }

  private onMessage(socket: WebSocket, raw: RawData): void {
    const message = parseJsonMessage(raw, WsClientMessageSchema);
    const client = this.clients.get(socket);
    if (client !== undefined && !client.authed) {
      // Before its page key the only acceptable frame is a matching `auth`; anything else, even garbage, is 4401.
      this.authenticate(client, message);
      return;
    }
    if (message === null) {
      socket.close(WS_CLOSE.badMessage, 'invalid message');
      return;
    }
    switch (message.type) {
      case 'auth':
        // Accepted and ignored while the page-key rule is off, or once the socket is in.
        return;
      case 'subscribe.host':
        this.subscribeHost(socket, message.host);
        return;
      case 'unsubscribe.host':
        this.unsubscribeHost(socket, message.host);
        return;
      case 'ping':
        this.seen(socket);
        sendJson(socket, this.hello());
        return;
      case 'subscribe.transcript':
        this.subscribe(socket, message.sessionId);
        return;
      case 'unsubscribe.transcript':
        this.unsubscribe(socket, message.sessionId);
        return;
      case 'subscribe.steps':
        this.subscribeSteps(socket, message.sessionId);
        return;
      case 'unsubscribe.steps':
        this.unsubscribeSteps(socket, message.sessionId);
        return;
      case 'presence.hello':
      case 'presence.active':
      case 'notice.ack':
        this.onOwnerSignal(socket, message);
        return;
    }
  }

  /** The first message of a socket that owes its page key: a matching `auth` lets it in, anything else closes it. */
  private authenticate(client: WsClient, message: WsClientMessage | null): void {
    const check = this.ctx.deps.pageKey;
    if (message === null || message.type !== 'auth' || check === undefined || !check.matches(client.sid, message.key)) {
      if (client.authTimer !== null) clearTimeout(client.authTimer);
      client.socket.close(WS_CLOSE.sessionExpired, 'page key required');
      return;
    }
    if (client.authTimer !== null) clearTimeout(client.authTimer);
    this.put({ ...client, authed: true, authTimer: null });
    this.admit(client.socket, client.clientId, client.sid);
  }

  private subscribeHost(socket: WebSocket, host: string): void {
    const client = this.clients.get(socket);
    if (client === undefined || client.hostSubs.has(host)) return;
    this.put({ ...client, hostSubs: new Set([...client.hostSubs, host]) });
  }

  private unsubscribeHost(socket: WebSocket, host: string): void {
    const client = this.clients.get(socket);
    if (client === undefined || !client.hostSubs.has(host)) return;
    this.put({ ...client, hostSubs: new Set([...client.hostSubs].filter((id) => id !== host)) });
  }

  private seen(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client !== undefined) this.ctx.deps.presence.seen(client.clientId);
  }

  /**
   * Presence and acknowledgements. Only presence.active (the owner touched the page) keeps the app session alive;
   * hello, ack and ping are automatic. An acknowledgement counts only from a tab whose last hello said visible.
   */
  private onOwnerSignal(socket: WebSocket, message: Extract<WsClientMessage, { type: 'presence.hello' | 'presence.active' | 'notice.ack' }>): void {
    const client = this.clients.get(socket);
    if (client === undefined) return;
    const { presence, notices } = this.ctx.deps;
    if (message.type === 'presence.hello') {
      presence.hello(client.clientId, message.visible);
    } else if (message.type === 'presence.active') {
      presence.active(client.clientId);
      this.ctx.store.touch(client.sid);
    } else {
      presence.seen(client.clientId);
      if (presence.canAck(client.clientId)) notices.ack(message.ids);
    }
  }

  private subscribe(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (client === undefined || client.subs.has(sessionId)) return;
    if (this.ctx.deps.sessions.get(sessionId) === undefined) return;
    this.put({ ...client, subs: new Set([...client.subs, sessionId]) });
    this.watcher.subscribe(sessionId);
  }

  private unsubscribe(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (client === undefined || !client.subs.has(sessionId)) return;
    this.put({ ...client, subs: new Set([...client.subs].filter((id) => id !== sessionId)) });
    this.watcher.unsubscribe(sessionId);
  }

  /** One watch per client and session; unknown sessions are ignored. */
  private subscribeSteps(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (client === undefined || client.stepSubs.has(sessionId)) return;
    if (this.ctx.deps.sessions.get(sessionId) === undefined) return;
    this.put({ ...client, stepSubs: new Set([...client.stepSubs, sessionId]) });
    this.ctx.deps.activity.watch(sessionId);
  }

  private unsubscribeSteps(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (client === undefined || !client.stepSubs.has(sessionId)) return;
    this.put({ ...client, stepSubs: new Set([...client.stepSubs].filter((id) => id !== sessionId)) });
    this.ctx.deps.activity.unwatch(sessionId);
  }

  private disconnect(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client === undefined) return;
    clearInterval(client.timer);
    if (client.authTimer !== null) clearTimeout(client.authTimer);
    this.clients = new Map([...this.clients].filter(([key]) => key !== socket));
    if (client.authed) this.ctx.deps.presence.disconnect(client.clientId);
    for (const sessionId of client.subs) this.watcher.unsubscribe(sessionId);
    for (const sessionId of client.stepSubs) this.ctx.deps.activity.unwatch(sessionId);
  }

  private put(client: WsClient): void {
    this.clients = new Map<WebSocket, WsClient>([...this.clients, [client.socket, client]]);
  }

  /** The clients a message may reach: every socket that is in (it sent its page key, or none is required). */
  private open(): WsClient[] {
    return [...this.clients.values()].filter((client) => client.authed);
  }

  private broadcast(message: WsServerMessage): void {
    const text = JSON.stringify(message);
    for (const client of this.open()) sendText(client.socket, text);
  }

  private deliverSteps(message: Extract<WsServerMessage, { type: 'steps.appended' }>): void {
    const text = JSON.stringify(message);
    for (const client of this.open()) {
      if (client.stepSubs.has(message.sessionId)) sendText(client.socket, text);
    }
  }

  private deliverHostLog(message: Extract<WsServerMessage, { type: 'host.log' }>): void {
    const text = JSON.stringify(message);
    for (const client of this.open()) {
      if (client.hostSubs.has(message.host)) sendText(client.socket, text);
    }
  }

  private deliver(sessionId: string, items: TranscriptItemDTO[]): void {
    const message: WsServerMessage = { type: 'transcript.appended', sessionId, items };
    const text = JSON.stringify(message);
    for (const client of this.open()) {
      if (client.subs.has(sessionId)) sendText(client.socket, text);
    }
  }
}

export const wsRoutes: RouteModule = (app, ctx) => {
  const hub = new WsHub(ctx);
  app.get('/ws', { websocket: true, exposeHeadRoute: false }, (socket, request) => {
    const session = request.luadySession;
    if (session === null) {
      socket.close(WS_CLOSE.sessionExpired, 'session required');
      return;
    }
    hub.connect(socket, session.sid);
  });
  app.addHook('onClose', async () => {
    hub.close();
  });
};
