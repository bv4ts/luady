import type { HostRemoveOutcome, HostRemoveResultDTO } from '@luady/shared';
import { errorMessage } from '../fleet/executor.js';
import { uninstallArgs } from '../fleet/fixed-scripts.js';
import type { Core } from './core.js';
import { HostConflictError } from './errors.js';
import { manualKeyRemoval } from './key-line.js';
import type { HostRow } from './repo.js';
import type { HostRemoveBody } from './validate.js';

/**
 * Removing a host, in this order, each step reporting its own outcome: uninstall the kit, remove the
 * key line, close the link, write the tombstone, apply the rooms rule. History is kept and the id is never reused. An
 * unreachable server does not stop the removal: it completes here, and the note says what is left on the server and
 * gives the fixed command that removes the key line by hand.
 */
export type StepOutcome = HostRemoveOutcome;

/** The uninstall inside a removal may take this long; after it the removal goes on and its note says what is left. */
export const REMOVE_UNINSTALL_TIMEOUT_MS = 30_000;

/** Resolves with the work's outcome, or `failed` once the time is up (the work's own timeout ends it on the server). */
function bounded(work: Promise<StepOutcome>, ms: number): Promise<StepOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<StepOutcome>((resolve) => {
    timer = setTimeout(() => resolve('failed'), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
/** HostRemoveResultDTO (shared): `note` says what is left to do; `keyCommand` removes the key line by hand. */
export type HostRemoveResult = HostRemoveResultDTO;

async function uninstallWork(core: Core, row: HostRow, timeoutMs: number): Promise<StepOutcome> {
  try {
    if (row.kind === 'local') {
      await core.localKit.uninstall(() => undefined, { timeoutMs });
      return 'done';
    }
    const outcome = await core.remote.kit(row.id, uninstallArgs(), await core.payload(), () => undefined, { timeoutMs });
    return outcome.code === 0 && outcome.summary !== null ? 'done' : 'failed';
  } catch (err) {
    core.log.warn({ host: row.id, err: errorMessage(err).slice(0, 200) }, 'hosts: kit uninstall during removal failed');
    return 'failed';
  }
}

async function uninstallStep(core: Core, row: HostRow, reachable: boolean): Promise<StepOutcome> {
  if (!reachable) return 'unreachable';
  const ms = core.deps.removeUninstallMs ?? REMOVE_UNINSTALL_TIMEOUT_MS;
  const outcome = await bounded(uninstallWork(core, row, ms), ms + 1_000);
  if (outcome === 'failed') core.log.warn({ host: row.id }, 'hosts: the kit uninstall during removal did not finish');
  return outcome;
}

async function keyStep(core: Core, row: HostRow, reachable: boolean): Promise<StepOutcome> {
  if (!reachable) return 'unreachable';
  try {
    await core.remote.removeKey(row.id, core.deps.fleetKey.blob);
    return 'done';
  } catch (err) {
    core.log.warn({ host: row.id, err: errorMessage(err).slice(0, 200) }, 'hosts: key-remove during removal failed');
    return 'failed';
  }
}

function noteFor(id: string, kit: StepOutcome, key: StepOutcome): string | null {
  const left = [
    kit === 'unreachable' || kit === 'failed' ? 'the kit' : null,
    key === 'unreachable' || key === 'failed' ? "the hub's key line" : null,
  ].filter((item): item is string => item !== null);
  if (left.length === 0) return null;
  const why = kit === 'unreachable' || key === 'unreachable' ? `The hub could not reach ${id}` : `Not everything could be removed from ${id}`;
  return `${why}, so ${left.join(' and ')} may still be on it. ${id} was removed here and its history is kept.`
    + (key === 'unreachable' || key === 'failed' ? ' To remove the key line yourself, run the command below on the server.' : '');
}

export async function removeHost(core: Core, id: string, body: Pick<HostRemoveBody, 'uninstallKit' | 'removeKey' | 'rooms'>): Promise<HostRemoveResult> {
  const row = core.row(id);
  if (row.source === 'config') throw new HostConflictError('host_from_config', `${id} comes from config.json: remove it there, then restart the hub`);
  if (core.jobs.running(id)) throw new HostConflictError('job_running', `A kit job is running on ${id}; wait for it to finish`);
  const reachable = row.kind === 'local' || (row.state === 'pinned' && core.fleet.link(id) === 'online');
  const kit = body.uninstallKit ? await uninstallStep(core, row, reachable) : 'skipped';
  const key = row.kind === 'local' || !body.removeKey ? 'skipped' : await keyStep(core, row, reachable);
  await core.fleet.removeHost(id);
  core.repo.tombstone(id, core.now());
  core.grants.revokeHost(id);
  core.scans.delete(id);
  core.kitAlias.delete(id);
  core.kitVersion.delete(id);
  core.deps.rooms?.()?.deleteRoomsOfHost(id, body.rooms);
  core.log.info({ host: id, kit, key, rooms: body.rooms }, 'hosts: host removed');
  core.audit('host.remove', id, `removed ${id} (kit ${kit}, key line ${key}, rooms ${body.rooms === 'delete' ? 'deleted' : 'kept'})`);
  core.feed.flush();
  const manual = key === 'unreachable' || key === 'failed';
  return {
    host: id,
    steps: { kit, key, link: 'closed', record: 'removed', rooms: body.rooms === 'delete' ? 'deleted' : 'kept' },
    note: noteFor(id, kit, key),
    keyCommand: manual ? manualKeyRemoval(core.deps.fleetKey) : null,
  };
}
