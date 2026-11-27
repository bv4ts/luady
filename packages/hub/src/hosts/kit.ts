import type { HostJobDTO } from '@luady/shared';
import { errorMessage } from '../fleet/executor.js';
import { installArgs, uninstallArgs } from '../fleet/fixed-scripts.js';
import type { Core } from './core.js';
import { HostConflictError } from './errors.js';
import { JobFailure, cleanLine, type JobContext } from './kit-job.js';
import type { HostRow } from './repo.js';
import type { KitOutcome, KitSummaryLite } from './runners.js';

/**
 * The kit job's work: install, update or uninstall through the fixed `kit` script (an SSH
 * host) or the local installer (this computer). The installer's JSON never reaches the page raw: its summary becomes a
 * few plain lines. Then the versions are read again and `hosts.changed` goes out.
 */
export type KitMode = 'install' | 'update' | 'uninstall';

const EXIT_TEXT: Readonly<Record<number, string>> = Object.freeze({
  69: 'Python 3 was not found on the server. Install python3 (3.10 or later), then try again.',
  70: 'The server could not make a temporary folder (mktemp). Check its disk and /tmp, then try again.',
  71: 'The kit could not be unpacked on the server (tar). Check that tar is installed and the disk has room, then try again.',
});

/** The plain-words failure of one kit run. */
export function kitFailureText(outcome: KitOutcome): string {
  if (outcome.error !== null) return `The installer said: ${cleanLine(outcome.error)}`;
  if (outcome.code === null) return 'The install did not finish in time, or the connection dropped. Try again.';
  const known = EXIT_TEXT[outcome.code];
  if (known !== undefined) return known;
  return outcome.code === 0
    ? 'The installer gave no summary. Check the log above, then try again.'
    : `The installer stopped (exit ${outcome.code}). Check the log above, then try again.`;
}

/** What a summary says, as lines the owner can read. */
export function summaryLines(host: string, summary: KitSummaryLite): string[] {
  if (summary.action === 'uninstall') return [`The kit's hooks were removed from Claude Code on ${host}; its folder ~/.luady was kept.`];
  return [
    `Kit ${summary.version ?? ''} installed for ${summary.host_alias ?? host}.`.replace('  ', ' '),
    summary.settings === null || summary.settings === undefined
      ? 'Claude Code settings were left as they were.'
      : `Claude Code hooks were added${summary.backup ? '; a backup of its settings was kept' : ''}.`,
    ...(summary.statusline === undefined ? [] : [`Status line: ${cleanLine(summary.statusline)}.`]),
  ];
}

/** Lines from the installer: its JSON lines are left out (the summary shows instead), the rest is cleaned. */
function shown(ctx: JobContext): (line: string) => void {
  return (line) => {
    if (!line.trim().startsWith('{')) ctx.line(line);
  };
}

async function refreshVersions(core: Core, id: string): Promise<void> {
  if (core.refresh.get(id) === true) {
    // A check filled in the folders: the link is rebuilt from the row, and reads the versions when it is back.
    core.refresh.delete(id);
    await core.fleet.replaceHost(id);
    return;
  }
  try {
    const version = await core.fleet.client(id).version();
    core.versions.setVersions(id, version.kit, version.claude);
    core.kitVersion.delete(id);
  } catch (err) {
    core.log.warn({ host: id, err: errorMessage(err).slice(0, 200) }, 'hosts: luady-ctl version after the kit job failed');
  }
}

async function runSsh(core: Core, row: HostRow, mode: KitMode, ctx: JobContext): Promise<KitSummaryLite> {
  ctx.line(mode === 'uninstall' ? `Removing the kit from ${row.id}.` : `Sending the kit to ${row.id}.`);
  const payload = await core.payload();
  core.log.info({ host: row.id, mode, sha256: payload.sha256, bytes: payload.bytes.length }, 'hosts: kit payload');
  const args = mode === 'uninstall' ? uninstallArgs() : installArgs({ alias: row.id, projectsRoot: row.projectsRoot, claudeBin: row.claudeBin });
  ctx.line('Running the installer.');
  const outcome = await core.remote.kit(row.id, args, payload, shown(ctx));
  if (outcome.code !== 0 || outcome.summary === null) throw new JobFailure(kitFailureText(outcome));
  return outcome.summary;
}

async function runLocal(core: Core, row: HostRow, mode: KitMode, ctx: JobContext): Promise<KitSummaryLite> {
  ctx.line(mode === 'uninstall' ? 'Removing the kit from this computer.' : 'Installing the kit on this computer.');
  try {
    if (mode === 'uninstall') return await core.localKit.uninstall(shown(ctx));
    const projectsRoot = row.projectsRoot ?? `${core.localKit.home()}/projects`;
    return await core.localKit.install({ projectsRoot, claudeBin: row.claudeBin ?? core.deps.config.claudePath }, shown(ctx));
  } catch (err) {
    throw new JobFailure(cleanLine(errorMessage(err)));
  }
}

async function work(core: Core, row: HostRow, mode: KitMode, ctx: JobContext): Promise<string> {
  const summary = row.kind === 'local' ? await runLocal(core, row, mode, ctx) : await runSsh(core, row, mode, ctx);
  for (const line of summaryLines(row.id, summary)) ctx.line(line);
  core.kitVersion.set(row.id, mode === 'uninstall' ? null : summary.version ?? null);
  if (mode !== 'uninstall') core.kitAlias.set(row.id, summary.host_alias ?? row.id);
  if (mode !== 'uninstall') await refreshVersions(core, row.id);
  core.log.info({ host: row.id, mode, version: summary.version ?? null }, 'hosts: kit job done');
  core.audit('host.kit', row.id, `${mode} the kit on ${row.id}`, summary.version ?? 'done');
  core.feed.schedule();
  return mode === 'uninstall'
    ? `The kit was removed from ${row.id}.`
    : `Kit ${summary.version ?? ''} is on ${row.id}. New sessions there appear in the office; sessions already running appear after the hub restarts.`;
}

/** Starts the kit job of a pinned host (202); an SSH host must be online. */
export function startKit(core: Core, id: string, mode: KitMode): HostJobDTO {
  const row = core.row(id);
  if (row.state !== 'pinned') throw new HostConflictError('host_not_pinned', 'Confirm the host key and check the connection first');
  if (row.kind === 'ssh' && core.fleet.link(id) !== 'online') throw new HostConflictError('host_offline', `${id} is not connected; check the connection first`);
  return core.jobs.start(id, (ctx) => work(core, row, mode, ctx));
}
