import type { Clock, Db, EventBus, HubConfig, Logger } from '../core/contracts.js';
import { installRoot, managerHomeOf, selfCtlPath } from '../config/defaults.js';
import { configPaths } from '../config/load.js';
import { createHubPathGuard, hubFolders } from '../security/hub-paths.js';
import type { RemoteExecutor } from './executor.js';
import { createFleetWith, type DynamicFleet } from './fleet-core.js';
import { managerEnv, userEnv } from './local-env.js';
import { asLocalRoom, createLocalExecutor } from './local-executor.js';
import { FLEET_RECONNECT_POLICY } from './reconnect.js';
import type { HostRecord } from './servers-repo.js';
import { createSshExecutor } from './ssh-executor.js';

export type { DynamicFleet } from './fleet-core.js';

export interface FleetDeps {
  config: HubConfig;
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /**
   * A short-lived fleet beside the running hub (`cli.js doctor`): it connects and runs luady-ctl but never writes the
   * shared `servers` rows, which belong to the hub's long-lived links.
   */
  readOnly?: boolean | undefined;
  /**
   * Whether the self host may be reached: true only while the manager is on and its bootstrap is
   * done. Until then no call reaches the manager's luady-ctl (every exec refused, every stream ended). Absent: always.
   */
  selfReady?: (() => boolean) | undefined;
  /**
   * Whether the self host is listed in `hosts()` (tailed, its events read): while the manager is switched on, also during
   * its bootstrap, so the event tail retries until the self host answers (each try refused by the gate meanwhile).
   * False while it is switched off: nothing even tries. Absent: the same as selfReady.
   */
  selfListed?: (() => boolean) | undefined;
}

/**
 * The executor of one pinned row: ssh2 for an SSH host (fleet key, pinned host key, ±20 % back-off jitter), the user's
 * own luady-ctl for "this computer" (its HOME, the default tmux server).
 */
function executorFor(deps: FleetDeps, log: Logger, record: HostRecord): RemoteExecutor | null {
  if (record.kind === 'local') {
    const ctlPath = deps.config.localHost?.ctlPath ?? deps.config.localCtlPath;
    return asLocalRoom(createLocalExecutor({ ctlPath, log, env: userEnv() }));
  }
  if (record.hostKeyFp === null) return null;
  return createSshExecutor({
    name: record.id,
    host: record.host,
    port: record.port,
    username: record.user,
    hostKeyFp: record.hostKeyFp,
    privateKeyPath: deps.config.fleetKeyPath,
    ctlPath: deps.config.remoteCtlPath,
    policy: FLEET_RECONNECT_POLICY,
    log,
  });
}

/**
 * The fleet from the hosts table: config rows synced at construction, then an executor per pinned
 * row, changed at run time. The self host runs the manager's own kit, `<managerHome>/.luady/bin/luady-ctl`, with the
 * manager's HOME and its own tmux server; that path is derived, never configured.
 */
export function createFleet(deps: FleetDeps): DynamicFleet {
  const log = deps.log.child({ mod: 'fleet' });
  const managerHome = managerHomeOf(deps.config);
  const local = createLocalExecutor({ ctlPath: selfCtlPath(managerHome), log, env: managerEnv(managerHome) });
  // The config and secrets files are where the hub read them at its start (main.ts reads the same environment).
  const hubPaths = createHubPathGuard(hubFolders(deps.config, { ...configPaths(process.env), installRoot: installRoot() }));
  return createFleetWith({ ...deps, log }, { local, build: (record) => executorFor(deps, log, record), hubPaths });
}
