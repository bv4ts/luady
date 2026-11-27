import type {
  ActionDTO, HostId, NoticeDTO, PresenceDTO, QuestionDTO, SessionActivityDTO, WsServerMessage,
} from '@luady/shared';
import { NOTE_CHAT } from './board-data.js';
import { createBoardRoutes } from './board-routes.js';
import { createHudRoutes } from './hud-routes.js';
import { ACCOUNTS, ACTIVITY, CHAT, HOSTS, MINUTE, NOTICES, QUESTIONS, SERVERS, SESSIONS, TRANSCRIPT, detailOf, iso } from './data.js';
import { createRoomRoutes } from './room-routes.js';
import { DEFAULT_SETTINGS, isSelfHost, SELF_HOST_ID } from '@luady/shared';
import { browserZone } from '../../src/lib/browser-zone.js';

/**
 * A pretend hub for the office demo: answers the website's REST calls from the data in data.ts and keeps the little
 * state that pausing, answering, the updates pill and the rooms change. `old` mode answers every live-activity route with 404.
 */
export interface FakeHub {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Live messages the socket should push. */
  onPush(listener: (message: WsServerMessage) => void): void;
  push(message: WsServerMessage): void;
  readonly old: boolean;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = (path: string): Response => json({ error: { code: 'not_found', message: `Route ${path} not found` } }, 404);

let actionNo = 40;
let messageNo = 0;
const action = (kind: string, result: string): ActionDTO => {
  actionNo += 1;
  return {
    id: `A${actionNo}`, actor: 'owner', channel: 'web', kind, tier: 0, summary: kind, status: 'done',
    createdAt: iso(0), decidedAt: iso(0), result, error: null,
  };
};

const STEP_B = /^\/api\/(activity|notices|presence|accounts)|^\/api\/sessions\/[^/]+\/(activity|pause|resume)$/;

export interface FakeHubOptions {
  /** How long every answer takes, in milliseconds (120 by default, like a hub across the room). */
  readonly latencyMs?: number;
}

export function createFakeHub(old: boolean, options: FakeHubOptions = {}): FakeHub {
  const latencyMs = options.latencyMs ?? 120;
  let activity: readonly SessionActivityDTO[] = ACTIVITY;
  let questions: readonly QuestionDTO[] = QUESTIONS;
  let notices: readonly NoticeDTO[] = NOTICES;
  let presence: PresenceDTO = { mode: 'here', online: true, clients: 1, forcedUntil: null };
  let listeners: ReadonlyArray<(message: WsServerMessage) => void> = [];
  const push = (message: WsServerMessage): void => listeners.forEach((listener) => listener(message));
  const board = createBoardRoutes(push);
  const hud = createHudRoutes(push);
  const rooms = createRoomRoutes({ push, hosts: SERVERS.map((server) => server.name), sessions: () => SESSIONS });

  const setPaused = (id: string, paused: boolean): void => {
    activity = activity.map((item) => (item.sessionId === id ? { ...item, paused, tool: paused ? item.tool : item.tool } : item));
    const item = activity.find((entry) => entry.sessionId === id);
    if (item !== undefined) setTimeout(() => push({ type: 'activity.updated', items: [item] }), 400);
  };

  const routes = (method: string, path: string, body: Record<string, unknown>): Response | null => {
    if (method === 'GET' && path === '/api/me') return json({ owner: 'owner@example.com', authMode: 'local', passkeys: 1, pinSet: true, csrf: 'demo' });
    if (method === 'GET' && path === '/api/overview') {
      return json({
        servers: SERVERS, sessions: SESSIONS, questions, actions: [], manager: { state: 'running', since: iso(-MINUTE), claudeSessionId: null, queued: 0 },
        selfHost: SELF_HOST_ID, rooms: rooms.list().items, channels: [],
      });
    }
    if (method === 'GET' && path === '/api/manager/messages') return json({ items: [...CHAT, ...NOTE_CHAT], nextCursor: null });
    if (method === 'POST' && path === '/api/manager/messages') {
      // The owner's message echoes back, Luady looks up, types, and answers.
      messageNo += 1;
      push({ type: 'manager.message', message: { id: `m_sent_${messageNo}`, thread: 'manager', role: 'owner', channel: 'web', text: String(body.text ?? ''), ts: iso(0) } });
      setTimeout(() => push({ type: 'manager.status', status: { state: 'busy', since: iso(0), claudeSessionId: null, queued: 0 } }), 900);
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/api/said') return json({ items: [] });
    if (method === 'GET' && /^\/api\/sessions\/[^/]+\/transcript$/.test(path)) return json({ items: TRANSCRIPT, nextCursor: null });
    if (method === 'GET' && path === '/api/activity') return json({ items: activity });
    if (method === 'GET' && path === '/api/notices') return json({ items: notices });
    if (method === 'GET' && path === '/api/presence') return json(presence);
    if (method === 'GET' && path === '/api/accounts') return json(ACCOUNTS);
    if (method === 'GET' && path === '/api/hosts') return json(HOSTS);
    // The owner's settings (read at start for the zone and the manager's name) and no Jira site in any room. The visitor
    // is the owner here: their own browser's zone, so the clock and the day and dusk light follow them.
    if (method === 'GET' && path === '/api/settings') return json({ ...DEFAULT_SETTINGS, manager_enabled: true, owner_tz: browserZone() });
    if (method === 'GET' && path === '/api/jira') return json({ sites: [] });
    // No chat channel add-on: updates reach the owner on the website.
    if (method === 'GET' && path === '/api/channels') return json([]);
    const session = /^\/api\/sessions\/([^/]+)\/(activity|pause|resume|send)$/.exec(path);
    if (session !== null) {
      const id = decodeURIComponent(session[1] ?? '');
      const verb = session[2];
      if (verb === 'activity') return json(detailOf(id, activity.find((item) => item.sessionId === id)));
      if (verb === 'send') return json(action('session.send', 'sent'));
      if (id.startsWith('ash:')) return json({ error: { code: 'kit_too_old', message: 'ash kit is older than 2.0.0' } }, 409);
      setPaused(id, verb === 'pause');
      return json(action(`session.${verb ?? ''}`, verb === 'pause' ? 'paused' : 'resumed'));
    }
    const answer = /^\/api\/questions\/([^/]+)\/(answer|release)$/.exec(path);
    if (answer !== null) {
      const qid = answer[1] ?? '';
      const question = questions.find((q) => q.qid === qid);
      questions = questions.filter((q) => q.qid !== qid);
      return question === undefined ? notFound(path) : json({ ...question, state: 'answered', resolvedAt: iso(0), resolvedVia: 'web' });
    }
    if (method === 'PUT' && path === '/api/presence') {
      presence = body.chat === true ? { ...presence, mode: 'chat', forcedUntil: iso(60 * MINUTE) } : { ...presence, mode: 'here', forcedUntil: null };
      return json(presence);
    }
    const account = /^\/api\/accounts\/([a-z]+)\/(login|code|logout|refresh)$/.exec(path);
    if (account !== null) return accountRoute(account[1] as HostId | 'codex', account[2] ?? '', body);
    return null;
  };

  return {
    old,
    onPush: (listener) => { listeners = [...listeners, listener]; },
    push,
    fetch: async (input, init) => {
      const url = new URL(input, window.location.origin);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (old && STEP_B.test(url.pathname)) return notFound(url.pathname);
      if (method === 'POST' && url.pathname === '/api/notices/ack') return json({ ok: true });
      const wave2 = old ? undefined : hud(method, url.pathname, body);
      if (wave2 !== undefined) return json(wave2);
      return routes(method, url.pathname, body) ?? rooms.route(method, url.pathname, body) ?? board(method, url.pathname, url, body)
        ?? notFound(url.pathname);
    },
  };

  function accountRoute(host: HostId | 'codex', verb: string, body: Record<string, unknown>): Response {
    if (host === 'codex' && verb === 'login') return json({ url: 'https://auth.openai.com/codex/device', code: 'LUADY-7Q4K', expiresAt: iso(15 * MINUTE) });
    if (verb === 'login') return json({ host, url: 'https://claude.ai/oauth/authorize?state=demo', expiresAt: iso(30 * MINUTE) });
    if (verb === 'code') {
      const ok = String(body.code ?? '') !== 'wrong-code';
      return json({ host, ok, message: ok ? 'Signed in' : 'That code did not work. Copy the whole code and try again.', loggedIn: ok, expiresAt: ok ? iso(30 * 24 * 60 * MINUTE) : null, brainRestarted: ok && isSelfHost(host) });
    }
    if (verb === 'logout') return json(action('account.logout', 'signed out'));
    return json(ACCOUNTS);
  }
}

/** Marks notices settled the way the hub does after a website acknowledgement. */
export function settleNotices(hub: FakeHub, all: () => readonly NoticeDTO[], ids: readonly string[]): void {
  for (const notice of all().filter((n) => ids.includes(n.id) && n.settledAt === null)) {
    setTimeout(() => hub.push({ type: 'notice.updated', notice: { ...notice, settledAt: iso(0), settledVia: 'web', chatDueAt: null } }), 300);
  }
}
