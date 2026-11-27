import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PREVIEW_PIN, PREVIEW_PORT, demoOwnerZone, machineZone } from './config.ts';
import { isEntryFile } from './entry.ts';
import { assertBuilt, assertPreviewAllowed, staleBuildWarning } from './guards.ts';
import type { Preview } from './main.ts';
import { demoSeed, MAX_DEMO_ROOMS, type RoomsMode } from './scale-seed.ts';

// No runtime import of the build (or of main.ts, which needs it) before the demo has checked or made the build.

/**
 * `npm run demo`: the real hub with its whole outside world faked, on this machine only. It refuses a
 * production machine, builds when the build is missing or older than the sources, seeds the office for `--rooms`, and
 * runs the scenario loop in this process unless `--still`.
 */
export interface DemoCli {
  readonly rooms: RoomsMode;
  readonly loop: boolean;
  readonly clock: Date | undefined;
  readonly port: number;
  readonly keep: string | undefined;
  readonly open: boolean;
}

export const DEMO_USAGE = [
  'Usage: npm run demo -- [--rooms <n|classic|mixed>] [--loop|--still] [--clock <ISO time>] [--port 7420] [--keep <dir>] [--open]',
  `   or: node --experimental-strip-types preview/demo.ts [the same flags]   (Windows PowerShell drops a bare "--": write npm run demo '--' ...)`,
  `  --rooms   classic (default): the classic four with their sessions, board and notes; 0 to ${MAX_DEMO_ROOMS}: an office`,
  '            of that many rooms (0 is empty, 1 to 3 the first classic rooms, then site-05 and on); mixed: 12 rooms on 6 hosts',
  '  --loop    a session changes every 4 seconds (default); --still: nothing moves unless you drive it',
  '  --clock   a fixed office clock for daylight and ambience, e.g. 2026-11-21T12:00:00Z, in a fixed time zone',
  '            (without it, the office follows the clock and time zone of this machine)',
  '  --keep    keep the demo\'s data in this folder (default: a new folder, removed on exit)',
  '  --open    open the sign-in link in your browser',
].join('\n');

const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(['--rooms', '--clock', '--port', '--keep']);
const SWITCHES: ReadonlySet<string> = new Set(['--loop', '--still', '--open']);

function roomsMode(text: string): RoomsMode | null {
  if (text === 'classic' || text === 'mixed') return text;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= MAX_DEMO_ROOMS ? n : null;
}

/** The flags, or the usage text for anything it does not know. */
export function parseDemoArgs(argv: readonly string[]): DemoCli | string {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (SWITCHES.has(arg)) switches.add(arg);
    else if (FLAGS_WITH_VALUE.has(arg) && argv[i + 1] !== undefined && !(argv[i + 1] ?? '').startsWith('--')) {
      values.set(arg, argv[i + 1] ?? '');
      i += 1;
    } else return DEMO_USAGE;
  }
  if (switches.has('--loop') && switches.has('--still')) return DEMO_USAGE;
  const rooms = roomsMode(values.get('--rooms') ?? 'classic');
  const port = Number(values.get('--port') ?? PREVIEW_PORT);
  const clockText = values.get('--clock');
  const clock = clockText === undefined ? undefined : new Date(clockText);
  if (rooms === null || !Number.isInteger(port) || port < 1 || port > 65_535) return DEMO_USAGE;
  if (clock !== undefined && Number.isNaN(clock.getTime())) return DEMO_USAGE;
  return { rooms, loop: !switches.has('--still'), clock, port, keep: values.get('--keep'), open: switches.has('--open') };
}

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** True when a build output is missing, or older than its sources. */
export function needsBuild(repoRoot: string): boolean {
  try {
    assertBuilt(repoRoot);
  } catch {
    return true;
  }
  return staleBuildWarning(repoRoot) !== null;
}

/** `npm run build` in the checkout, through the npm that runs this script when there is one (no shell then). */
function buildRepo(repoRoot: string): void {
  const npmCli = process.env.npm_execpath;
  const result = npmCli !== undefined && npmCli.endsWith('.js')
    ? spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error('demo-not-built: "npm run build" failed; fix what it printed and try again');
}

/** Opens a link in the default browser; argv only, no shell (the link holds a one-time token). */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  const child = spawn(cmd, [...args], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.warn(`Could not open a browser; open the link yourself: ${url}`));
  child.unref();
}

export interface DemoDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly repoRoot: string;
  build(repoRoot: string): void;
  open(url: string): void;
  onLoginLink(url: string): void;
  /** This machine's zone, the owner's in a demo without `--clock`; absent (tests), the preview's fixed zone. */
  machineZone?: () => string;
}

export const processDemoDeps = (): DemoDeps => ({
  env: process.env, repoRoot: REPO_ROOT, build: buildRepo, open: openBrowser, machineZone,
  onLoginLink: (link) => console.log(`Next sign-in link: ${link}`),
});

/** Starts the demo: refusals, build, the seeded preview, the loop, the browser. */
export async function startDemo(cli: DemoCli, deps: DemoDeps): Promise<Preview> {
  assertPreviewAllowed(deps.env);
  if (needsBuild(deps.repoRoot)) deps.build(deps.repoRoot);
  const { startPreview } = await import('./main.ts');
  const preview = await startPreview({
    port: cli.port, env: deps.env, seed: demoSeed(cli.rooms), onLoginLink: deps.onLoginLink,
    ...(cli.keep === undefined ? {} : { dir: cli.keep }), ...(cli.clock === undefined ? {} : { clock: cli.clock }),
    ...(deps.machineZone === undefined ? {} : { ownerZone: demoOwnerZone(cli.clock, deps.machineZone) }),
  });
  try {
    await preview.ready;
    if (cli.loop) await preview.run('demo', []);
    if (cli.open) deps.open(preview.loginUrl());
  } catch (err) {
    await preview.stop();
    throw err;
  }
  return preview;
}

function roomsText(rooms: RoomsMode): string {
  if (rooms === 'classic') return 'the classic four';
  if (rooms === 'mixed') return '12 rooms on 6 hosts';
  return rooms === 1 ? '1 room' : `${rooms} rooms`;
}

export function demoBanner(cli: DemoCli, link: string): string {
  return [
    'Luady demo is running: everything is faked, nothing leaves this machine.',
    `  Open   ${link}`,
    '         (Chrome or Firefox; the link signs one browser in once, then the demo prints the next one)',
    `  PIN    ${PREVIEW_PIN}`,
    `  Office ${roomsText(cli.rooms)}${cli.loop ? ', a session changes every 4 seconds' : ', still'}`,
    'Stop with Ctrl+C.',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<void> {
  const cli = parseDemoArgs(argv);
  if (typeof cli === 'string') {
    console.error(cli);
    process.exit(1);
  }
  try {
    const preview = await startDemo(cli, processDemoDeps());
    console.log(demoBanner(cli, preview.loginUrl()));
    const shutdown = (): void => {
      console.log('Stopping the demo...');
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
