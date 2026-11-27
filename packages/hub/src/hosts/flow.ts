import type { HostCheckDTO, HostDTO, HostScanDTO } from '@luady/shared';
import type { RemoteExecutor } from '../fleet/executor.js';
import { compareCommand } from '../fleet/host-scan.js';
import type { Core } from './core.js';
import { HostConflictError } from './errors.js';
import { hostKeyDto } from './key-line.js';
import { localReport, parsePreflight, type PreflightReport } from './preflight.js';
import type { HostRow } from './repo.js';
import { resolveChecked } from './resolve.js';

/**
 * The add-server flow's middle: scan the host key (no authentication), pin it once the owner said it
 * matches (never automatically), then check the link and run the preflight. On `denied` the link stays stopped and the
 * key line is returned again; the next check is the "Try again" and resumes it.
 */
export const SCAN_TTL_MS = 10 * 60_000;
export const CHECK_WAIT_MS = 20_000;
const DEFAULT_CLAUDE = '~/.local/bin/claude';

/** HostCheckDTO: after `denied` it carries the key line again. */
export type HostCheckResult = HostCheckDTO;

function sshRow(core: Core, id: string): HostRow {
  const row = core.row(id);
  if (row.kind !== 'ssh') throw new HostConflictError('host_is_local', 'This computer has no host key or link to check over SSH');
  return row;
}

export async function scanHost(core: Core, id: string): Promise<HostScanDTO> {
  const row = sshRow(core, id);
  const address = await resolveChecked(row.host, core.lookup);
  const result = await core.scanner.scan({ host: address, port: row.port });
  core.scans.set(id, { fingerprint: result.fingerprint, keyType: result.keyType, at: core.nowMs() });
  core.log.info({ host: id, address: row.host, port: row.port, fingerprint: result.fingerprint, keyType: result.keyType }, 'hosts: host key scanned');
  return { fingerprint: result.fingerprint, keyType: result.keyType, compare: compareCommand(result.keyType) };
}

/** Pins the fingerprint the owner confirmed; it must equal this host's scan of the last ten minutes. */
export async function pinHost(core: Core, id: string, fingerprint: string): Promise<HostDTO> {
  const row = sshRow(core, id);
  if (row.source === 'config') {
    throw new HostConflictError('host_from_config', 'This server comes from config.json: put the new fingerprint in its hostKeyFp there, then restart the hub');
  }
  const scan = core.scans.get(id);
  if (scan === undefined || core.nowMs() - scan.at > SCAN_TTL_MS) throw new HostConflictError('scan_needed', 'Test the connection again first');
  if (scan.fingerprint !== fingerprint) throw new HostConflictError('fingerprint_changed', 'The fingerprint is not the one the last test showed');
  core.repo.pin(id, fingerprint, core.now());
  core.scans.delete(id);
  if (core.fleet.executor(id) === undefined) core.fleet.addHost(id);
  else await core.fleet.replaceHost(id);
  core.log.info({ host: id, fingerprint }, 'hosts: host key pinned');
  core.audit('host.pin', id, `pinned the host key of ${id} (${fingerprint})`);
  core.feed.schedule();
  return core.dto(core.row(id));
}

type LinkOutcome = 'online' | 'auth' | 'hostkey' | 'unreachable';

/** Waits for the link to come up, or to stop on a refused key or a changed host key; `unreachable` after the wait. */
export function waitForLink(executor: RemoteExecutor, waitMs: number): Promise<LinkOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (outcome: LinkOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(outcome);
    };
    const look = (): void => {
      const error = executor.lastError?.() ?? null;
      if (executor.status() === 'online') settle('online');
      else if (error === 'auth' || error === 'hostkey') settle(error);
    };
    const timer = setTimeout(() => settle('unreachable'), waitMs);
    const off = executor.onStatus(look);
    look();
  });
}

function rememberPreflight(core: Core, row: HostRow, report: PreflightReport): void {
  if (report.kitAlias !== null) core.kitAlias.set(row.id, report.kitAlias);
  else core.kitAlias.delete(row.id);
  if (row.source !== 'web' || report.home === null || (row.projectsRoot !== null && row.homeDir !== null)) return;
  const projectsRoot = row.projectsRoot ?? `${report.home === '/' ? '' : report.home}/projects`;
  core.repo.fillFolders(row.id, { projectsRoot, homeDir: row.homeDir ?? report.home }, core.now());
  core.refresh.set(row.id, true);
}

async function checkSsh(core: Core, row: HostRow): Promise<HostCheckResult> {
  if (row.state !== 'pinned') throw new HostConflictError('host_not_pinned', 'Confirm the host key first');
  const executor = core.fleet.executor(row.id);
  if (executor === undefined) return { auth: 'unreachable', preflight: null, missing: [] };
  const error = executor.lastError?.() ?? null;
  if (error === 'auth' || error === 'hostkey') executor.resume?.();
  const outcome = await waitForLink(executor, core.deps.checkWaitMs ?? CHECK_WAIT_MS);
  core.log.info({ host: row.id, outcome }, 'hosts: link checked');
  core.feed.schedule();
  if (outcome === 'auth') return { auth: 'denied', preflight: null, missing: [], line: hostKeyDto(core.deps.fleetKey, core.deps.config.fleetFrom).line };
  if (outcome === 'hostkey') return { auth: 'hostkey-mismatch', preflight: null, missing: [] };
  if (outcome === 'unreachable') return { auth: 'unreachable', preflight: null, missing: [] };
  const stdout = await core.remote.preflight(row.id, { claudeBin: row.claudeBin, projectsRoot: row.projectsRoot });
  const report = parsePreflight(stdout, row.id, row.claudeBin ?? DEFAULT_CLAUDE);
  core.log.info({ host: row.id, ready: report.ready, missing: report.missing.length, kitVersion: report.kitVersion }, 'hosts: preflight');
  rememberPreflight(core, row, report);
  return { auth: 'ok', preflight: report.values, missing: [...report.missing] };
}

async function checkLocal(core: Core, row: HostRow): Promise<HostCheckResult> {
  const kit = core.localKit;
  const home = kit.home();
  const [found, alias, version] = await Promise.all([
    kit.preflight(row.claudeBin ?? core.deps.config.claudePath), kit.installedAlias(home), kit.installedVersion(home),
  ]);
  const report = localReport(found, {
    platform: kit.platform(), hostId: row.id, home, kitAlias: alias, kitVersion: version,
    projects: row.projectsRoot !== null && kit.folders.kind(row.projectsRoot) === 'dir',
  });
  if (alias !== null) core.kitAlias.set(row.id, alias);
  core.log.info({ host: row.id, ready: report.ready, missing: report.missing.length }, 'hosts: local preflight');
  core.feed.schedule();
  return { auth: 'ok', preflight: report.values, missing: [...report.missing] };
}

/** `check`: `ok` with the preflight, or `denied`, `unreachable` or `hostkey-mismatch`. */
export async function checkHost(core: Core, id: string): Promise<HostCheckResult> {
  const row = core.row(id);
  return row.kind === 'local' ? checkLocal(core, row) : checkSsh(core, row);
}
