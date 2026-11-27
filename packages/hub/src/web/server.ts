import type { Socket } from 'node:net';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { HostId } from '@luady/shared';
import type { AccountsService } from '../accounts/service.js';
import type { PauseService } from '../activity/pause.js';
import type { ClaudeLoginService } from '../claude-login/service.js';
import type { CodexLogin } from '../media/codex-login.js';
import type { ActivityService } from '../activity/service.js';
import type { PresenceService } from '../notices/presence.js';
import type { NoticeRouter } from '../notices/router.js';
import type {
  AccessVerifier,
  ActionService,
  BoardService,
  Clock,
  Db,
  EventBus,
  Fleet,
  FleetHistoryService,
  HubConfig,
  JiraService,
  KbService,
  LibraryService,
  LinksService,
  LuadyService,
  Logger,
  NotesService,
  PinService,
  PrefsService,
  ProjectsService,
  QuestionService,
  RecapService,
  SaidService,
  Scheduler,
  SessionService,
  SettingsService,
  SetupCodeService,
  TimelineService,
  WinsService,
  ChannelsService,
  ConnectService,
  HostsService,
  RoomsService,
  SetupService,
} from '../core/contracts.js';
import { trustedProxyOf } from '../config/defaults.js';
import { LOCAL_ORIGIN_HOST, wantsHsts } from '../config/remote.js';
import { registerAuthChain } from './auth/chain.js';
import { createChallengeStore } from './auth/challenges.js';
import { createPasskeyStore } from './auth/passkeys.js';
import { createSessionStore } from './auth/sessions.js';
import { createWebAuthnService } from './auth/webauthn.js';
import { DEFAULT_WEB_OPTIONS, type WebContext, type WebServerOptions } from './context.js';
import { registerErrorHandler } from './errors.js';
import type { HostCheck } from './host-check.js';
import { registerRateLimits } from './rate-limit.js';
import { OPTIONAL_ROUTE_MODULES, ROUTE_MODULES } from './routes/index.js';
import { registerSecurityHeaders } from './security-headers.js';
import { registerStatic } from './static.js';

export interface TerminalTicketConsumer {
  /** The grant, once, and only to the session (`sid`) the ticket was issued to. */
  consume(ticket: string, sid: string): { server: HostId; target?: string } | null;
}

export interface WebDeps {
  config: HubConfig;
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  fleet: Fleet;
  sessions: SessionService;
  questions: QuestionService;
  actions: ActionService;
  pin: PinService;
  setupCodes: SetupCodeService;
  settings: SettingsService;
  luady: LuadyService;
  projects: ProjectsService;
  tickets: TerminalTicketConsumer;
  /** Map snapshot, agent-view detail and the per-session step stream (activity/service.ts). */
  activity: Pick<ActivityService, 'snapshot' | 'detail' | 'watch' | 'unwatch'>;
  pauses: Pick<PauseService, 'isPaused'>;
  /** Notices for the website and their acknowledgement (notices/router.ts). */
  notices: Pick<NoticeRouter, 'list' | 'ack' | 'webMessage'>;
  /** Website clients that said hello, and the owner's "Updates: chat" (notices/presence.ts). */
  presence: Pick<
    PresenceService, 'connect' | 'hello' | 'active' | 'seen' | 'canAck' | 'disconnect' | 'state' | 'force' | 'sessionSaidHello'
  >;
  /** Accounts with their limits, sign-in and sign-out (accounts/, claude-login/, media/codex-login.ts). */
  accounts: Pick<AccountsService, 'list'>;
  login: Pick<ClaudeLoginService, 'pending' | 'submit' | 'refresh' | 'statuses'>;
  codexLogin: Pick<CodexLogin, 'beginData' | 'status'>;
  access: AccessVerifier;
  classify: (command: string) => { tier: 0 | 1; reason: string };
  google?: import('../google/service.js').GoogleService | null;
  meetings?: import('../meetings/service.js').MeetingsService | null;
  /** The board, delegation and missions (board/), notes (notes/) and what agents said (said/). */
  board: BoardService;
  notes: NotesService;
  said: Pick<SaidService, 'list'>;
  /** The knowledge base (kb/), the library (library/) and Jira (jira/). */
  kb: KbService;
  library: LibraryService;
  jira: JiraService;
  /** The welcome-back recap, the fleet wall, wins, the today strip, links and website preferences. */
  recap: RecapService;
  fleetHistory: Pick<FleetHistoryService, 'history'>;
  wins: WinsService;
  timeline: TimelineService;
  links: LinksService;
  prefs: PrefsService;
  /** The schedule board on Luady's scheduler. */
  scheduler: Pick<Scheduler, 'list' | 'add' | 'cancel'>;
  // ── Optional: each one's route module registers only when it is present (routes/index.ts) ──
  rooms?: RoomsService;
  hosts?: HostsService;
  channels?: ChannelsService;
  setup?: SetupService;
  connect?: ConnectService;
  /**
   * The page key. While `required()` is true (always in the hub: wire/core.ts) every /api request must carry
   * `x-hub-key`, and a socket receives nothing until its first message is a matching `auth`. Absent (unit tests of
   * single routes only): no page key is asked for.
   */
  pageKey?: PageKeyCheck;
  /**
   * The Host check, run before anything else; a request for another host gets 421 "Open <publicOrigin>", WebSocket
   * upgrades included. Always set in the hub (wire/core.ts).
   */
  hostCheck?: HostCheck;
  /** The manager switch and its bootstrap, for the manager routes (luady/control.ts). */
  manager?: import('../luady/control.js').ManagerControl;
}

