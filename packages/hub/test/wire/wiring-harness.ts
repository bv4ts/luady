import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {} from '@fastify/cookie';
import { vi } from 'vitest';
import { PAGE_KEY_HEADER } from '@luady/shared';
import { createApp, type App, type AppOverrides, type AppTrace } from '../../src/app.js';
import type { AccessVerifier, Clock, Db, Fleet, HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { TmuxRunner } from '../../src/luady/service.js';
import { SESSION_COOKIE, createSessionStore } from '../../src/web/auth/sessions.js';
import { markSetUp } from '../helpers/claimed.js';
import { createFakeCtl, silentLogger, classicHostLookups } from '../helpers/fakes.js';
import { openTestChat, testChatDecl } from '../helpers/chat-addon.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import type { ProvidedManager } from '../../src/wire/manager.js';

/** The fixed instant every wiring run uses, so the three recorded calls answer the same text each time. */
export const WIRING_NOW = '2026-11-21T08:00:00.000Z';
export const WIRING_TOKEN = 'd'.repeat(64);
const OWNER_PHONE = '447700900001';

export const fixedClock: Clock = { now: () => new Date(WIRING_NOW) };

export function wiringConfig(over: Partial<HubConfig> = {}): HubConfig {
  const root = mkdtempSync(join(tmpdir(), 'luady-wiring-'));
  const webDir = join(root, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Hub</title>');
  return {
    ...loadedDefaults(join(root, 'data')),
    servers: [], fleetKeyPath: join(root, 'fleet_key'), dataDir: join(root, 'data'), brainDir: '/home/manager/brain',
    runDir: join(root, 'run'), webDir, webPort: 7410, publicOrigin: 'https://hub.example.com',
    rpId: 'hub.example.com', ownerPhone: OWNER_PHONE, ownerEmail: 'owner@example.com',
    cfTeamDomain: 'team.cloudflareaccess.com', cfAccessAud: 'aud-tag', sessionSecret: 'e'.repeat(64), hubSocketToken: WIRING_TOKEN,
    claudePath: '/home/manager/.local/bin/claude', localCtlPath: '/home/manager/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl',
    ...over,
  };
}

/** A fleet with no servers whose event tails never end: nothing reaches the hub but what a test sends. */
export function quietFleet(): Fleet {
  const ctl = createFakeCtl();
  return {
    start: async () => undefined,
    stop: async () => undefined,
    client: () => ctl,
    servers: () => [],
    openShell: async () => {
      throw new Error('no shell in tests');
    },
    ...classicHostLookups(), tailEvents: () => {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { stop: () => finish(), done };
    },
  };
}

const aliveTmux: TmuxRunner = {
  run: async (args) => ({ code: 0, stdout: args[0] === 'display-message' ? 'claude\n' : '', stderr: '' }),
};
const ownerAccess: AccessVerifier = { verify: async () => ({ email: 'owner@example.com' }) };

/** What one wiring run saw: every traced step, plus where the servers were told to listen. */
export interface WiringRun {
  readonly app: App;
  readonly config: HubConfig;
  readonly trace: AppTrace[];
  readonly listened: { web: unknown[]; internal: unknown[] };
  readonly cookie: string;
  /** The page key of that session: the hub answers /api only with it. */
  readonly pageKey: string;
}

/**
 * What a browser on the hub's own origin sends besides the cookie: the Host of publicOrigin (the Host check
 * answers 421 to any other) and the session's page key.
 */
export function hubHeaders(run: Pick<WiringRun, 'config' | 'pageKey'>): Record<string, string> {
  return { host: new URL(run.config.publicOrigin).host, [PAGE_KEY_HEADER]: run.pageKey };
}

/** Every optional service configured: Google, an IMAP mailbox, and the phone with its voice server. */
export function everythingConfig(): HubConfig {
  return wiringConfig({
    google: { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'g'.repeat(24) },
    imap: { host: 'imap.example.com', port: 993, user: 'owner@example.com', password: 'pw', label: 'work' },
    twilio: { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), from: '+15550000000' },
    voiceOrigin: 'https://voice.example.com',
  });
}

/**
 * Builds the app with fakes and the fixed clock, then starts it, by default with `listen: true` and the listen
 * methods of the returned web and internal servers stubbed (the internal one would bind a Unix socket).
 */
export async function startWiring(
  over: Partial<AppOverrides> = {}, config: HubConfig = wiringConfig(), listen = true, seed?: (db: Db) => void,
): Promise<WiringRun> {
  const db = openMemoryDb();
  // An owner signs in only on a set-up install (before that the hub answers sign-in and setup only).
  await markSetUp(db);
  seed?.(db);
  const trace: AppTrace[] = [];
  const app = await createApp(config, {
    db, log: silentLogger(), access: ownerAccess, tmux: aliveTmux, fleet: quietFleet(), clock: fixedClock,
    trace: (entry) => trace.push(entry), ...over,
  });
  const listened: WiringRun['listened'] = { web: [], internal: [] };
  vi.spyOn(app.web, 'listen').mockImplementation((async (opts: unknown) => {
    listened.web.push(opts);
    return 'http://127.0.0.1:0';
  }) as never);
  vi.spyOn(app.internal, 'listen').mockImplementation((async (opts: { path: string }) => {
    listened.internal.push(opts);
    writeFileSync(opts.path, '');
    return opts.path;
  }) as never);
  await app.start({ listen });
  const session = createSessionStore({ db, clock: fixedClock }).create();
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(app.web.signCookie(session.sid))}`;
  return { app, config, trace, listened, cookie, pageKey: session.pageKey };
}

/** Switches the manager on and waits until it is ready: the manager's internal tool routes answer only then. */
export async function switchManagerOn(app: App): Promise<void> {
  app.services.settings.update({ manager_enabled: true });
  await (app.services.luady as ProvidedManager).managerControl.settled();
}

export const startSteps = (trace: readonly AppTrace[]): string[] => trace.flatMap((e) => (e.kind === 'start' ? [e.step] : []));
export const stopSteps = (trace: readonly AppTrace[]): string[] => trace.flatMap((e) => (e.kind === 'stop' ? [e.step] : []));
export const keysOf = (trace: readonly AppTrace[], list: 'webDeps' | 'toolContext'): string[] =>
  trace.flatMap((e) => (e.kind === 'keys' && e.list === list ? [...e.keys] : []));

/** The three recorded calls: the overview, one MCP tool and the inbound router. */
export interface WiringCalls {
  readonly overview: { readonly status: number; readonly body: unknown };
  readonly tool: { readonly status: number; readonly body: unknown };
  readonly inbound: { readonly replies: Array<{ text: unknown; quotedId: unknown }> };
}

const CHAT_CAPABILITIES = {
  text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
  replyQuote: true, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
};

/**
 * Drives the inbound router as a chat add-on does (Protocol v1: hello, status up, then the owner's /help). It runs on a
 * hub of its own with the test chat declared, connected over the add-on route, so the recorded app keeps its config.
 */
async function chatHelp(): Promise<Array<{ text: unknown; quotedId: unknown }>> {
  const run = await startWiring({}, wiringConfig({ addons: [testChatDecl(OWNER_PHONE)] }), false);
  try {
    const chat = await openTestChat(run.app, run.config.dataDir, { capabilities: CHAT_CAPABILITIES });
    chat.receive({ t: 'incoming', msgId: 'in-1', from: OWNER_PHONE, text: '/help', ts: 1_795_000_000 });
    await vi.waitFor(() => {
      if (!chat.frames.some((frame) => frame.t === 'send')) throw new Error('no reply yet');
    });
    chat.close();
    return chat.frames.filter((frame) => frame.t === 'send').map((frame) => ({ text: frame.text, quotedId: frame.replyTo }));
  } finally {
    await run.app.stop();
  }
}

export async function wiringCalls(run: WiringRun): Promise<WiringCalls> {
  const overview = await run.app.web.inject({
    method: 'GET', url: '/api/overview', headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, ...hubHeaders(run) },
  });
  const replies = await chatHelp();
  // The tool call last: the manager's tools answer only while it is on, and the other two calls see it off.
  await switchManagerOn(run.app);
  const tool = await run.app.internal.inject({
    method: 'POST', url: '/internal/tools/fleet_status', headers: { authorization: `Bearer ${WIRING_TOKEN}` }, payload: {},
  });
  return { overview: { status: overview.statusCode, body: overview.json() }, tool: { status: tool.statusCode, body: tool.json() }, inbound: { replies } };
}
