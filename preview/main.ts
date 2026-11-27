import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, AppOverrides } from '../packages/hub/dist/app.js';
import type { Db, HubConfig } from '../packages/hub/dist/core/contracts.js';
import type { TmuxRunner } from '../packages/hub/dist/luady/service.js';
import { PREVIEW_OWNER_TZ, PREVIEW_PIN, PREVIEW_PORT, PREVIEW_SERVERS, demoOwnerZone, previewConfig, previewOrigins } from './config.ts';
import type { DemoHostSeams } from './demo-fakes.ts';
import { isEntryFile } from './entry.ts';
import type { FakeJira } from './fake-jira.ts';
import type { PreviewClock } from './history-seed.ts';
import type { PreviewFleet } from './fake-fleet.ts';
import { createFakeTmux } from './fake-tmux.ts';
import { createLoginTokens, loginLink, type LoginTokens } from './login-token.ts';
import type { PageHook } from './page-hook.ts';
import type { DemoSeed } from './scale-seed.ts';
import {
  PREVIEW_MARKER, assertBuilt, assertKeepFolder, assertPortFree, assertPreviewAllowed, portInUseMessage, staleBuildWarning,
} from './guards.ts';

export interface Preview {
  readonly url: string;
  readonly port: number;
  readonly app: App;
  readonly fleet: PreviewFleet;
  readonly jira: FakeJira;
  /** The hosts module's outside world, faked: handed to the hub on every run. */
  readonly hostSeams: DemoHostSeams;
  /** Settles once Jira is connected and the board, notes and pages are seeded. */
  readonly ready: Promise<void>;
  /** This run's sign-in link: it signs one browser in once, then the next link is made. */
  loginUrl(): string;
  /** Runs a scenario in this process, as `npm run preview:drive` does over HTTP (the demo starts its loop with it). */
  run(scenario: string, args?: readonly string[]): Promise<string>;
  stop(): Promise<void>;
}

export interface StartOptions {
  port?: number; dir?: string; env?: NodeJS.ProcessEnv; logLevel?: string;
  /** A fixed office clock for daylight and ambience (`--clock <ISO>`). */
  clock?: Date;
  /**
   * The owner's zone to store (owner_tz) in a new preview folder; the fixed PREVIEW_OWNER_TZ when absent, so tests stay
   * repeatable. The command lines pass the machine's own (demoOwnerZone in config.ts).
   */
  ownerZone?: string;
  /** Hears each new sign-in link once the previous one has been used (the terminal prints it). */
  onLoginLink?: (url: string) => void;
  /** The demo's rooms, extra servers and sessions (`npm run demo -- --rooms`); the classic preview when absent. */
  seed?: DemoSeed;
}

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = join(REPO_ROOT, 'packages', 'web', 'dist');
const now = (): Date => new Date();
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Everything that needs a build, loaded only after `assertBuilt` so a missing build gives one clear line. */
async function loadModules() {
  const [shared, app, db, log, phone, repo, fleet, routes, shim, scenarios, seed, jira, stepC, wave2, history, pageHook, demo] = await Promise.all([
    import('@luady/shared'), import('../packages/hub/dist/app.js'), import('../packages/hub/dist/db/open.js'),
    import('../packages/hub/dist/log.js'), import('../packages/hub/dist/phone/null.js'), import('../packages/hub/dist/fleet/servers-repo.js'),
    import('./fake-fleet.ts'), import('./routes.ts'), import('./origin-shim.ts'), import('./scenarios.ts'),
    import('./seed.ts'), import('./fake-jira.ts'), import('./step-c.ts'), import('./wave2.ts'), import('./history-seed.ts'),
    import('./page-hook.ts'), import('./demo-fakes.ts'),
  ]);
  return {
    ...shared, ...app, ...db, ...log, ...phone, ...repo, ...fleet, ...routes, ...shim, ...scenarios, ...seed, ...jira, ...stepC, ...wave2,
    ...history, ...pageHook, ...demo,
  };
}
type Modules = Awaited<ReturnType<typeof loadModules>>;
type Runner = (scenario: string, args: readonly string[]) => Promise<string>;
interface Wired { app: App; fleet: PreviewFleet; jira: FakeJira; run: Runner; clock: PreviewClock; hook: PageHook; hostSeams: DemoHostSeams }

async function prepareDir(dir: string | undefined): Promise<{ dir: string; owned: boolean }> {
  const root = dir === undefined ? await mkdtemp(join(tmpdir(), 'luady-preview-')) : resolve(dir);
  for (const sub of ['data', join('brain', 'memory'), 'run']) await mkdir(join(root, sub), { recursive: true });
  // Luady's own skills, as the real brain folder has them (the Library lists them; a kept folder keeps its copy).
  await cp(join(REPO_ROOT, 'brain', 'skills'), join(root, 'brain', 'skills'), { recursive: true, force: false, errorOnExist: false });
  // A kept folder says it is the preview's, so a later run may open its database (assertKeepFolder).
  if (dir !== undefined) {
    await writeFile(join(root, PREVIEW_MARKER), 'Made by the Luady preview. Its data folder holds demo data only.\n', { flag: 'wx' })
      .catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      });
  }
  return { dir: root, owned: dir === undefined };
}

