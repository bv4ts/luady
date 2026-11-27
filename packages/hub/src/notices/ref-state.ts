import type { ActionDTO, HostId, NoticeRef, QuestionDTO } from '@luady/shared';
import type { Clock } from '../core/contracts.js';
import type { RefState } from './fallback.js';

/**
 * A question's fallback waits for its server's first report since the hub started (so a question answered at the
 * terminal during a hub outage is not sent by mistake), but never longer than this after the start: a server that
 * never comes back must not keep the owner from hearing about it.
 */
export const REF_WAIT_MAX_MS = 2 * 60_000;

export interface RefStateDeps {
  clock: Clock;
  /** When the hub started, in ms. */
  startedAt: number;
  action: (id: string) => Pick<ActionDTO, 'status'> | undefined;
  question: (qid: string) => Pick<QuestionDTO, 'state' | 'host'> | undefined;
  /** The server's pending questions were compared with its kit since the hub started. */
  reconciled: (host: HostId) => boolean;
}

/** Is the question or confirmation a notice points to still waiting (fallback.ts)? */
export function createRefState(deps: RefStateDeps): (ref: NoticeRef) => RefState {
  return (ref) => {
    if (ref.kind === 'action') return deps.action(ref.id)?.status === 'pending_confirmation' ? 'open' : 'closed';
    const question = deps.question(ref.id);
    if (question === undefined || question.state !== 'pending') return 'closed';
    if (deps.reconciled(question.host)) return 'open';
    return deps.clock.now().getTime() - deps.startedAt >= REF_WAIT_MAX_MS ? 'open' : 'unknown';
  };
}
