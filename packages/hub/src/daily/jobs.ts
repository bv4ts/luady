import { mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Clock, Db, LuadyService, Logger, SettingsService } from '../core/contracts.js';
import { ownerDateKey, zoneOffsetMs } from '../scheduler/zone.js';
import { CLAUDE_UPDATE_TIME } from './claude-update.js';
import { buildDigestActivity, digestFile, digestPrompt } from './digest.js';
import { managerName } from '@luady/shared';

export const DAILY_TICK_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type JobName = 'graphify' | 'digest' | 'rotate' | 'tools' | 'claude' | 'brief';
/** The brief prompt starts with this; the reply router recognises it (luady/replies.ts:isMorningBrief). */
export const MORNING_BRIEF_PREFIX = 'Morning brief for ';
/** The owner's morning brief (meetings, important mail, to-dos, missions). */
export const BRIEF_TIME = '08:00';
/** The Codex CLI (for images) updates itself every night. */
export const TOOLS_UPDATE_TIME = '05:00';

interface Job {
  name: JobName;
  /** Its switch: a job that is off is never due, so switching it on inside its window still runs it. */
  enabled: () => boolean;
  /** "HH:MM" in owner time. */
  at: () => string;
  /** Minutes after `at` during which a missed or not-yet-possible run is still attempted. */
  windowMin: number;
  /** True when done for today; false to retry on the next tick (inside the window). */
  run: (now: Date) => Promise<boolean>;
}

export interface DailyJobsDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  settings: SettingsService;
  luady: LuadyService;
  brainDir: string;
  graphify: () => Promise<unknown>;
  /** Nightly tool self-updates (the Codex CLI). */
  updateTools?: () => Promise<unknown>;
  /** Morning brief data (markdown) or null to skip. */
  briefData?: () => Promise<string | null>;
  /** Nightly Claude Code update on every server; false = sessions still busy, call again next tick. */
  claudeUpdate?: (day: string, now: Date) => Promise<boolean>;
  /**
   * The manager switch: the digest, the brief and the rotation need the manager and skip while it is
   * off. The Claude Code update, the tools update and the code map run without it, each on its own switch. Absent: on.
   */
  managerReady?: () => boolean;
}

export interface DailyJobs {
  start(): void;
  stop(): void;
  /** One scheduling pass; exposed for tests. */
  tick(): Promise<void>;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function ownerMinutes(now: Date): number {
  const local = new Date(now.getTime() + zoneOffsetMs(now));
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** 02:00 graphify, 03:30 digest, 04:00 brain rotation, each at most once per owner day. */
export function createDailyJobs(deps: DailyJobsDeps): DailyJobs {
  const lastDay = deps.db.prepare<[string], { day: string }>('SELECT day FROM daily_runs WHERE job = ?');
  const markDone = deps.db.prepare<[string, string, string]>(
    'INSERT INTO daily_runs (job, day, ran_at) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET day = excluded.day, ran_at = excluded.ran_at',
  );
  const running = new Set<JobName>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function digest(now: Date): Promise<boolean> {
    const day = ownerDateKey(new Date(now.getTime() - DAY_MS));
    const activity = buildDigestActivity(deps.db, day);
    if (activity === null) {
      deps.log.info({ day }, 'digest: nothing happened, no AI run');
      return true;
    }
    const file = posix.join(deps.brainDir, digestFile(day));
    await mkdir(posix.dirname(file), { recursive: true });
    await writeFile(file, `# Activity on ${day} (owner time)\n\n${activity}\n`, { mode: 0o640 });
    await deps.luady.postEvent(digestPrompt(day), 'Scheduled');
    deps.log.info({ day, chars: activity.length }, `digest: handed to ${managerName()}`);
    return true;
  }

  async function brief(now: Date): Promise<boolean> {
    if (deps.briefData === undefined) return true;
    const data = await deps.briefData();
    if (data === null) return true;
    const day = ownerDateKey(now);
    const file = posix.join(deps.brainDir, 'brief', `${day}.md`);
    await mkdir(posix.dirname(file), { recursive: true });
    await writeFile(file, `# Morning data for ${day} (owner time)\n\n${data}\n`, { mode: 0o640 });
    await deps.luady.postEvent(
      `${MORNING_BRIEF_PREFIX}${day}: read brief/${day}.md and send the owner a short good-morning brief: meetings with times and links, `
        + 'important emails, today\'s to-dos and open missions. At most 8 short lines; skip empty parts.',
      'Scheduled',
    );
    return true;
  }

  async function rotate(): Promise<boolean> {
    if (deps.luady.rotate === undefined) return true;
    const rotated = await deps.luady.rotate();
    if (rotated) deps.log.info('luady: daily rotation, fresh session');
    return rotated;
  }

  const setting = deps.settings.get.bind(deps.settings);
  const manager = (): boolean => deps.managerReady?.() ?? true;
  // The five nightly switches: off on a new install, on after 016 on an existing one.
  const jobs: readonly Job[] = [
    { name: 'graphify', enabled: () => setting().graphify_enabled, at: () => setting().graphify_time, windowMin: 60, run: async () => { await deps.graphify(); return true; } },
    { name: 'digest', enabled: () => setting().digest_enabled && manager(), at: () => setting().digest_time, windowMin: 12 * 60, run: digest },
    { name: 'rotate', enabled: manager, at: () => setting().rotate_time, windowMin: 180, run: rotate },
    { name: 'tools', enabled: () => setting().tools_update_enabled, at: () => TOOLS_UPDATE_TIME, windowMin: 120, run: async () => { await deps.updateTools?.(); return true; } },
    { name: 'claude', enabled: () => setting().claude_update_enabled, at: () => CLAUDE_UPDATE_TIME, windowMin: 180, run: async (now) => deps.claudeUpdate?.(ownerDateKey(now), now) ?? true },
    { name: 'brief', enabled: () => setting().brief_enabled && manager(), at: () => BRIEF_TIME, windowMin: 120, run: brief },
  ];

  async function runJob(job: Job, now: Date, today: string): Promise<void> {
    running.add(job.name);
    try {
      if (await job.run(now)) markDone.run(job.name, today, now.toISOString());
    } catch (err) {
      markDone.run(job.name, today, now.toISOString());
      deps.log.error({ err, job: job.name }, 'daily job failed; next try tomorrow');
    } finally {
      running.delete(job.name);
    }
  }

  async function tick(): Promise<void> {
    const now = deps.clock.now();
    const today = ownerDateKey(now);
    const minutes = ownerMinutes(now);
    const due = jobs.filter((job) => {
      const late = minutes - minutesOf(job.at());
      return late >= 0 && late <= job.windowMin && !running.has(job.name) && lastDay.get(job.name)?.day !== today && job.enabled();
    });
    await Promise.all(due.map((job) => runJob(job, now, today)));
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        tick().catch((err: unknown) => deps.log.error({ err }, 'daily jobs tick failed'));
      }, DAILY_TICK_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