/** Delay before a relaunched brain reports in, like Claude Code starting up. */
const BRAIN_BOOT_MS = 500;

/**
 * The brain's tmux. A brain relaunched after the preview is up (a sign-in, a reset) reports in like the real one does,
 * so what was kept for it is passed on; the first launch is announced by `populate`.
 */
function brainTmux(fleet: PreviewFleet, selfHost: string): TmuxRunner {
  const tmux = createFakeTmux();
  return {
    async run(args) {
      const result = await tmux.run(args);
      const luady = fleet.kit(selfHost);
      const pane = luady.pane('manager:0.0');
      if (args.includes('new-session') && pane !== undefined) {
        setTimeout(() => luady.emit('session_start', pane.target, { source: 'startup', model: 'opus' }), BRAIN_BOOT_MS);
      }
      return result;
    },
  };
}

/**
 * The real hub with only its outside world replaced: the fleet, the manager's tmux, the phone, Jira,
 * and the hosts module's scanner, kit runner, local kit and resolver (no real socket, no process).
 */
async function wire(m: Modules, config: HubConfig, db: Db, logLevel: string, login: LoginTokens, extraServers: readonly string[]): Promise<Wired> {
  // The hub's clock: real time, wound back only while the fleet wall's history is seeded (before the hub starts).
  const clock = m.createPreviewClock();
  const servers = m.createServersRepo(db);
  const fleet = m.createPreviewFleet({ clock: clock.now, records: (id) => servers.record(id) });
  // The demo's extra servers are pinned config rows; each gets a fake link and kit before the rooms on them are imported.
  for (const server of extraServers) if (fleet.link(server) === null) fleet.addHost(server);
  const jira = m.createFakeJira({ clock: now });
  const log = m.createLogger({ level: logLevel });
  const hostSeams = m.createDemoHostSeams();
  const overrides: AppOverrides = {
    clock, db, fleet, tmux: brainTmux(fleet, m.SELF_HOST_ID), log, phone: m.createNullPhone(), jiraFetch: jira.fetch, hosts: hostSeams,
  };
  const app = await m.createApp(config, overrides);
  fleet.bindBus(app.services.bus);
  if (!app.services.pin.isSet()) await app.services.pin.set(PREVIEW_PIN, { setupCode: app.services.setupCodes.issue('owner_setup') });
  // The preview is an install that finished its first run: the website opens on the office, not in the setup wizard.
  app.services.setup.finish();
  for (const host of fleet.kitHosts()) if (!m.isSelfHost(host)) fleet.kit(host).onSend(m.replyTo(fleet.kit(host), sleep));
  m.attachFakeLuady(app, config, fleet, sleep);
  const hook = m.createPageHook({ clock: now });
  m.registerPageHook(app.web, hook);
  const run = m.createRunner(
    fleet, sleep, { postEvent: (text) => app.services.luady.postEvent(text, 'Event') }, m.stepCControls(app, jira), m.wave2Controls(app, hook, now),
  );
  m.registerPreviewRoutes(app.web, {
    fleet, run, scenarios: Object.keys(m.SCENARIOS), login, pageKey: (key) => hook.setPageKey(key), log,
  });
  m.installOriginShim(app.web.server, previewOrigins(config.webPort));
  return { app, fleet, jira, run, clock, hook, hostSeams };
}

function portError(err: unknown, port: number): unknown {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === 'EADDRINUSE' ? new Error(portInUseMessage(port)) : err;
}

/**
 * The seeded fleet appears, then the servers report in (which also clears questions a kept database no longer has).
 * A scale seed (the demo's numbered and mixed rooms) fills the office only: the board, notes and Jira seeds belong to
 * the classic sessions.
 */
