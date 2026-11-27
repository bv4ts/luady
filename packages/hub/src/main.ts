import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type App } from './app.js';
import { configPaths, loadConfig } from './config/load.js';
import { PROCESS_UMASK, enforceModes } from './config/modes.js';
import { remoteNoPasskey, StartupRefusal } from './config/refusals.js';
import { isRemote } from './config/remote.js';
import { probeSealed } from './config/sealed-probe.js';
import { authModeOf, databaseFiles } from './config/defaults.js';
import type { Db, HubConfig, Logger } from './core/contracts.js';
import { openDb } from './db/open.js';
import { createLogger } from './log.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface RunHubOptions {
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  /** The home folder the default paths are under (tests); `os.homedir()` when absent. */
  home?: string;
  /** False starts every service without binding a socket (tests). Default true. */
  listen?: boolean;
}

export interface RunningHub {
  readonly app: App;
  readonly config: HubConfig;
  stop(): Promise<void>;
}

function passkeyCount(db: Db): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM auth_passkeys').get()?.n ?? 0;
}

/** A remote install in local mode needs a passkey; Access mode is the outer gate. */
function assertPasskeyRule(config: HubConfig, db: Db): void {
  if (isRemote(config) && authModeOf(config) === 'local' && passkeyCount(db) === 0) throw remoteNoPasskey();
}

/**
 * Starts the hub the way `luady start` does: umask 077 first; the config (a starter file and
 * fresh secrets on the first start; the remote, https, Access and host-id refusals); the folders at 0700 and the owner
 * check; the database; the passkey rule and the sealed-row probe; then the app.
 */
export async function runHub(options: RunHubOptions = {}): Promise<RunningHub> {
  process.umask(PROCESS_UMASK);
  const env = options.env ?? process.env;
  const log = options.log ?? createLogger({ level: env.LOG_LEVEL ?? 'info' });
  const config = loadConfig(env, {
    ...(options.home === undefined ? {} : { home: options.home }),
    onCreated: ({ config: created, secrets }) => {
      if (created !== null) log.info({ path: created }, 'hub: wrote a starter config');
      if (secrets.length > 0) log.info({ names: secrets }, 'hub: generated missing secrets');
    },
  });
  const paths = configPaths(env, options.home);
  const modes = {
    secretsPath: paths.secretsPath, extraDirs: paths.configIsDefault ? [dirname(paths.configPath)] : [], log,
    guarded: [paths.configPath, dirname(paths.configPath), dirname(paths.secretsPath)],
  };
  enforceModes(config, modes);
  const db = openDb(databaseFiles(config)[0] ?? '');
  try {
    enforceModes(config, modes);
    assertPasskeyRule(config, db);
    probeSealed(db, config.sessionSecret);
    const app = await createApp(config, { db, log });
    try {
      await app.start({ listen: options.listen ?? true });
    } catch (err) {
      // Some services may have started (a listen failure comes last): stop them before the database closes, or their
      // timers would run against it and crash the process instead of the caller reporting this error.
      await app.stop().catch((stopErr: unknown) => log.error({ err: stopErr }, 'hub: stop after a failed start failed'));
      throw err;
    }
    log.info({ origin: config.publicOrigin, bindHost: config.bindHost, webPort: config.webPort }, 'hub: started');
    return {
      app,
      config,
      stop: async () => {
        await app.stop();
        if (db.open) db.close();
      },
    };
  } catch (err) {
    if (db.open) db.close();
    throw err;
  }
}

function installSignalHandlers(hub: RunningHub, log: Logger): void {
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

async function main(): Promise<void> {
  const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
  try {
    const hub = await runHub({ log });
    installSignalHandlers(hub, log);
  } catch (err) {
    if (err instanceof StartupRefusal) {
      // One plain line; it never holds a secret.
      process.stderr.write(`${err.message}\n`);
      log.fatal({ refusal: err.refusal }, 'hub: refused to start');
    } else {
      log.fatal({ err }, 'hub: failed to start');
    }
    process.exit(1);
  }
}

/** Run only as the entry point: `cli.ts` imports runHub without starting a second hub. */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) await main();
