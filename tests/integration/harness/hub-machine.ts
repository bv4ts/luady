import { randomBytes } from 'node:crypto';
import { COMPOSE_FILE } from './paths.js';
import { mustRun, runProc, shq, type ProcResult } from './proc.js';
import { freePort } from './hub.js';
import type { RunEnv } from './run-env.js';
import { waitFor } from './wait.js';

/**
 * The hub machine (compose service `hub`, tests/integration/hub/): Linux with this checkout built, where a spec runs the
 * real `luady start`, `luady login` and `luady setup-code`, and the manager's bootstrap runs for
 * real. The browser reaches it on http://localhost:<port>; that port is the hub's `webPort`, the one value a spec
 * writes into an otherwise empty config (two specs may run at once).
 */
export interface HubMachine {
  readonly project: string;
  readonly port: number;
  /** The hub's public origin, http://localhost:<port>. */
  readonly url: string;
  /** Runs a bash script as the hub's user, in the checkout. */
  exec(script: string, input?: string): Promise<ProcResult>;
  execOk(script: string, input?: string): Promise<string>;
  /** `luady start` in the background, its output appended to ~/hub.log; resolves once the website answers. */
  start(): Promise<void>;
  /** Stops the hub (SIGTERM, as systemd or Ctrl+C would) and waits until its process has gone. */
  stop(): Promise<void>;
  /** Everything `luady start` printed so far. */
  log(): Promise<string>;
  /** The latest setup code `luady start` printed (it prints one while the hub is unclaimed). */
  setupCode(): Promise<string>;
  /** `luady <args>`, beside the running hub (or without it). */
  cli(args: readonly string[]): Promise<ProcResult>;
  /** A shell line on one of the fleet containers started with the machine, as its user `dev`. */
  onServer(service: ServerService, script: string): Promise<string>;
  /** `GET /internal/status` over the hub socket with the hub token, read inside the machine (the token never leaves it). */
  status(): Promise<Record<string, unknown>>;
  down(): Promise<void>;
}

export type ServerService = 'bare-server' | 'fake-server';
export const HUB_SERVICE = 'hub';
const HUB_USER = 'owner';
const HUB_HOME = `/home/${HUB_USER}`;
const CHECKOUT = `${HUB_HOME}/luady`;
const START_MS = 60_000;
/** The setup module prints the code grouped (ABCD-EFGH-JKLM); the page takes it with or without the dashes. */
const SETUP_CODE_RE = /Setup code: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/g;

/** GET /internal/status on the hub socket, inside the machine: node, the token from secrets.env, the JSON on stdout. */
const STATUS_SCRIPT = [
  "const files = require('node:fs'); const http = require('node:http'); const home = process.env.HOME;",
  "const token = /^HUB_SOCKET_TOKEN=(\\S+)$/m.exec(files.readFileSync(home + '/.config/luady/secrets.env', 'utf8'))[1];",
  "http.get({ socketPath: home + '/.local/share/luady/run/hub.sock', path: '/internal/status', headers: { authorization: 'Bearer ' + token } },",
  "  (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => { process.stdout.write(body); process.exitCode = res.statusCode === 200 ? 0 : 1; }); })",
  "  .on('error', (err) => { process.stderr.write(String(err)); process.exitCode = 1; });",
].join('\n');

function composeArgs(project: string, args: readonly string[]): string[] {
  return ['compose', '-f', COMPOSE_FILE, '-p', project, '--profile', 'hub', '--profile', 'bare', ...args];
}

function composeEnv(env: RunEnv, port: number): NodeJS.ProcessEnv {
  return { LUADY_IT_KEYS_DIR: env.keysDir, LUADY_IT_HUB_PORT: String(port) };
}

/** Builds the hub machine's image (npm ci and the build inside; Docker's cache makes a repeat quick). */
export async function buildHubImage(env: RunEnv): Promise<void> {
  await mustRun('docker', composeArgs('luady-it-build', ['build', HUB_SERVICE]), { env: composeEnv(env, 7410), timeoutMs: 1_800_000 });
}

async function websiteAnswers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { redirect: 'manual' })).status === 200;
  } catch {
    return false;
  }
}

