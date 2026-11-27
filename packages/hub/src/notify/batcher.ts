import type { Clock, Logger, OutboundChannel, OutboundLink } from '../core/contracts.js';
import { formatBatch } from './format.js';
import { BATCH_WINDOW_MS, recentSends, shouldHold, type NoticeKind } from './policy.js';

export interface BatchItem {
  kind: NoticeKind;
  text: string;
  line: string;
  link: OutboundLink | null;
}

export interface BatcherDeps {
  clock: Clock;
  log: Logger;
  outbound: OutboundChannel;
}

export interface Batcher {
  push(item: BatchItem): Promise<void>;
  flush(): Promise<void>;
  stop(): void;
}

export function createBatcher(deps: BatcherDeps): Batcher {
  let sentAt: number[] = [];
  let held: BatchItem[] = [];
  let timer: NodeJS.Timeout | null = null;

  const nowMs = (): number => deps.clock.now().getTime();

  async function deliver(text: string, link: OutboundLink | null): Promise<void> {
    try {
      await deps.outbound.send(text, link);
    } catch (err) {
      deps.log.error({ err }, 'notify: outbound send failed');
    }
  }

  async function push(item: BatchItem): Promise<void> {
    const now = nowMs();
    sentAt = recentSends(sentAt, now);
    if (held.length > 0 || shouldHold(sentAt, now)) {
      held = [...held, item];
      if (timer === null) timer = setTimeout(() => void flush(), BATCH_WINDOW_MS);
      return;
    }
    sentAt = [...sentAt, now];
    await deliver(item.text, item.link);
  }

  async function flush(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const items = held;
    held = [];
    const first = items[0];
    if (!first) return;
    const now = nowMs();
    sentAt = [...recentSends(sentAt, now), now];
    if (items.length === 1) {
      await deliver(first.text, first.link);
      return;
    }
    await deliver(formatBatch(items.map((i) => i.line)), null);
  }

  function stop(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (held.length > 0) deps.log.warn({ dropped: held.length }, 'notify: dropped held notifications on stop');
    held = [];
  }

  return { push, flush, stop };
}
