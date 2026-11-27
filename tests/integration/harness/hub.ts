import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_KEY_HEADER, type RoomImport } from '@luady/shared';
import { createApp, type App } from '../../../packages/hub/dist/app.js';
import type { Db, HubConfig, HubEvents, ServerConfig } from '../../../packages/hub/dist/core/contracts.js';
import { openDb } from '../../../packages/hub/dist/db/open.js';
import { createLogger } from '../../../packages/hub/dist/log.js';
import { createNullPhone } from '../../../packages/hub/dist/phone/null.js';
import { hashPin } from '../../../packages/hub/dist/security/pin-hash.js';
import { CSRF_HEADER } from '../../../packages/hub/dist/web/auth/chain.js';
import { createSessionStore, SESSION_COOKIE } from '../../../packages/hub/dist/web/auth/sessions.js';
import type { FakeServer } from './docker.js';
import { createFakeTmux, type FakeTmux } from './fakes.js';
import type { RunEnv } from './run-env.js';

/** The owner Cloudflare Access lets in, for the one test of that mode. */
export const ACCESS_OWNER_EMAIL = 'owner@example.com';
/** The PIN of a set-up test install. */
export const TEST_PIN = '246813';

export interface TestHubOptions {
  env: RunEnv;
  server?: FakeServer;               // cedar → this container; birch/ash (and cedar when absent) → a closed localhost port
  /** `local` (the default, as a new install): no outer gate. `cloudflare-access`: the real Access verifier. */
  authMode?: 'local' | 'cloudflare-access';
  /** Switches the manager on before the start: with the fake tmux its bootstrap is skipped. */
  manager?: boolean;
  /** Rooms imported once from the config; a new install has none. */
  rooms?: readonly RoomImport[];
  /** A Google OAuth client (made-up values): Google can then be connected from the website. */
  google?: boolean;
  listenPort?: number;               // e2e: also bind app.web on localhost:<port> (every loopback address)
  webDir?: string;                   // default: a temp dir with a stub index.html
  hostKeyFp?: string;                // overrides the pinned fingerprint (host-key mismatch test)
  dir?: string;                      // reuse a previous hub's directory and database (restart test)
  /**
   * `done` (the default): an install that finished its first run, with a PIN (while the setup is at claim or pin,
   * every `/api` route but sign-in and setup answers 409 setup_pending). `new`: a fresh install, unclaimed.
   */
  setup?: 'done' | 'new';
}

/** A signed-in browser as the hub sees it: the signed `hub_sid` cookie, the page key and the CSRF token. */
export interface TestSignIn {
  readonly cookie: string;
  readonly pageKey: string;
  readonly csrf: string;
  /** What an `/api` call carries: the cookie and `x-hub-key`; with `mutating`, also `x-hub-csrf` and the origin. */
  headers(mutating?: boolean): Record<string, string>;
  /** A socket's first message. */
  authFrame(): string;
}