function populate(m: Modules, wired: Wired, config: HubConfig, db: Db, seed: DemoSeed | undefined): Promise<void> {
  const sessions = seed?.sessions ?? null;
  if (sessions === null) m.applySeed(wired.fleet);
  else m.applySeed(wired.fleet, sessions);
  const luady = wired.fleet.kit(m.SELF_HOST_ID);
  const pane = luady.addPane('manager', config.brainDir);
  luady.emit('session_start', pane.target, { source: 'startup', model: 'opus' });
  for (const server of [...PREVIEW_SERVERS, ...(seed?.servers ?? [])]) wired.fleet.setStatus(server, 'online');
  // The hub's first sign-in check waits a minute; the preview runs it now so Accounts is filled at once.
  void wired.app.services.login.check();
  if (sessions !== null) return Promise.resolve();
  return m.populateStepC(wired.app, db, wired.jira, now).then(() => m.populateWave2(wired.app, db, now)).catch((err: unknown) => {
    console.warn(`The demo data seed did not finish: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export async function startPreview(opts: StartOptions = {}): Promise<Preview> {
  assertPreviewAllowed(opts.env ?? process.env);
  if (opts.dir !== undefined) assertKeepFolder(opts.dir, opts.env ?? process.env, homedir());
  assertBuilt(REPO_ROOT);
  const port = opts.port ?? PREVIEW_PORT;
  await assertPortFree(port);
  const m = await loadModules();
  const { dir, owned } = await prepareDir(opts.dir);
  const config = previewConfig({
    dir, port, webDir: WEB_DIR, ...(opts.seed === undefined ? {} : { rooms: opts.seed.rooms, extraServers: opts.seed.servers }),
  });
  const db = m.openDb(join(config.dataDir, 'hub.db'));
  const url = `http://localhost:${port}`;
  const login = createLoginTokens((token) => opts.onLoginLink?.(loginLink(url, token)));
  let wired: Wired | null = null;
  const cleanup = async (): Promise<void> => {
    await wired?.run('stop-demo', []).catch(() => undefined);
    await wired?.app.stop();
    if (db.open) db.close();
    if (owned) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    // The owner's zone (owner_tz): the fixed one unless the caller names another; a kept preview keeps its first one.
    db.prepare('INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)').run('owner_tz', JSON.stringify(opts.ownerZone ?? PREVIEW_OWNER_TZ));
    // The preview shows a living manager (a new install's default is off; a kept preview keeps what was chosen).
    db.prepare('INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)').run('manager_enabled', 'true');
    // The demo servers are config rows of the hosts table, as the hub's own fleet writes them at every start (the preview's
    // fleet is a fake, so the preview writes them): Settings lists them, and their ids are taken.
    m.createServersRepo(db).syncConfig(config, { user: m.DEMO_LOCAL_USER, nowIso: new Date().toISOString() });
    wired = await wire(m, config, db, opts.logLevel ?? 'warn', login, opts.seed?.servers ?? []);
    if (opts.clock !== undefined) wired.hook.setClockAt(opts.clock);
    await m.seedFleetHistory(wired.app, wired.clock);
    await wired.app.start({ listen: false });
    await wired.app.web.listen({ host: 'localhost', port });
  } catch (err) {
    await cleanup();
    throw portError(err, port);
  }
  const ready = populate(m, wired, config, db, opts.seed);
  const running = wired;
  let stopping: Promise<void> | null = null;
  return {
    url, port, app: wired.app, fleet: wired.fleet, jira: wired.jira, hostSeams: wired.hostSeams, ready,
    loginUrl: () => loginLink(url, login.current()),
    run: (scenario, args = []) => running.run(scenario, args),
    stop: () => (stopping ??= cleanup()),
  };
}

interface Cli { port: number; keep: string | undefined; log: string; clock: Date | undefined }

/**
 * The flags go after `--` through npm. Windows PowerShell's npm.ps1 drops a bare `--` (npm then reads the flags itself),
 * so there it is quoted (`npm run preview '--' --clock …`) or the preview is started with Node directly:
 * `node --experimental-strip-types preview/main.ts --clock 2026-11-21T12:00:00Z`.
 */
const USAGE = [
  'Usage: npm run preview -- [--port 7420] [--keep <dir>] [--log warn] [--clock <ISO time>]',
  `   or: node --experimental-strip-types preview/main.ts [the same flags]   (Windows PowerShell drops a bare "--": write npm run preview '--' ...)`,
].join('\n');

function parseCli(argv: readonly string[]): Cli | string {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const port = Number(value('--port') ?? PREVIEW_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return USAGE;
  // A fixed clock for daylight and ambience, e.g. --clock 2026-11-21T12:00:00Z.
  const clockText = value('--clock');
  const clock = clockText === undefined ? undefined : new Date(clockText);
  if (clock !== undefined && Number.isNaN(clock.getTime())) return USAGE;
  return { port, keep: value('--keep'), log: value('--log') ?? 'warn', clock };
}

function banner(port: number, link: string): string {
  const portFlag = port === PREVIEW_PORT ? '' : ` --port ${port}`;
  return [
    'Luady preview is running.',
    `  Open   ${link}`,
    '         (Chrome or Firefox; the link signs one browser in once, then the preview prints the next one)',
    `  PIN    ${PREVIEW_PIN}`,
    `  Drive  npm run preview:drive -- demo${portFlag}`,
    `         npm run preview:drive -- ask cedar/meadow-vat${portFlag}`,
    `         npm run preview:drive -- say birch/app-backend "The fix is live on staging."${portFlag}`,
    'Stop with Ctrl+C.',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<void> {
  const cli = parseCli(argv);
  if (typeof cli === 'string') {
    console.error(cli);
    process.exit(1);
  }
  const warning = staleBuildWarning(REPO_ROOT);
  if (warning !== null) console.warn(warning);
  try {
    const preview = await startPreview({
      port: cli.port, dir: cli.keep, logLevel: cli.log, ...(cli.clock === undefined ? {} : { clock: cli.clock }), ownerZone: demoOwnerZone(cli.clock),
      onLoginLink: (link) => console.log(`Next sign-in link: ${link}`),
    });
    console.log(banner(preview.port, preview.loginUrl()));
    const shutdown = (): void => {
      console.log('Stopping the preview...');
      void preview.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (isEntryFile(import.meta.url)) await main(process.argv.slice(2));
