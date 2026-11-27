/**
 * Chunk painting in animation-frame slices: each frame runs the queued jobs nearest the view centre
 * first, as many as fit in SLICE_MS of their declared work. Generic: a job is a key, a priority, an estimated cost and
 * a function; the chunk bank fills it. A Web Worker could take `run`'s pure part (see paintChunk).
 */

/** The longest slice of painting per frame, in ms. */
export const SLICE_MS = 8;

export interface PaintJob {
  /** One job per key: enqueuing the same key again replaces it. */
  readonly key: string;
  /** Smaller runs first: the distance from the view centre. */
  readonly priority: number;
  /** The work it declares, in ms (an estimate from the paints so far). */
  readonly cost: number;
  run(): void;
}

export interface PaintQueue {
  enqueue(job: PaintJob): void;
  has(key: string): boolean;
  cancel(key: string): void;
  /** Drops every job whose key `keep` refuses (work for chunks the view has left). */
  retain(keep: (key: string) => boolean): void;
  /**
   * Runs jobs nearest first while the slice's work stays within `budgetMs`: a job whose declared cost would take the
   * slice past it waits for the next frame, and so does everything once the clock says the budget is spent. The first
   * job of a slice always runs, so a job larger than a slice still gets done. Returns how many jobs ran.
   */
  slice(budgetMs?: number): number;
  size(): number;
  clear(): void;
}

/** `clock` in ms (performance.now by default); `onError` hears a job that threw (the queue goes on). */
export function createPaintQueue(clock: () => number = () => performance.now(), onError: (error: unknown) => void = () => undefined): PaintQueue {
  const jobs = new Map<string, PaintJob>();

  const nearest = (): PaintJob | undefined => {
    let best: PaintJob | undefined;
    jobs.forEach((job) => {
      if (best === undefined || job.priority < best.priority || (job.priority === best.priority && job.key < best.key)) best = job;
    });
    return best;
  };

  return {
    enqueue: (job) => { jobs.set(job.key, job); },
    has: (key) => jobs.has(key),
    cancel: (key) => { jobs.delete(key); },
    retain: (keep) => {
      [...jobs.keys()].forEach((key) => { if (!keep(key)) jobs.delete(key); });
    },
    slice: (budgetMs = SLICE_MS) => {
      const start = clock();
      let declared = 0;
      let ran = 0;
      for (let next = nearest(); next !== undefined; next = nearest()) {
        const spent = Math.max(declared, clock() - start);
        if (ran > 0 && spent + next.cost > budgetMs) break;
        jobs.delete(next.key);
        declared += next.cost;
        ran += 1;
        try {
          next.run();
        } catch (error) {
          onError(error);
        }
      }
      return ran;
    },
    size: () => jobs.size,
    clear: () => jobs.clear(),
  };
}
