import type { SessionDTO } from '@luady/shared';
import { PER_HOST_CONCURRENCY, forEachLimit, withTimeout } from '../core/concurrency.js';
import type { Fleet, Logger, SessionService } from '../core/contracts.js';
import { flatText } from '../hosts/clean.js';

/** Nightly, while the owner sleeps: update Claude Code on every server of the fleet. */
export const CLAUDE_UPDATE_TIME = '04:30';
/** Sessions still busy are retried every minute for this long, then left for the next update. */
export const BUSY_WAIT_MS = 150 * 60_000;
/** One server's `claude update` may take this long before it counts as failed (it does not hold up the others). */
export const UPDATE_TIMEOUT_MS = 10 * 60_000;

export interface ClaudeUpdaterDeps {
  /** Every host of `servers()` (SSH servers and this computer), never the manager's own. */
  fleet: Pick<Fleet, 'client' | 'servers'>;
  sessions: Pick<SessionService, 'list' | 'get' | 'restart'>;
  log: Logger;
  /** Tells Luady what happened (it mentions it in the morning brief). */
  report: (text: string) => Promise<void>;
}

export interface ClaudeUpdater {
  /** True when tonight's work is done; false to be called again a minute later (sessions still busy). */
  run(day: string, now: Date): Promise<boolean>;
}

interface Night {
  day: string;
  startedAt: number;
  notes: readonly string[];
  waiting: readonly string[];
  reopened: readonly string[];
}

const label = (s: SessionDTO): string => `${s.host} · ${s.displayName}`;
/** A server's own words (its error, the versions it reports) go into the manager's Event: flat, on one line, cleaned. */
const errorText = (err: unknown): string => flatText(err instanceof Error ? err.message : String(err), 200);
const VERSION_MAX = 40;
const versionText = (version: string | null | undefined, unknown: string): string => (version == null ? unknown : flatText(version, VERSION_MAX));

/**
 * `claude update` on every server; where the version changed, each IDLE session is reopened with --resume (same
 * conversation, new version). Busy sessions are reopened once they go idle, within BUSY_WAIT_MS.
 */
export function createClaudeUpdater(deps: ClaudeUpdaterDeps): ClaudeUpdater {
  let night: Night | null = null;

  /** Every server, PER_HOST_CONCURRENCY at once, each within UPDATE_TIMEOUT_MS; notes in the fleet's order. */
  async function update(day: string, now: Date): Promise<Night> {
    const servers = deps.fleet.servers().map((server) => server.name);
    const results = new Map<string, { note: string; waiting: readonly string[] }>();
    await forEachLimit(servers, PER_HOST_CONCURRENCY, async (server) => {
      try {
        const result = await withTimeout(deps.fleet.client(server).updateClaude(), UPDATE_TIMEOUT_MS, `claude update on ${server}`);
        if (result.before === result.after) {
          results.set(server, { note: `${server}: already on ${versionText(result.after, 'unknown')}`, waiting: [] });
          return;
        }
        const live = deps.sessions.list().filter((s) => s.host === server && s.state !== 'ended' && s.origin !== 'system');
        results.set(server, { note: `${server}: ${versionText(result.before, '?')} → ${versionText(result.after, '?')}`, waiting: live.map((s) => s.id) });
      } catch (err) {
        results.set(server, { note: `${server}: update failed (${errorText(err)})`, waiting: [] });
      }
    });
    const ordered = servers.flatMap((server) => results.get(server) ?? []);
    const notes = ordered.map((entry) => entry.note);
    deps.log.info({ notes }, 'claude: nightly update');
    return { day, startedAt: now.getTime(), notes, waiting: ordered.flatMap((entry) => entry.waiting), reopened: [] };
  }

  async function reopenIdle(current: Night): Promise<Night> {
    let waiting: readonly string[] = [];
    let reopened = current.reopened;
    let notes = current.notes;
    for (const id of current.waiting) {
      const session = deps.sessions.get(id);
      if (session === undefined || session.state === 'ended') continue;
      if (session.state !== 'idle') {
        waiting = [...waiting, id];
        continue;
      }
      try {
        await deps.sessions.restart(id);
        reopened = [...reopened, label(session)];
      } catch (err) {
        notes = [...notes, `${label(session)}: reopen failed (${errorText(err)})`];
      }
    }
    return { ...current, waiting, reopened, notes };
  }

  function summary(current: Night): string {
    const busy = current.waiting.map((id) => deps.sessions.get(id)).filter((s) => s !== undefined).map((s) => label(s!));
    return [
      `Nightly Claude Code update: ${current.notes.join('; ')}.`,
      current.reopened.length > 0 ? `Reopened idle sessions on the new version (same conversation): ${current.reopened.join(', ')}.` : '',
      busy.length > 0 ? `Still busy, left on the old version until their next restart: ${busy.join(', ')}.` : '',
      '(Nothing to do now. Mention it in one line in the morning brief only if something was updated or failed.)',
    ].filter(Boolean).join('\n');
  }

  return {
    async run(day, now) {
      if (night === null || night.day !== day) night = await update(day, now);
      night = await reopenIdle(night);
      const outOfTime = now.getTime() - night.startedAt >= BUSY_WAIT_MS;
      if (night.waiting.length > 0 && !outOfTime) return false;
      await deps.report(summary(night));
      return true;
    },
  };
}
