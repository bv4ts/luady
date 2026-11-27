import {
  LOCAL_HOST_ID, type HostCreatedDTO, type HostDTO, type HostGrantDTO, type HostJobDTO, type HostKeyDTO, type HostScanDTO,
} from '@luady/shared';
import type { HostsService } from '../core/contracts.js';
import { createCore, exclusive, type Core, type HostsServiceDeps } from './core.js';
import { HostAccessError, HostConflictError, HostInvalidError } from './errors.js';
import { checkHost, pinHost, scanHost, type HostCheckResult } from './flow.js';
import { hostKeyDto } from './key-line.js';
import { startKit, type KitMode } from './kit.js';
import { HOSTS_BUCKET, PROBE_BUCKET } from './limits.js';
import { removeHost, type HostRemoveResult } from './remove.js';
import type { RowChanges } from './repo.js';
import {
  checkIdFree, checkLocalFree, checkLocalUpdate, ensureLocalFolder, type HostCreateBody, type HostLocalBody, type HostRemoveBody,
  type HostUpdateBody,
} from './validate.js';

/**
 * The hosts service: SSH servers and "this computer" made from the website. Every change needs the PIN, or a grant
 * that a PIN check gave for that one host's flow; every change writes an owner action row (`host.*`) and sends
 * `hosts.changed`. Only web rows are ever written; config rows can be checked and their kit installed or removed,
 * nothing else.
 */
declare module '../core/contracts.js' {
  interface HostsService {
    get(id: string): HostDTO | undefined;
    key(): HostKeyDTO;
    /** The hub user's home: what `~` means in this computer's projects folder. */
    home(): string;
    /** Throws 400 `local_unsupported` when the hub runs on Windows: this computer can be added on Linux or WSL2 only. */
    assertLocalSupported(): void;
    create(body: HostCreateBody, sidHash: string): Promise<HostCreatedDTO>;
    createLocal(body: HostLocalBody, sidHash: string): Promise<HostCreatedDTO>;
    grant(id: string, pin: string, sidHash: string): Promise<HostGrantDTO>;
    /** Throws 403 `grant_required` unless the grant is this session's, for this host, and alive. */
    authorize(id: string, grant: string | undefined, sidHash: string): void;
    /** Counts one request in a hosts bucket: `changes` per client, `probe` (scan, check) per host. */
    limit(bucket: 'changes' | 'probe', key: string): void;
    scan(id: string): Promise<HostScanDTO>;
    pinKey(id: string, fingerprint: string): Promise<HostDTO>;
    check(id: string): Promise<HostCheckResult>;
    kit(id: string, mode: KitMode): HostJobDTO;
    job(id: string): HostJobDTO | undefined;
    update(id: string, body: HostUpdateBody): Promise<HostDTO>;
    remove(id: string, body: HostRemoveBody): Promise<HostRemoveResult>;
    start(): void;
    stop(): void;
  }
}


async function verifyPin(core: Core, pin: string): Promise<void> {
  await core.deps.pin.verify(pin, 'web');
}

async function createSsh(core: Core, body: HostCreateBody, sidHash: string): Promise<HostCreatedDTO> {
  await verifyPin(core, body.pin);
  checkIdFree(body.id, core.repo.get(body.id));
  core.repo.insertDraft({
    id: body.id, host: body.host, user: body.user, port: body.port, projectsRoot: body.projectsRoot ?? null,
    homeDir: body.homeDir ?? null, claudeBin: body.claudeBin ?? null,
  }, core.now());
  core.log.info({ host: body.id, address: body.host, port: body.port, user: body.user }, 'hosts: server added as a draft');
  core.audit('host.add', body.id, `added server ${body.id} (${body.user}@${body.host}:${body.port})`);
  core.feed.schedule();
  return { host: core.dto(core.row(body.id)), grant: core.grants.issue(sidHash, body.id).grant };
}

/** This computer is added only where the hub itself runs on Linux (WSL2 included); a hub on Windows says so first. */
function assertLocalSupported(core: Core): void {
  if (core.localKit.platform() === 'win32') {
    throw new HostInvalidError('local_unsupported', 'This computer can be added only when the hub runs on Linux or in WSL2');
  }
}

