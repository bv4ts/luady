import { randomBytes } from 'node:crypto';
import { LIMITS, type HostJobDTO } from '@luady/shared';
import type { Clock, EventBus, Logger } from '../core/contracts.js';
import { errorMessage } from '../fleet/executor.js';
import { cleanText } from './clean.js';
import { HostConflictError } from './errors.js';

/**
 * Kit jobs: one per host and three at a time overall. Each line goes out as `host.log` to
 * the sockets that follow the host; the end or the failure goes to everyone as `host.job`, and the latest job of each
 * host is kept so a page that reconnects can catch up (`GET /api/hosts/:id/job`). Lines are cleaned, bounded and never
 * written to the hub's log.
 */
export const JOBS_MAX_RUNNING = 3;
export const JOB_LINES_MAX = 2_000;
const GENERIC_FAILURE = 'The kit job stopped unexpectedly. Check the server, then try again.';

/** A failure whose message is already in plain words for the owner. */
export class JobFailure extends Error {}

export interface JobContext {
  /** One progress line for the page (cleaned and clipped here). */
  line(text: string): void;
}

/** The work of one job; resolves to the summary the page shows. */
export type JobWork = (ctx: JobContext) => Promise<string>;

export interface KitJobs {
  /** Starts a job now; 409 `job_running` for a host that has one, `jobs_busy` when three run. */
  start(host: string, work: JobWork): HostJobDTO;
  latest(host: string): HostJobDTO | undefined;
  running(host: string): boolean;
  /** Resolves when no job runs (the hub's stop, tests). */
  idle(): Promise<void>;
}

/** A line as the page may show it (hosts/clean.ts), at most LIMITS.hostLogLineMax characters. */
export function cleanLine(text: string): string {
  return cleanText(text, LIMITS.hostLogLineMax);
}

const clip = (text: string): string => (text.length <= LIMITS.hostSummaryMax ? text : `${text.slice(0, LIMITS.hostSummaryMax - 1)}…`);

export function createKitJobs(deps: { bus: EventBus; clock: Clock; log: Logger; maxRunning?: number }): KitJobs {
  const max = deps.maxRunning ?? JOBS_MAX_RUNNING;
  let latest: ReadonlyMap<string, HostJobDTO> = new Map();
  let active: ReadonlyMap<string, Promise<void>> = new Map();

  function record(host: string, dto: HostJobDTO): void {
    latest = new Map([...latest, [host, dto]]);
    deps.bus.emit('host.job', {
      host, job: dto.job, state: dto.state, ...(dto.summary === null ? {} : { summary: dto.summary }), ...(dto.error === null ? {} : { error: dto.error }),
    });
  }

  function context(host: string, job: string): JobContext {
    let sent = 0;
    return {
      line(text) {
        if (sent > JOB_LINES_MAX) return;
        sent += 1;
        const line = sent > JOB_LINES_MAX ? '… (more lines were not shown)' : cleanLine(text);
        if (line !== '') deps.bus.emit('host.log', { host, job, line, at: deps.clock.now().toISOString() });
      },
    };
  }

  async function run(host: string, job: string, work: JobWork): Promise<void> {
    try {
      const summary = clip(await work(context(host, job)));
      record(host, { job, state: 'done', summary, error: null });
    } catch (err) {
      const plain = err instanceof JobFailure ? clip(err.message) : GENERIC_FAILURE;
      // The outcome is logged; a server's own words (inside a JobFailure) never are.
      if (err instanceof JobFailure) deps.log.warn({ host, job }, 'hosts: a kit job failed');
      else deps.log.error({ host, job, err: errorMessage(err).slice(0, 300) }, 'hosts: a kit job failed');
      record(host, { job, state: 'failed', summary: null, error: plain });
    } finally {
      active = new Map([...active].filter(([key]) => key !== host));
    }
  }

  return {
    start(host, work) {
      if (active.has(host)) throw new HostConflictError('job_running', `A kit job is already running on ${host}`);
      if (active.size >= max) throw new HostConflictError('jobs_busy', `${max} kit jobs are running; try again when one finishes`);
      const job = `job-${randomBytes(6).toString('hex')}`;
      const dto: HostJobDTO = { job, state: 'running', summary: null, error: null };
      record(host, dto);
      active = new Map([...active, [host, run(host, job, work)]]);
      return dto;
    },
    latest: (host) => latest.get(host),
    running: (host) => active.has(host),
    async idle() {
      while (active.size > 0) await Promise.all([...active.values()]);
    },
  };
}
