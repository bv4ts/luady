import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AccountsService } from './accounts/service.js';
import type { LimitsStore } from './accounts/limits.js';
import type { PauseService } from './activity/pause.js';
import type { ActivityService } from './activity/service.js';
import type { ClaudeLoginService } from './claude-login/service.js';
import type {
  AccessVerifier, ActionService, BoardService, Clock, Db, EventBus, Fleet, FleetHistoryService, HostsService, HubConfig, JiraService,
  KbService, LibraryService, LinksService, Logger, LuadyService, MemoryService, PhoneService, PinService, ProjectsService,
  QuestionService, RoomsService, Scheduler, SessionService, SettingsService, SetupCodeService, SetupService, ToolContext, WinsService,
} from './core/contracts.js';
import type { TmuxRunner } from './luady/service.js';
import type { PresenceService } from './notices/presence.js';
import type { NoticeRouter } from './notices/router.js';
import type { WebDeps } from './web/server.js';
import { wireChannels } from './wire/channels.js';
import { wireConnect } from './wire/connect.js';
import { PHASES, createWireContext, type Contributions, type WireModule, type Wired } from './wire/context.js';
import { wireCore } from './wire/core.js';
import { wireDomain, type DomainServices } from './wire/domain.js';
import { wireFleet } from './wire/fleet.js';
import { wireHosts } from './wire/hosts.js';
import { wireManager } from './wire/manager.js';
import { wireRooms } from './wire/rooms.js';
import { wireSetup } from './wire/setup.js';
import { wireStatus } from './wire/status.js';
import { wireWork } from './wire/work.js';

/**
 * The app is composition only: the wire modules, in a fixed order, then the phased lifecycle. Every service is built in
 * the wire module of the package that owns its factory.
 */
export interface AppOverrides {
  db?: Db;
  clock?: Clock;
  log?: Logger;
  access?: AccessVerifier;
  phone?: PhoneService;
  tmux?: TmuxRunner;
  fleet?: Fleet;
  /** Jira's REST API; the preview hub passes a fake Jira site. */
  jiraFetch?: typeof globalThis.fetch;
  /**
   * Called at every start and stop step and once with each key list (the WebDeps and tool-context keys): the wiring
   * test records and compares it (hub/test/wire/composition.test.ts). Never set in production.
   */
  trace?: (entry: AppTrace) => void;
}

/** One traced wiring step: a service started or stopped, or a key list. */
export type AppTrace =
  | { readonly kind: 'start' | 'stop'; readonly step: string }
  | { readonly kind: 'keys'; readonly list: 'webDeps' | 'toolContext'; readonly keys: readonly string[] };

export interface App {
  web: FastifyInstance;
  internal: FastifyInstance;
  services: {
    fleet: Fleet; sessions: SessionService; questions: QuestionService; actions: ActionService; luady: LuadyService;
    settings: SettingsService; pin: PinService; setupCodes: SetupCodeService; setup: SetupService; hosts: HostsService; rooms: RoomsService;
    memory: MemoryService; projects: ProjectsService; scheduler: Scheduler; bus: EventBus;
    activity: ActivityService; pauses: PauseService; notices: NoticeRouter; presence: PresenceService;
    accounts: AccountsService; limits: LimitsStore; login: ClaudeLoginService;
    board: BoardService; kb: KbService; library: LibraryService; jira: JiraService;
    fleetHistory: FleetHistoryService; wins: WinsService; links: LinksService;
  } & DomainServices;
  /** listen=false starts services without binding sockets (tests use fastify.inject). Default true. */
  start(opts?: { listen?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

/** The fixed module order: `services` start in it, and stop in its reverse. */
const WIRE_MODULES: readonly WireModule[] = [
  wireCore, wireFleet, wireWork, wireRooms, wireChannels, wireConnect, wireManager, wireSetup, wireHosts, wireStatus, wireDomain,
];

function merged(modules: readonly Wired[]): { services: Record<string, unknown>; all: Contributions } {
  const services: Record<string, unknown> = {};
  const web: Partial<WebDeps> = {};
  const internal: FastifyPluginAsync[] = [];
  const tools: Partial<ToolContext> = {};
  for (const module of modules) {
    for (const [key, value] of Object.entries(module.services)) {
      if (Object.hasOwn(services, key)) throw new Error(`wire: service ${key} comes from two modules`);
      services[key] = value;
    }
    Object.assign(web, module.web);
    internal.push(...(module.internal ?? []));
    Object.assign(tools, module.tools);
  }
  return { services, all: { web, internal, tools } };
}

export async function createApp(config: HubConfig, overrides: AppOverrides = {}): Promise<App> {
  const ctx = createWireContext(config, overrides);
  const modules: Wired[] = [];
  for (const wire of WIRE_MODULES) modules.push(await wire(ctx));
  const { services, all } = merged(modules);
  for (const module of modules) await module.compose?.(all);
  let state: 'new' | 'running' | 'stopped' = 'new';
  return {
    web: ctx.get('webServer'),
    internal: ctx.get('internalServer'),
    services: services as unknown as App['services'],
    start: async (opts: { listen?: boolean } = {}) => {
      if (state !== 'new') return;
      state = 'running';
      const listen = opts.listen ?? true;
      for (const phase of PHASES) {
        if (phase === 'listen' && !listen) continue;
        for (const module of modules) await module.start?.(phase);
      }
    },
    // Every phase in reverse (listen, feeds, services, infra), each module in reverse; the database closes last.
    stop: async () => {
      if (state === 'stopped') return;
      state = 'stopped';
      for (const phase of [...PHASES].reverse()) {
        for (const module of [...modules].reverse()) await module.stop?.(phase);
      }
    },
  };
}