/**
 * Starts a hub machine (and, with `servers`, those fleet containers in the same project, reachable by their service
 * names). The hub itself is not started: the spec does that with `start()`.
 */
export async function startHubMachine(env: RunEnv, opts: { servers?: readonly ServerService[] } = {}): Promise<HubMachine> {
  const project = `luady-it-hub-${randomBytes(4).toString('hex')}`;
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const procEnv = composeEnv(env, port);
  const compose = (args: readonly string[], input?: string, timeoutMs = 120_000) =>
    runProc('docker', composeArgs(project, args), { env: procEnv, input, timeoutMs });
  const services = [HUB_SERVICE, ...(opts.servers ?? [])];
  const up = await compose(['up', '-d', '--wait', '--no-build', ...services], undefined, 180_000);
  if (up.code !== 0) {
    await compose(['down', '-v', '-t', '1']);
    throw new Error(`docker compose up ${services.join(' ')} failed:\n${up.stderr}`);
  }
  const exec = (script: string, input?: string) =>
    compose(['exec', '-T', '-u', HUB_USER, '-e', `HOME=${HUB_HOME}`, '-w', CHECKOUT, HUB_SERVICE, 'bash', '-c', script], input);
  const execOk = async (script: string, input?: string) => {
    const result = await exec(script, input);
    if (result.code !== 0) throw new Error(`[hub] ${script} -> exit ${result.code}\n${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  // The one config value a spec sets: the port the browser uses (an empty config otherwise, as a new install has).
  await execOk(`d="$HOME/.config/luady"; [ -f "$d/config.json" ] || { install -d -m 0700 "$d" && printf '{ "webPort": %s }\\n' ${port} > "$d/config.json" && chmod 0600 "$d/config.json"; }`);
  const running = async (): Promise<boolean> => (await exec("pgrep -u owner -f 'packages/hub/dist/[c]li.js start' >/dev/null")).code === 0;
  const log = async (): Promise<string> => execOk('cat "$HOME/hub.log" 2>/dev/null || true');
  return {
    project, port, url, exec, execOk, log,
    async start() {
      if (await running()) throw new Error('the hub is already running');
      const started = await compose(['exec', '-d', '-u', HUB_USER, '-e', `HOME=${HUB_HOME}`, '-w', CHECKOUT, HUB_SERVICE, 'bash', '-c',
        'exec node packages/hub/dist/cli.js start >> "$HOME/hub.log" 2>&1']);
      if (started.code !== 0) throw new Error(`luady start did not run:\n${started.stderr}`);
      await waitFor(async () => ((await websiteAnswers(url)) ? true : (await running()) ? undefined : Promise.reject(new Error(`luady start ended:\n${await log()}`))),
        { timeoutMs: START_MS, intervalMs: 500, what: 'the hub website' });
    },
    async stop() {
      await exec("pkill -TERM -u owner -f 'packages/hub/dist/[c]li.js start' || true");
      await waitFor(async () => ((await running()) ? undefined : true), { timeoutMs: 30_000, intervalMs: 300, what: 'the hub to stop' });
    },
    async setupCode() {
      const codes = [...(await log()).matchAll(SETUP_CODE_RE)].map((m) => m[1] ?? '');
      const code = codes.at(-1);
      if (code === undefined || code === '') throw new Error(`luady start printed no setup code:\n${await log()}`);
      return code;
    },
    cli: (args) => exec(`node packages/hub/dist/cli.js ${args.map(shq).join(' ')}`),
    async onServer(service, script) {
      const result = await compose(['exec', '-T', '-u', 'dev', '-e', 'HOME=/home/dev', '-w', '/home/dev', service, 'bash', '-c', script]);
      if (result.code !== 0) throw new Error(`[${service}] ${script} -> exit ${result.code}\n${result.stderr}${result.stdout}`);
      return result.stdout;
    },
    async status() {
      return JSON.parse(await execOk('node -', STATUS_SCRIPT)) as Record<string, unknown>;
    },
    async down() {
      await compose(['down', '-v', '--remove-orphans', '-t', '1']);
    },
  };
}