export interface PageKeyCheck {
  required(): boolean;
  /** Whether `key` is the page key of the session `sid`. */
  matches(sid: string, key: string): boolean;
}

/** FileWriteBody allows 500000 characters; multi-byte text plus JSON escaping needs headroom. */
export const BODY_LIMIT_BYTES = 3 * 1024 * 1024;
export const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MIN_SESSION_SECRET_LENGTH = 32;

/** A bare https:// origin, or http://localhost:<port>: plain http only on this machine's name. */
function acceptedOrigin(origin: URL): boolean {
  if (origin.protocol === 'https:') return true;
  return origin.protocol === 'http:' && origin.hostname === LOCAL_ORIGIN_HOST;
}

export function assertWebConfig(config: HubConfig): void {
  if (config.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`config.sessionSecret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  const origin = new URL(config.publicOrigin);
  if (!acceptedOrigin(origin) || origin.origin !== config.publicOrigin) {
    throw new Error('config.publicOrigin must be a bare https:// origin or http://localhost:<port>');
  }
  if (origin.hostname !== config.rpId && !origin.hostname.endsWith(`.${config.rpId}`)) {
    throw new Error('config.rpId must be the public host or one of its parent domains');
  }
}

function createContext(deps: WebDeps, options: WebServerOptions): WebContext {
  const storeDeps = { db: deps.db, clock: deps.clock };
  const store = createSessionStore(storeDeps);
  const passkeys = createPasskeyStore(storeDeps);
  const webauthn = createWebAuthnService({
    config: deps.config,
    passkeys,
    challenges: createChallengeStore(storeDeps),
    setupCodes: deps.setupCodes,
    pin: deps.pin,
    clock: deps.clock,
    log: deps.log,
  });
  return { deps, store, passkeys, webauthn, options };
}

/** The Host check: before cookies, rate limits and the auth chain, for every request and upgrade. */
function registerHostGate(app: FastifyInstance, check: HostCheck, publicOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (check(request)) return;
    return reply.code(421).type('text/plain; charset=utf-8').send(`Open ${publicOrigin}`);
  });
}

/**
 * Sockets that finished an HTTP upgrade (including rejected ones that stay keep-alive) are no longer
 * tracked by Node's idle-connection sweep, so close() would wait on them forever. Destroy them on close.
 */
function trackSockets(app: FastifyInstance): void {
  const sockets = new Set<Socket>();
  app.server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  app.addHook('preClose', async () => {
    for (const socket of sockets) socket.destroy();
  });
}

/** Returns the instance without listening (wire/core.ts listens on bindHost:webPort). */
export function createWebServer(deps: WebDeps): Promise<FastifyInstance> {
  return buildWebServer(deps, DEFAULT_WEB_OPTIONS);
}

/**
 * Fixed registration order:
 * 1 error mapping · 2 security headers · 3 the Host check · 4 signed cookies · 5 rate limits · 6 auth chain (with the
 * page key) · 7 websocket plugin · 8 API and WebSocket route modules · 9 static SPA + not-found fallback.
 */
export async function buildWebServer(deps: WebDeps, options: WebServerOptions): Promise<FastifyInstance> {
  assertWebConfig(deps.config);
  const loggerInstance: FastifyBaseLogger = deps.log;
  const app = Fastify({
    loggerInstance,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { maxParamLength: 1400 },
  });
  trackSockets(app);
  const ctx = createContext(deps, options);
  registerErrorHandler(app, deps.log);
  registerSecurityHeaders(app, { hsts: wantsHsts(deps.config.publicOrigin) });
  if (deps.hostCheck !== undefined) registerHostGate(app, deps.hostCheck, deps.config.publicOrigin);
  app.decorate('luadySessions', ctx.store);
  await app.register(fastifyCookie, { secret: deps.config.sessionSecret, hook: 'onRequest' });
  await registerRateLimits(app, { trustedProxy: trustedProxyOf(deps.config) });
  const pageKey = deps.pageKey;
  registerAuthChain(app, {
    access: deps.access, store: ctx.store, publicOrigin: deps.config.publicOrigin, log: deps.log,
    ...(pageKey === undefined ? {} : { pageKeyRequired: () => pageKey.required() }),
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
  for (const register of ROUTE_MODULES) register(app, ctx);
  for (const { service, register } of OPTIONAL_ROUTE_MODULES) if (deps[service] !== undefined) register(app, ctx);
  await registerStatic(app, deps.config.webDir);
  return app;
}
