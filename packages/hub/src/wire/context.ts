import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppOverrides, AppTrace } from '../app.js';
import type { AccountsService } from '../accounts/service.js';
import type { LimitsStore } from '../accounts/limits.js';
import type { AccountActions } from '../actions/execute.js';
import type { PauseService } from '../activity/pause.js';
import type { ActivityService } from '../activity/service.js';
import type { OwnerChannelFacade } from '../channels/owner-channel.js';
import type { ClaudeLoginService } from '../claude-login/service.js';
import type {
  AccessVerifier, ActionService, BoardService, ChannelsService, Clock, ConnectService, Db, EventBus, FleetHistoryService,
  HostsService, HubConfig, JiraService, KbService, LibraryService, LinksService, Logger, LuadyService, MemoryService, OutboundChannel,
  PhoneService, PinService, PrefsService, ProjectsService, RecapService, RoomsService, SaidService,
  Scheduler, SessionService, SettingsService, SetupCodeService, SetupService, TimelineService, ToolContext, WinsService,
} from '../core/contracts.js';
import type { ClaudeUpdater } from '../daily/claude-update.js';
import type { DailyJobs } from '../daily/jobs.js';
import type { DynamicFleet } from '../fleet/fleet-core.js';
import type { ManagerControl } from '../luady/control.js';
import type { GoogleService } from '../google/service.js';
import type { ImapService } from '../mail/imap.js';
import type { CodexLogin } from '../media/codex-login.js';
import type { ImageGenerator } from '../media/imagegen.js';
import type { MeetingsService } from '../meetings/service.js';
import type { MissionService } from '../missions/service.js';
import type { NotesHub } from '../notes/index.js';
import type { ChannelDefaults } from '../notices/channel.js';
import type { PresenceService } from '../notices/presence.js';
import type { NoticeRouter } from '../notices/router.js';
import type { TwilioPhone } from '../phone/service.js';
import type { TicketStore } from '../security/tickets.js';
import type { createQuestionService } from '../questions/service.js';
import type { TodoService } from '../todos/service.js';
import type { WebDeps } from '../web/server.js';

/**
 * The composition context. `app.ts` runs the wire modules in a fixed order; each module builds the services of the
 * package that owns their factories and provides them here under the names below.
 *
 * - Every key is declared once, with its type, in WireKeys. Every module is always wired, so a module reads another's
 *   service through `get` (throws when nothing provided it), at call time, never at construction.
 * - A factory that needs an object built by a later module gets `later(name)`: a forwarding stand-in that reads the
 *   provided object at every property access. Optional methods stay optional (`standIn.morningTurn?.()`). A service
 *   that can be null (Google, IMAP, the Twilio phone) is decided from the config while wiring and never wrapped.
 */
export interface WireKeys {
  // ── core ──
  config: HubConfig;
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  settings: SettingsService;
  access: AccessVerifier;
  webServer: FastifyInstance;
  // ── fleet ──
  fleet: DynamicFleet;
  // ── work ──
  memory: MemoryService;
  tickets: TicketStore;
  pauses: PauseService;
  sessions: SessionService & Lifecycle;
  activity: ActivityService;
  questions: ReturnType<typeof createQuestionService>;
  projects: ProjectsService & Lifecycle;
  actions: ActionService;
  limits: LimitsStore;
  claudeLogin: ClaudeLoginService;
  accountActions: AccountActions;
  jira: JiraService;
  accounts: AccountsService;
  claudeUpdater: ClaudeUpdater;
  board: BoardService;
  kb: KbService;
  library: LibraryService;
  fleetHistory: FleetHistoryService;
  wins: WinsService;
  links: LinksService;
  // ── rooms ──
  rooms: RoomsService;
  // ── channels ──
  /** The owner's channel: every owner-facing sender of the hub. */
  ownerChannel: OwnerChannelFacade;
  /** The declared channels: `list()` feeds `GET /api/channels`, the overview and the accounts rows. */
  channels: ChannelsService;
  presence: PresenceService;
  notices: NoticeRouter;
  /** Owner-facing senders: the website first while the owner is there (notices/owner.ts). */
  toOwner: (defaults: ChannelDefaults) => OutboundChannel;
  missions: MissionService;
  todos: TodoService;
  meetings: MeetingsService;
  images: ImageGenerator;
  codexLogin: CodexLogin;
  /** The nightly tools update (daily jobs, wire/manager.ts). */
  updateTools: () => Promise<unknown>;
  // ── connect ──
  /** Null when the config has no Google client. */
  google: GoogleService | null;
  connect: ConnectService;
  // ── manager ──
  luady: LuadyService;
  /** The manager switch: off, starting, on or failed; the fleet's self host is reachable only when on. */
  managerControl: ManagerControl;
  scheduler: Scheduler;
  daily: DailyJobs;
  // ── setup ──
  setupCodes: SetupCodeService;
  pin: PinService;
  setup: SetupService;
  // ── hosts ──
  hosts: HostsService;
  // ── domain ──
  phone: PhoneService;
  /** Null when the config has no Twilio account and voice origin, or a test passes its own phone. */
  twilioPhone: TwilioPhone | null;
  /** Null when the secrets have no IMAP mailbox. */
  imap: ImapService | null;
  notes: NotesHub;
  said: SaidService;
  recap: RecapService;
  timeline: TimelineService;
  prefs: PrefsService;
  internalServer: FastifyInstance;
  voiceServer: FastifyInstance | null;
}

