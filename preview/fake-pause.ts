import type { CtlPause, CtlResume } from '@luady/shared';
import type { CtlClient } from '../packages/hub/dist/core/contracts.js';

/** What kit 2 types into a session the pause had stopped. */
export const RESUME_TEXT = 'The owner has lifted the pause. Continue from where you paused.';

/** Per-pane pause flags like kit 2's `~/.luady/pause/*` files: target → whether the pause already stopped the session. */
export interface PauseFlags {
  isPaused(target: string): boolean;
  /** The after-tool check stopped the pane: the flag is now `hit`. */
  hit(target: string): void;
  drop(target: string): void;
}

export interface PauseVerbDeps {
  /** Throws not_found for an unknown pane, like the kit. */
  requirePane(target: string): unknown;
  /** True when the pane exists and has no pending question (the kit types only then). */
  canType(target: string): boolean;
  /** Writes the resume text into the pane (transcript and send listeners). */
  type(target: string, text: string): void;
}

export function createPauseFlags(): PauseFlags & { verbs(deps: PauseVerbDeps): Pick<CtlClient, 'pause' | 'resume'> } {
  let flags: ReadonlyMap<string, boolean> = new Map();
  const without = (target: string): ReadonlyMap<string, boolean> => new Map([...flags].filter(([key]) => key !== target));

  return {
    isPaused: (target) => flags.has(target),
    hit(target) {
      if (flags.has(target)) flags = new Map([...flags, [target, true]]);
    },
    drop(target) {
      flags = without(target);
    },
    verbs: (deps) => ({
      pause: async (target): Promise<CtlPause> => {
        deps.requirePane(target);
        if (!flags.has(target)) flags = new Map([...flags, [target, false]]);
        return { ok: true, paused: true };
      },
      resume: async (target): Promise<CtlResume> => {
        const wasHit = flags.get(target) === true;
        flags = without(target);
        const sent = wasHit && deps.canType(target);
        if (sent) deps.type(target, RESUME_TEXT);
        return { ok: true, was_hit: wasHit, sent };
      },
    }),
  };
}
