import { TARGET_RE, isSelfHost, type CtlPane, type HostId } from '@luady/shared';
import type { Clock, EventBus, Fleet, Logger } from '../core/contracts.js';
import { isoNow } from '../core/time.js';
import { projectFor } from './naming.js';
import { createSessionRow, type SessionRow } from './registry.js';
import { toSessionDto, type SessionsRepo } from './repo.js';

export const RECONCILE_INTERVAL_MS = 15_000;
/** Rows with activity this close to the snapshot are left to events, not to the snapshot. */
export const RECONCILE_SKEW_MS = 10_000;

export interface ReconcileInput {
  host: HostId;
  rows: readonly SessionRow[];
  panes: readonly CtlPane[];
  nowIso: string;
  fetchStartedIso: string;
}

export interface ReconcilePlan {
  changed: SessionRow[];
  ended: SessionRow[];
}

function rowFromPane(host: HostId, pane: CtlPane, nowIso: string): SessionRow {
  const base = createSessionRow({ host, target: pane.target, createdAt: nowIso, origin: isSelfHost(host) ? 'system' : 'owner', cwd: pane.cwd });
  return {
    ...base,
    claudeSessionId: pane.session_id,
    transcriptPath: pane.transcript_path,
    registered: pane.registered,
    pendingQid: pane.pending_qid,
    state: pane.pending_qid === null ? 'idle' : 'waiting_question',
  };
}

function enrich(row: SessionRow, pane: CtlPane): SessionRow | null {
  const next: SessionRow = {
    ...row,
    claudeSessionId: row.claudeSessionId ?? pane.session_id,
    transcriptPath: row.transcriptPath ?? pane.transcript_path,
    registered: row.registered || pane.registered,
    cwd: row.cwd ?? pane.cwd,
    project: row.project ?? projectFor(pane.cwd),
  };
  const unchanged = next.claudeSessionId === row.claudeSessionId && next.transcriptPath === row.transcriptPath
    && next.registered === row.registered && next.cwd === row.cwd;
  return unchanged ? null : next;
}

/** Pure: unknown Claude panes become rows; live rows whose pane vanished (and that are quiet) end unexpectedly. */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const live = input.panes.filter((pane) => pane.is_claude && TARGET_RE.test(pane.target));
  const byTarget = new Map(input.rows.map((row) => [row.tmuxTarget, row] as const));
  const changed = live.flatMap((pane) => {
    const row = byTarget.get(pane.target);
    const next = row === undefined ? rowFromPane(input.host, pane, input.nowIso) : enrich(row, pane);
    return next === null ? [] : [next];
  });
  const liveTargets = new Set(live.map((pane) => pane.target));
  const cutoff = Date.parse(input.fetchStartedIso) - RECONCILE_SKEW_MS;
  const ended = input.rows
    .filter((row) => row.state !== 'ended' && !liveTargets.has(row.tmuxTarget))
    .filter((row) => Date.parse(row.lastEventAt ?? row.createdAt) < cutoff)
    .map((row): SessionRow => ({ ...row, state: 'ended', unexpectedEnd: true, pendingQid: null, turnStartedAt: null, turnRemote: false }));
  return { changed, ended };
}

export interface SessionReconcilerDeps {
  repo: SessionsRepo;
  bus: EventBus;
  clock: Clock;
  fleet: Fleet;
  log: Logger;
  /** Every `sessions()` reply, right after it arrives, with the time it was asked for (the pause service re-reads its flags). */
  onPanes?: (host: HostId, panes: readonly CtlPane[], requestedAt: string) => void;
  /** After every pass over all hosts (the activity service sweeps records of sessions that are gone). */
  afterReconcile?: () => void;
}

export function createSessionReconciler(deps: SessionReconcilerDeps): { runAll(): Promise<void> } {
  let running = false;

  async function runHost(host: HostId): Promise<void> {
    const fetchStartedIso = isoNow(deps.clock);
    const { sessions } = await deps.fleet.client(host).sessions();
    deps.onPanes?.(host, sessions, fetchStartedIso);
    const plan = planReconcile({ host, rows: deps.repo.listByHost(host), panes: sessions, nowIso: isoNow(deps.clock), fetchStartedIso });
    for (const row of plan.changed) {
      deps.repo.save(row);
      deps.bus.emit('session.updated', toSessionDto(row));
    }
    for (const row of plan.ended) {
      deps.repo.save(row);
      const session = toSessionDto(row);
      deps.bus.emit('session.updated', session);
      deps.bus.emit('session.ended', { session, unexpected: true, reason: 'pane_gone', replay: false });
    }
  }

  return {
    async runAll() {
      if (running) return;
      running = true;
      try {
        // Every host the fleet lists (the self host only while the manager is switched on), servers only while online.
        const online = new Set(deps.fleet.servers().filter((server) => server.status === 'online').map((server) => server.name));
        const hosts: HostId[] = deps.fleet.hosts().filter((host) => isSelfHost(host) || online.has(host));
        for (const host of hosts) {
          try {
            await runHost(host);
          } catch (err) {
            deps.log.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'session reconciliation failed');
          }
        }
        deps.afterReconcile?.();
      } finally {
        running = false;
      }
    },
  };
}
