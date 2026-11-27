import { userInfo } from 'node:os';
import { SELF_HOST_ID, isHostId, isSelfHost, type HostId } from '@luady/shared';
import type { CtlClient, Fleet, FleetHostInfo, ShellStream } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import { createLineBuffer } from '../ingest/line-buffer.js';
import { ManagerOffError } from '../luady/errors.js';
import type { HubPathGuard } from '../security/hub-paths.js';
import { createCtlClient } from './ctl-client.js';
import { guardHubFiles } from './hub-files.js';
import { homeFolderOf, projectsFolderOf } from './folders.js';
import { errorMessage, type Executor, type LinkStatus, type RemoteExecutor, type ShellOptions, type StreamHandle } from './executor.js';
import type { FleetDeps } from './fleet.js';
import { createServersRepo, type ConfigSyncResult, type HostRecord } from './servers-repo.js';
import { createStaggeredStarter } from './stagger.js';
import { createPhaseScheduler } from './sysinfo-phase.js';

const TAIL_FROM_RE = /^(?:start|end|events-\d{8}\.jsonl:\d{1,15})$/;

export interface FleetParts {
  /** Fixed executors by host id (tests): a pinned row whose id is here uses this one. */
  remotes?: ReadonlyMap<HostId, RemoteExecutor>;
  /** Builds the executor of one pinned row (fleet/fleet.ts: ssh2, or this computer's luady-ctl); null = none. */
  build?: (record: HostRecord) => RemoteExecutor | null;
  /** The self host's executor: the manager's own luady-ctl. */
  local: Executor;
  /**
   * The hub's own folders on this machine: "this computer"'s file verbs refuse them (fleet/hub-files.ts). `createFleet`
   * always passes it; a fleet built without one (tests over fakes) has no such folders.
   */
  hubPaths?: HubPathGuard;
}

/**
 * The dynamic fleet: executors for pinned rows only, changed at run time. The hosts module
 * writes a row, then calls addHost, replaceHost or removeHost with its id; the fleet reads the row itself.
 */
export interface DynamicFleet extends Fleet {
  /** Builds and starts the executor of a pinned row. Refused for a draft or removed row, or an id it already has. */
  addHost(id: string): void;
  /** Closes a host's executor and builds a new one from its row as it is now (after a pin or an edit). */
  replaceHost(id: string): Promise<void>;
  /** Closes a host's executor and forgets it; the row is the hosts module's to change. */
  removeHost(id: string): Promise<void>;
  /** The live link of a host that has an executor; null for any other id. */
  link(id: string): LinkStatus | null;
  /** The executor of a pinned host (the hosts module runs its fixed scripts through it). */
  executor(id: string): RemoteExecutor | undefined;
  /** What the config sync of this start did; null for a read-only fleet. */
  lastSync(): ConfigSyncResult | null;
}

interface Entry {
  readonly record: HostRecord;
  readonly executor: RemoteExecutor;
  readonly client: CtlClient;
  readonly off: () => void;
}

/**
 * The self host behind the manager switch: while the manager is off, or still being set up, no
 * call reaches its luady-ctl. Every exec is refused with ManagerOffError and every stream ends at once.
 */
export function gateExecutor(executor: Executor, ready: () => boolean): Executor {
  return {
    async exec(args, opts) {
      if (!ready()) throw new ManagerOffError();
      return executor.exec(args, opts);
    },
    execStream(args, onData): StreamHandle {
      if (!ready()) return { stop: () => undefined, done: Promise.resolve() };
      return executor.execStream(args, onData);
    },
    close: () => executor.close(),
  };
}

function hubUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'owner';
  }
}