export interface TestHub {
  app: App;
  config: HubConfig;
  db: Db;
  tmux: FakeTmux;
  dir: string;
  spool: Array<HubEvents['spool.event']>;
  record<K extends keyof HubEvents>(name: K): Array<HubEvents[K]>;
  /** A new owner session, made as a sign-in makes it. */
  signIn(): TestSignIn;
  stop(opts?: { keepDir?: boolean }): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const hex32 = (): string => randomBytes(32).toString('hex');

async function prepareDirs(dir: string, webDir: string | undefined): Promise<string> {
  for (const sub of ['data', join('brain', 'memory'), 'run']) await mkdir(join(dir, sub), { recursive: true });
  if (webDir) return webDir;
  const stub = join(dir, 'web');
  await mkdir(stub, { recursive: true });
  await writeFile(join(stub, 'index.html'), '<!doctype html><title>luady-it</title>\n');
  return stub;
}

/** What Cloudflare Access mode adds to the config. */
function accessFields(mode: TestHubOptions['authMode']): Pick<HubConfig, 'authMode' | 'trustedProxy' | 'ownerEmail' | 'cfTeamDomain' | 'cfAccessAud'> {
  if (mode === 'cloudflare-access') {
    return {
      authMode: 'cloudflare-access', trustedProxy: 'cloudflare', ownerEmail: ACCESS_OWNER_EMAIL, cfTeamDomain: 'luady-it.cloudflareaccess.com',
      cfAccessAud: hex32(),
    };
  }
  // Local mode: no Access e-mail and no Access fields at all.
  return { authMode: 'local', trustedProxy: null };
}

/** A new install's config: local mode on loopback, no owner phone, no add-on, three seeded servers. */
async function buildConfig(dir: string, opts: TestHubOptions): Promise<HubConfig> {
  const webDir = await prepareDirs(dir, opts.webDir);
  const closedPort = await freePort();
  const cedar: ServerConfig = {
    name: 'cedar', host: '127.0.0.1', user: 'dev', port: opts.server?.port ?? closedPort, hostKeyFp: opts.hostKeyFp ?? opts.env.hostKeyFp,
  };
  const webPort = opts.listenPort ?? 7410;
  return {
    servers: [cedar, { ...cedar, name: 'birch', port: closedPort }, { ...cedar, name: 'ash', port: closedPort }],
    fleetKeyPath: opts.env.clientKey,
    dataDir: join(dir, 'data'),
    brainDir: join(dir, 'brain'),
    runDir: join(dir, 'run'),
    webDir,
    webPort,
    publicOrigin: `https://localhost:${webPort}`,
    rpId: 'localhost',
    bindHost: '127.0.0.1',
    allowRemote: false,
    addons: [],
    ...(opts.rooms === undefined ? {} : { rooms: [...opts.rooms] }),
    google: opts.google === true ? { clientId: 'luady-it.apps.example.invalid', clientSecret: hex32() } : null,
    twilio: null,
    imap: null,
    allowedHosts: [`localhost:${webPort}`],
    ownerLabel: 'owner',
    managerHome: join(dir, 'data', 'manager-home'),
    managerFiles: 'own-folder',
    ...accessFields(opts.authMode),
    sessionSecret: hex32(),
    hubSocketToken: hex32(),
    claudePath: '/home/luady/.local/bin/claude',
    localCtlPath: join(dir, 'no-local-luady-ctl'),
    remoteCtlPath: '~/.luady/bin/luady-ctl',
  };
}

let pinHash: Promise<string> | null = null;

/** Marks the database as a set-up install: the test PIN is set and the first run is finished (once per process: argon2 is slow on purpose). */
async function markSetUp(db: Db): Promise<void> {
  pinHash ??= hashPin(TEST_PIN);
  db.prepare('UPDATE pin_state SET hash = ? WHERE id = 1').run(await pinHash);
  db.prepare("UPDATE setup_state SET step = 'done', completed_at = updated_at WHERE id = 1").run();
}

/** The manager switch the manager module provides beside its service (wire/manager.ts). */
interface ManagerSwitch { state(): string; settled(): Promise<void> }

/** Waits until a switched-on manager is running (its bootstrap is skipped on the fake tmux). */
async function managerRunning(app: App): Promise<void> {
  const control = (app.services.luady as unknown as { managerControl?: ManagerSwitch }).managerControl;
  if (control === undefined) throw new Error('the manager service has no switch');
  await control.settled();
  if (control.state() !== 'on') throw new Error(`the manager did not start: ${control.state()}`);
}

function signInOn(app: App, db: Db, config: HubConfig): TestSignIn {
  const session = createSessionStore({ db, clock: { now: () => new Date() } }).create();
  // Signed by the hub's own cookie plugin, as setSessionCookie does it.
  const signed = (app.web as unknown as { signCookie(value: string): string }).signCookie(session.sid);
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signed)}`;
  return {
    cookie, pageKey: session.pageKey, csrf: session.csrf,
    headers: (mutating = false) => ({
      cookie, [PAGE_KEY_HEADER]: session.pageKey, host: new URL(config.publicOrigin).host,
      ...(mutating ? { [CSRF_HEADER]: session.csrf, origin: config.publicOrigin } : {}),
    }),
    authFrame: () => JSON.stringify({ type: 'auth', key: session.pageKey }),
  };
}

/** The app as `createApp` composes it, with test overrides. Services start; sockets stay unbound unless listenPort is set. */
export async function startTestHub(opts: TestHubOptions): Promise<TestHub> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), 'luady-it-hub-')));
  const config = await buildConfig(dir, opts);
  const db = openDb(join(config.dataDir, 'hub.db'));
  if ((opts.setup ?? 'done') === 'done' && opts.dir === undefined) await markSetUp(db);
  // The manager is off on a new install; a test that needs it switches it on, as the owner would.
  if (opts.manager === true) db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('manager_enabled', 'true')").run();
  const tmux = createFakeTmux();
  const log = createLogger({ level: process.env.LUADY_IT_LOG ?? 'silent' });
  const app = await createApp(config, { db, tmux, log, phone: createNullPhone() });
  const spool: Array<HubEvents['spool.event']> = [];
  app.services.bus.on('spool.event', (payload) => {
    spool.push(payload);
  });
  const record = <K extends keyof HubEvents>(name: K): Array<HubEvents[K]> => {
    const list: Array<HubEvents[K]> = [];
    app.services.bus.on(name, (payload) => {
      list.push(payload);
    });
    return list;
  };
  await app.start({ listen: false });
  if (opts.manager === true) await managerRunning(app);
  // `localhost` binds every loopback address, so a client that reaches it by name sends the Host the hub answers to.
  if (opts.listenPort !== undefined) await app.web.listen({ host: 'localhost', port: opts.listenPort });
  return {
    app, config, db, tmux, dir, spool, record,
    signIn: () => signInOn(app, db, config),
    async stop(stopOpts = {}) {
      await app.stop();
      if (db.open) db.close();
      if (!stopOpts.keepDir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