export type WireKey = keyof WireKeys;

/** A service the app starts and stops. */
export interface Lifecycle { start(): void; stop(): void }

/** The lifecycle phases: started in this order, stopped in the reverse. */
export const PHASES = ['infra', 'services', 'feeds', 'listen'] as const;
export type Phase = (typeof PHASES)[number];

/** What every module contributed, merged in module order; `compose` sees it once every module is wired. */
export interface Contributions {
  readonly web: Partial<WebDeps>;
  readonly internal: readonly FastifyPluginAsync[];
  readonly tools: Partial<ToolContext>;
}

/** What one wire module returns. */
export interface Wired {
  readonly name: string;
  /** The module's part of App.services (the keys are compared with the recording). */
  readonly services: Readonly<Record<string, unknown>>;
  readonly web?: Partial<WebDeps>;
  readonly internal?: readonly FastifyPluginAsync[];
  readonly tools?: Partial<ToolContext>;
  /** Builds what needs every module's contributions (core: the web server; domain: tools and the internal server). */
  compose?(all: Contributions): Promise<void>;
  start?(phase: Phase): Promise<void>;
  stop?(phase: Phase): Promise<void>;
}

export type WireModule = (ctx: WireContext) => Wired | Promise<Wired>;

export interface WireContext {
  readonly config: HubConfig;
  readonly overrides: AppOverrides;
  provide<K extends WireKey>(name: K, value: WireKeys[K]): WireKeys[K];
  /** The provided value; throws when no module has provided it (yet). */
  get<K extends WireKey>(name: K): WireKeys[K];
  /** A forwarding stand-in for an object a later module provides. */
  later<K extends WireKey>(name: K): NonNullable<WireKeys[K]>;
  /** A forwarding stand-in for an object made on first use (an owner sender made from a later module's factory). */
  lazy<T extends object>(make: () => T): T;
  /** One start step: traced, then run. A failure stops the start. */
  start(step: string, run: () => unknown): Promise<void>;
  /** One stop step: traced, then run; a failure is logged and never blocks the rest. */
  stop(step: string, run: () => unknown): Promise<void>;
  /** Called once with each key list. */
  traceKeys(list: 'webDeps' | 'toolContext', keys: readonly string[]): void;
}

/** Forwards every property read to `target()`, resolved at the read: methods are bound, absent ones stay absent. */
function forwarding(target: () => object): object {
  return new Proxy(Object.create(null) as object, {
    get(_stub, prop) {
      const object = target();
      const value: unknown = Reflect.get(object, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
    has: (_stub, prop) => Reflect.has(target(), prop),
  });
}

export function createWireContext(config: HubConfig, overrides: AppOverrides): WireContext {
  const values = new Map<WireKey, unknown>();
  const trace = (entry: AppTrace): void => overrides.trace?.(entry);
  const get = <K extends WireKey>(name: K): WireKeys[K] => {
    if (!values.has(name)) throw new Error(`wire: ${name} is not provided (yet)`);
    return values.get(name) as WireKeys[K];
  };
  const ctx: WireContext = {
    config,
    overrides,
    provide(name, value) {
      if (values.has(name)) throw new Error(`wire: ${name} is provided twice`);
      values.set(name, value);
      return value;
    },
    get,
    later(name) {
      return forwarding(() => {
        const value = get(name);
        if (value === null || typeof value !== 'object') throw new Error(`wire: ${name} is not an object`);
        return value;
      }) as NonNullable<WireKeys[typeof name]>;
    },
    lazy(make) {
      let made: object | null = null;
      return forwarding(() => {
        made ??= make();
        return made;
      }) as ReturnType<typeof make>;
    },
    async start(step, run) {
      trace({ kind: 'start', step });
      await run();
    },
    async stop(step, run) {
      trace({ kind: 'stop', step });
      try {
        await run();
      } catch (err) {
        (values.get('log') as Logger | undefined)?.error({ err, step }, 'app: shutdown step failed');
      }
    },
    traceKeys(list, keys) {
      trace({ kind: 'keys', list, keys });
    },
  };
  return ctx;
}
