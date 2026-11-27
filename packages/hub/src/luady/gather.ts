import type { Channel } from '@luady/shared';
import type { Clock } from '../core/contracts.js';

/** A burst of owner messages (text, then photos and files a second later) reaches Luady as ONE numbered prompt. */
export interface GatherOptions {
  /** Hold until the owner has been quiet this long… */
  quietMs: number;
  /** …but never hold the first message longer than this. */
  maxMs: number;
}

export const DEFAULT_GATHER: GatherOptions = { quietMs: 3_000, maxMs: 12_000 };

export interface Gatherer {
  push(text: string, channel: Channel): void;
  /** Hands over whatever is held now (hub stopping). */
  drain(): void;
}

interface Held {
  channel: Channel;
  texts: readonly string[];
  firstAt: number;
}

export function createGatherer(
  clock: Clock,
  options: GatherOptions,
  deliver: (texts: readonly string[], channel: Channel) => void,
): Gatherer {
  let held: Held | null = null;
  let timer: NodeJS.Timeout | null = null;

  function release(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const batch = held;
    held = null;
    if (batch !== null) deliver(batch.texts, batch.channel);
  }

  return {
    push(text, channel) {
      if (held !== null && held.channel !== channel) release();
      const now = clock.now().getTime();
      held = held === null ? { channel, texts: [text], firstAt: now } : { ...held, texts: [...held.texts, text] };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(release, Math.max(0, Math.min(options.quietMs, held.firstAt + options.maxMs - now)));
    },
    drain: release,
  };
}