/** The fleet over injected executors (tests pass fakes; `createFleet` passes ssh2/local ones). */
export function createFleetWith(deps: FleetDeps, parts: FleetParts): DynamicFleet {
  const repo = createServersRepo(deps.db, deps.log);
  const selfReady = (): boolean => deps.selfReady?.() ?? true;
  const selfListed = (): boolean => deps.selfListed?.() ?? selfReady();
  const selfClient = createCtlClient(gateExecutor(parts.local, selfReady));
  const selfExecutor = parts.local;
  let entries: ReadonlyMap<string, Entry> = new Map();
  let started = false;
  const starter = createStaggeredStarter();
  const phases = createPhaseScheduler({ hosts: () => [...entries.keys()], run: phaseTurn });
  const syncResult = deps.readOnly === true ? null : repo.syncConfig(deps.config, { user: hubUser(), nowIso: isoNow(deps.clock) });
  for (const id of syncResult?.collisions ?? []) {
    deps.log.warn({ host: id }, 'fleet: a config.json server has the id of a host added on the website; the config entry is skipped');
  }
  for (const id of syncResult?.removed ?? []) deps.log.info({ host: id }, 'fleet: a config host left config.json and is now removed');

  function publish(id: string): void {
    const dto = repo.get(id);
    if (dto !== undefined && deps.readOnly !== true) deps.bus.emit('server.updated', dto);
  }

  async function refreshVersion(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined) return;
    try {
      const version = await entry.client.version();
      if (deps.readOnly !== true) repo.setVersions(id, version.kit, version.claude);
      publish(id);
    } catch (err) {
      deps.log.warn({ server: id, err: errorMessage(err) }, 'luady-ctl version failed');
    }
  }

  async function refreshSysinfo(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined) return;
    try {
      const sysinfo = await entry.client.sysinfo();
      if (deps.readOnly !== true) repo.setSysinfo(id, sysinfo, isoNow(deps.clock));
      publish(id);
    } catch (err) {
      deps.log.warn({ server: id, err: errorMessage(err) }, 'luady-ctl sysinfo failed');
    }
  }

  function onStatus(id: string, status: LinkStatus): void {
    if (deps.readOnly === true) return;
    repo.setStatus(id, status, isoNow(deps.clock));
    publish(id);
    if (status === 'online') void refreshVersion(id).then(() => refreshSysinfo(id));
  }

  /** One host's second of the minute: the live link is the truth (a row another process rewrote is repaired). */
  async function phaseTurn(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined || deps.readOnly === true) return;
    const live = entry.executor.status();
    if (repo.get(id)?.status !== live) {
      deps.log.warn({ server: id, live }, 'server status row drifted from the live link; repairing');
      onStatus(id, live);
    } else if (live === 'online') {
      await refreshSysinfo(id);
    }
  }

  function build(record: HostRecord): RemoteExecutor | null {
    return parts.remotes?.get(record.id) ?? parts.build?.(record) ?? null;
  }

  /** An executor for a pinned row; none for drafts, removed rows or an id that does not parse. */
  function attach(record: HostRecord): Entry | null {
    if (record.state !== 'pinned' || !isHostId(record.id) || isSelfHost(record.id)) return null;
    const executor = build(record);
    if (executor === null) {
      deps.log.warn({ host: record.id, kind: record.kind }, 'fleet: no executor for this host');
      return null;
    }
    const off = executor.onStatus((status) => onStatus(record.id, status));
    const plain = createCtlClient(executor);
    // "This computer" runs its kit as the hub's own user: its file verbs never reach the hub's own folders.
    const client = record.kind === 'local' && parts.hubPaths !== undefined ? guardHubFiles(plain, parts.hubPaths) : plain;
    return { record, executor, client, off };
  }

  function put(entry: Entry): void {
    entries = new Map([...entries, [entry.record.id, entry]]);
    if (!started) return;
    publish(entry.record.id);
    starter.enqueue(entry.record.id, entry.executor);
  }

  async function detach(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entries = new Map([...entries].filter(([key]) => key !== id));
    starter.cancel(id);
    entry.off();
    await entry.executor.close();
  }

  /** The rows of this start: the pinned rows, plus (read-only) config entries the hub has not written yet. */
  function initialRecords(): HostRecord[] {
    const pinned = repo.pinned();
    if (deps.readOnly !== true) return pinned;
    const known = new Set(pinned.map((record) => record.id));
    const fromConfig = deps.config.servers
      .filter((server) => !known.has(server.name) && repo.record(server.name)?.source !== 'web')
      .map((server): HostRecord => ({
        id: server.name, kind: 'ssh', host: server.host, user: server.user, port: server.port, hostKeyFp: server.hostKeyFp,
        projectsRoot: server.projectsRoot ?? null, homeDir: server.homeDir ?? null, claudeBin: server.claudeBin ?? null,
        fromAddr: server.fromAddr ?? null, source: 'config', state: 'pinned',
      }));
    return [...pinned, ...fromConfig];
  }

  for (const record of initialRecords()) {
    const entry = attach(record);
    if (entry !== null) put(entry);
  }

  function client(host: HostId): CtlClient {
    if (isSelfHost(host)) return selfClient;
    const found = entries.get(host);
    if (found === undefined) throw new NotFoundError(`unknown host ${host}`);
    return found.client;
  }

  function tailEvents(host: HostId, from: string, onLine: (line: string) => void): StreamHandle {
    if (!TAIL_FROM_RE.test(from)) throw new ValidationError(`invalid tail-events position: ${JSON.stringify(from)}`);
    const executor = isSelfHost(host) ? gateExecutor(selfExecutor, selfReady) : entries.get(host)?.executor;
    if (executor === undefined) throw new NotFoundError(`unknown host ${host}`);
    const lines = createLineBuffer();
    return executor.execStream(['tail-events', '--from', from], (chunk) => {
      for (const line of lines.push(chunk)) {
        try {
          onLine(line);
        } catch (err) {
          deps.log.error({ host, err: errorMessage(err) }, 'tail-events line handler failed');
        }
      }
    });
  }

  const kindOf = (id: string): 'ssh' | 'local' | null => entries.get(id)?.record.kind ?? null;
  const hasServer = (id: string): boolean => kindOf(id) === 'ssh';
  const hasLocal = (id: string): boolean => kindOf(id) === 'local';

  function hostInfo(id: string): FleetHostInfo | null {
    if (isSelfHost(id)) return { id, kind: 'self', projectsRoot: null, homeDir: null, terminal: false };
    const entry = entries.get(id);
    if (entry === undefined) return null;
    const { kind } = entry.record;
    return { id, kind, projectsRoot: projectsFolderOf(entry.record), homeDir: homeFolderOf(entry.record), terminal: kind === 'ssh' };
  }

  return {
    async start() {
      if (started) return;
      started = true;
      for (const entry of entries.values()) {
        publish(entry.record.id);
        starter.enqueue(entry.record.id, entry.executor);
      }
      if (deps.readOnly !== true) phases.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      phases.stop();
      starter.stop();
      for (const entry of entries.values()) entry.off();
      await Promise.all([...[...entries.values()].map((entry) => entry.executor.close()), selfExecutor.close()]);
    },
    client,
    servers: () => repo.list([...entries.keys()]),
    async openShell(server: HostId, opts: ShellOptions): Promise<ShellStream> {
      const entry = entries.get(server);
      if (entry === undefined) throw new NotFoundError(`unknown server ${server}`);
      if (entry.record.kind !== 'ssh') throw new RefusedError('This computer has no web terminal');
      return entry.executor.shell(opts);
    },
    tailEvents,
    // The self host is a host only while the manager is switched on: switched off, nothing even tries to reach it.
    hosts: () => [...entries.keys(), ...(selfListed() ? [SELF_HOST_ID] : [])],
    hasServer,
    hasLocal,
    hasHost: (id) => isSelfHost(id) || hasServer(id) || hasLocal(id),
    hostInfo,
    hubPathRefusal: (id, path, use) => (hasLocal(id) ? parts.hubPaths?.refusal(path, use) ?? null : null),
    addHost(id) {
      if (entries.has(id)) throw new RefusedError(`host ${id} already has a link`);
      const record = repo.record(id);
      if (record === undefined || record.state !== 'pinned') throw new RefusedError(`host ${id} is not pinned`);
      const entry = attach(record);
      if (entry === null) throw new RefusedError(`host ${id} cannot be reached from here`);
      put(entry);
    },
    async replaceHost(id) {
      await detach(id);
      const record = repo.record(id);
      if (record === undefined || record.state !== 'pinned') return;
      const entry = attach(record);
      if (entry !== null) put(entry);
    },
    async removeHost(id) {
      await detach(id);
    },
    link: (id) => entries.get(id)?.executor.status() ?? null,
    executor: (id) => entries.get(id)?.executor,
    lastSync: () => syncResult,
  };
}
