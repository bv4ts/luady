#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { databaseFiles } from './config/defaults.js';
import { configPaths, loadConfig } from './config/load.js';
import { PROCESS_UMASK } from './config/modes.js';
import { StartupRefusal } from './config/refusals.js';
import type { Db, HubConfig } from './core/contracts.js';
import { openDb } from './db/open.js';
import { renderJson, renderText, runDoctor, type DoctorInput } from './doctor/index.js';
import { loadDoctorInput } from './doctor/load.js';
import { createLogger } from './log.js';
import { runHub } from './main.js';
import { claimBanner, loginCommand, pinResetCommand, setupCodeCommand, type CommandResult } from './setup/index.js';

/**
 * `luady <command>`: `start` runs the hub and, while it is unclaimed, prints the one-time setup code (to a terminal
 * only; otherwise how to get one); `setup-code` prints a new one; `login` prints a one-time sign-in link for this
 * machine; `pin reset` clears the PIN after a typed `yes`; `doctor` checks the install. `setup-code`, `login` and
 * `pin reset` write straight into the database, so they work whether the hub runs or not, but only into an install
 * that exists: they never make one.
 */

/** The config and database a command reads and writes; the hub may be running beside it (SQLite WAL). */
export interface CliStore {
  config: HubConfig;
  db: Db;
  close(): Promise<void>;
}

/** The hub as `start` runs it (main.ts runHub). */
export interface StartedHub {
  readonly config: HubConfig;
  stop(): Promise<void>;
}

export interface CliDeps {
  out(line: string): void;
  err(line: string): void;
  /** Opens the config and the database for one command. */
  open(): Promise<CliStore>;
  /** True when this user has an install: config.json, secrets.env and the database where the hub keeps them. */
  installFound(): boolean;
  /** True when standard output is a terminal (not a service manager's log or a pipe). */
  isTerminal(): boolean;
  /** `start`: the hub, listening; a StartupRefusal when it refuses. */
  startHub(): Promise<StartedHub>;
  /** `start`: keeps the hub until it is told to stop (the process: SIGINT or SIGTERM). Tests return at once. */
  untilStopped(hub: StartedHub): void;
  /** `doctor`: what it reads, changing nothing. */
  doctorInput(): Promise<DoctorInput & { close(): void }>;
  /** Asks one question on the terminal; the answer, trimmed. */
  ask(question: string): Promise<string>;
}

export const USAGE = [
  'Usage: npm run luady -- <command>   (from the Luady folder)',
  '  start            start the hub (prints a setup code until the hub is claimed)',
  '  setup-code       print a new one-time setup code',
  '  login            print a one-time sign-in link (this machine only)',
  '  pin reset        clear the PIN and sign every browser out (asks you to type yes)',
  '  doctor [--full] [--json]   check the install; --full adds names, addresses and paths',
] as const;

/** What setup-code, login and pin reset say, on standard error with exit 1, when there is no install to work on. */
export const NO_INSTALL = [
  'No Luady install was found for this user: no config.json, secrets.env or database where the hub keeps them.',
  'Run this as the user the hub runs as (with the same LUADY_CONFIG and LUADY_SECRETS, if you set them). Nothing was created.',
] as const;

/** Prints a setup command's lines and returns its exit code. */
function print(result: CommandResult, deps: Pick<CliDeps, 'out' | 'err'>): number {
  for (const line of result.lines) (result.exitCode === 0 ? deps.out : deps.err)(line);
  return result.exitCode;
}

/** `pin reset`: only after the owner types `yes` (the setup module clears the PIN, every session and unused codes). */
async function pinReset(store: CliStore, deps: CliDeps): Promise<number> {
  deps.out('This clears your PIN and signs every browser out. Your passkeys stay. The next PIN needs a new setup code.');
  const answer = await deps.ask('Type yes to reset the PIN: ');
  if (answer !== 'yes') {
    deps.out('Nothing changed.');
    return 1;
  }
  return print(pinResetCommand(store.db), deps);
}

// ── commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function start(deps: CliDeps): Promise<number> {
  let hub: StartedHub;
  try {
    hub = await deps.startHub();
  } catch (err) {
    // One plain line; it never holds a secret.
    if (err instanceof StartupRefusal) {
      deps.err(err.message);
      return 1;
    }
    throw err;
  }
  // The hub listens now: from here on a signal stops it, whatever happens to the banner.
  deps.untilStopped(hub);
  await withStore(deps, (store) => {
    for (const line of claimBanner(store.db, store.config, { toTerminal: deps.isTerminal() }).lines) deps.out(line);
    return 0;
  });
  return 0;
}

async function doctor(args: readonly string[], deps: CliDeps): Promise<number> {
  const unknown = args.filter((arg) => arg !== '--full' && arg !== '--json');
  if (unknown.length > 0) return usage(deps);
  const full = args.includes('--full');
  const input = await deps.doctorInput();
  try {
    const report = await runDoctor(input);
    if (args.includes('--json')) deps.out(renderJson(report, { full }));
    else for (const line of renderText(report, { full })) deps.out(line);
    return report.exitCode;
  } finally {
    input.close();
  }
}

/** Runs one command against an existing install's store; refuses, creating nothing, when there is none. */
async function withInstall(deps: CliDeps, run: (store: CliStore) => Promise<number> | number): Promise<number> {
  if (!deps.installFound()) {
    for (const line of NO_INSTALL) deps.err(line);
    return 1;
  }
  return withStore(deps, run);
}

/** Runs one command against the store, closing it after. */
async function withStore(deps: CliDeps, run: (store: CliStore) => Promise<number> | number): Promise<number> {
  const store = await deps.open();
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

function usage(deps: CliDeps): number {
  for (const line of USAGE) deps.out(line);
  return 2;
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'start' && rest.length === 0) return start(deps);
  if (command === 'setup-code' && rest.length === 0) return withInstall(deps, (store) => print(setupCodeCommand(store.db), deps));
  if (command === 'login' && rest.length === 0) return withInstall(deps, (store) => print(loginCommand(store.db, store.config), deps));
  if (command === 'pin' && rest.length === 1 && rest[0] === 'reset') return withInstall(deps, (store) => pinReset(store, deps));
  if (command === 'doctor') return doctor(rest, deps);
  return usage(deps);
}

// ── the process ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The config (a starter file on the very first run) and the database, opened as the hub opens them. */
async function openStore(): Promise<CliStore> {
  const config = loadConfig(process.env);
  const db = openDb(databaseFiles(config)[0] ?? '');
  return {
    config, db,
    close: async () => {
      if (db.open) db.close();
    },
  };
}

/** config.json and secrets.env where the hub reads them, and the database its config names; nothing is written. */
function installFound(): boolean {
  const paths = configPaths(process.env);
  if (!existsSync(paths.configPath) || !existsSync(paths.secretsPath)) return false;
  const file = databaseFiles(loadConfig(process.env))[0];
  return file !== undefined && existsSync(file);
}

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

function stopOnSignal(hub: StartedHub, log: ReturnType<typeof createLogger>): void {
  let stopping = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      log.info({ signal }, 'hub: shutting down');
      hub.stop().then(
        () => process.exit(0),
        (err: unknown) => {
          log.error({ err }, 'hub: shutdown failed');
          process.exit(1);
        },
      );
    });
  }
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim();
  } finally {
    terminal.close();
  }
}

function processDeps(): CliDeps {
  const hubLog = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    open: openStore,
    installFound,
    isTerminal: () => process.stdout.isTTY === true,
    startHub: () => runHub({ log: hubLog }),
    untilStopped: (hub) => stopOnSignal(hub, hubLog),
    doctorInput: async () => loadDoctorInput(process.env),
    ask,
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  // The database and the secrets are the owner's only, whichever command creates them.
  process.umask(PROCESS_UMASK);
  runCli(process.argv.slice(2), processDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`luady: ${err instanceof Error ? err.message : 'unexpected error'}\n`);
      process.exitCode = 1;
    },
  );
}