async function createLocal(core: Core, body: HostLocalBody, sidHash: string): Promise<HostCreatedDTO> {
  assertLocalSupported(core);
  await verifyPin(core, body.pin);
  checkLocalFree(core.repo.get(LOCAL_HOST_ID));
  const kit = core.localKit;
  const home = kit.home();
  const made = ensureLocalFolder(body.projectsRoot, { createFolder: body.createFolder === true, home, disk: kit.folders });
  core.repo.upsertLocal({ user: kit.user(), projectsRoot: body.projectsRoot, homeDir: home, claudeBin: body.claudeBin ?? null }, core.now());
  if (core.fleet.executor(LOCAL_HOST_ID) === undefined) core.fleet.addHost(LOCAL_HOST_ID);
  core.log.info({ host: LOCAL_HOST_ID, projectsRoot: body.projectsRoot, folderMade: made }, 'hosts: this computer added');
  core.audit('host.local', LOCAL_HOST_ID, `set up this computer (projects in ${body.projectsRoot}${made ? ', folder made' : ''})`);
  core.feed.schedule();
  return { host: core.dto(core.row(LOCAL_HOST_ID)), grant: core.grants.issue(sidHash, LOCAL_HOST_ID).grant };
}

async function updateLocal(core: Core, body: HostUpdateBody): Promise<void> {
  checkLocalUpdate(body);
  if (body.projectsRoot !== undefined) {
    ensureLocalFolder(body.projectsRoot, { createFolder: false, home: core.localKit.home(), disk: core.localKit.folders });
  }
  core.repo.update(LOCAL_HOST_ID, changesOf(body), false, core.now());
  await core.fleet.replaceHost(LOCAL_HOST_ID);
}

/** The row fields a PUT changes (the PIN is not one of them). */
function changesOf(body: HostUpdateBody): RowChanges {
  return Object.fromEntries(
    (['host', 'user', 'port', 'projectsRoot', 'homeDir', 'claudeBin'] as const).flatMap((key) => (body[key] === undefined ? [] : [[key, body[key]]])),
  ) as RowChanges;
}

async function update(core: Core, id: string, body: HostUpdateBody): Promise<HostDTO> {
  await verifyPin(core, body.pin);
  return exclusive(core, id, () => applyUpdate(core, id, body));
}

async function applyUpdate(core: Core, id: string, body: HostUpdateBody): Promise<HostDTO> {
  const row = core.row(id);
  if (row.source === 'config') throw new HostConflictError('host_from_config', `${id} comes from config.json: change it there, then restart the hub`);
  if (core.jobs.running(id)) throw new HostConflictError('job_running', `A kit job is running on ${id}; wait for it to finish`);
  if (row.kind === 'local') {
    await updateLocal(core, body);
  } else {
    const moved = (body.host !== undefined && body.host !== row.host) || (body.user !== undefined && body.user !== row.user)
      || (body.port !== undefined && body.port !== row.port);
    core.repo.update(id, changesOf(body), moved, core.now());
    if (moved) {
      await core.fleet.removeHost(id);
      core.scans.delete(id);
    } else if (row.state === 'pinned') {
      await core.fleet.replaceHost(id);
    }
  }
  core.audit('host.edit', id, `edited ${id}`);
  core.feed.schedule();
  return core.dto(core.row(id));
}

export function createHostsService(deps: HostsServiceDeps): HostsService {
  const core = createCore(deps);
  let off: (() => void) | null = null;
  return {
    list: () => core.list(),
    get: (id) => {
      const row = core.repo.get(id);
      return row === undefined || row.state === 'removed' ? undefined : core.dto(row);
    },
    key: () => hostKeyDto(deps.fleetKey, deps.config.fleetFrom),
    home: () => core.localKit.home(),
    assertLocalSupported: () => assertLocalSupported(core),
    create: (body, sidHash) => createSsh(core, body, sidHash),
    createLocal: (body, sidHash) => createLocal(core, body, sidHash),
    async grant(id, pin, sidHash) {
      await verifyPin(core, pin);
      core.row(id);
      return core.grants.issue(sidHash, id);
    },
    authorize(id, grant, sidHash) {
      if (!core.grants.check(grant, sidHash, id)) throw new HostAccessError('grant_required', 'This step needs your PIN again');
    },
    limit: (bucket, key) => core.limiter.take(`${bucket}|${key}`, bucket === 'changes' ? HOSTS_BUCKET : PROBE_BUCKET),
    scan: (id) => scanHost(core, id),
    pinKey: (id, fingerprint) => pinHost(core, id, fingerprint),
    check: (id) => checkHost(core, id),
    kit: (id, mode) => startKit(core, id, mode),
    job: (id) => core.jobs.latest(id),
    update: (id, body) => update(core, id, body),
    async remove(id, body) {
      await verifyPin(core, body.pin);
      return exclusive(core, id, () => removeHost(core, id, body));
    },
    start() {
      // A link that comes up or goes down changes the list (its `link` and `lastError`).
      off ??= deps.bus.on('server.updated', () => core.feed.schedule());
    },
    stop() {
      off?.();
      off = null;
      core.feed.stop();
    },
  };
}
