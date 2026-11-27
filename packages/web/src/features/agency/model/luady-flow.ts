import { managerName } from '@luady/shared';
/**
 * What shows above Luady when the owner writes to him, as plain data: the "New message" pop, a note that he
 * is signed out or offline, the typing bubble while his turn runs, and his whole answer. Times are epoch ms.
 */

/** An answer stays this long unless the owner closes it or writes again. */
export const ANSWER_MS = 45_000;
/** His turn ended without a chat answer (he had nothing to say): the typing bubble goes after this. */
export const QUIET_GRACE_MS = 8_000;
/** A pop or typing bubble that never got an answer goes after this. */
export const WAIT_CAP_MS = 180_000;

/** The manager's state; `off` (switched off in Settings, how a new install starts) is calm and quiet, not "down". */
export type LuadyState = 'running' | 'busy' | 'starting' | 'down' | 'off';

export type LuadyFlow =
  | { readonly kind: 'idle' }
  /** The owner's message is on its way to him: an envelope and "New message". */
  | { readonly kind: 'sent'; readonly at: number }
  /** The hub kept the message: Luady is signed out. */
  | { readonly kind: 'held'; readonly at: number }
  /** Luady's brain is down; the message waits in his queue. */
  | { readonly kind: 'down'; readonly at: number }
  /** His turn runs. `quietSince`: his turn ended without an answer yet. */
  | { readonly kind: 'typing'; readonly at: number; readonly quietSince: number | null }
  /** His answer, shown whole. */
  | { readonly kind: 'answer'; readonly messageId: string; readonly until: number };

export type LuadyFlowEvent =
  | { readonly type: 'send'; readonly now: number; readonly luady: LuadyState | null }
  | { readonly type: 'held'; readonly now: number }
  | { readonly type: 'status'; readonly now: number; readonly luady: LuadyState }
  | { readonly type: 'reply'; readonly now: number; readonly messageId: string }
  | { readonly type: 'close' }
  | { readonly type: 'tick'; readonly now: number };

export const IDLE_FLOW: LuadyFlow = Object.freeze({ kind: 'idle' });

const waiting = (flow: LuadyFlow): flow is Extract<LuadyFlow, { kind: 'sent' | 'held' | 'down' | 'typing' }> =>
  flow.kind === 'sent' || flow.kind === 'held' || flow.kind === 'down' || flow.kind === 'typing';

function onStatus(flow: LuadyFlow, luady: LuadyState, now: number): LuadyFlow {
  // Switched off: nothing waits for him any more; an answer already shown stays until it expires.
  if (luady === 'off') return waiting(flow) ? IDLE_FLOW : flow;
  if (luady === 'busy') {
    if (flow.kind === 'typing') return flow.quietSince === null ? flow : { ...flow, quietSince: null };
    return waiting(flow) ? { kind: 'typing', at: now, quietSince: null } : flow;
  }
  if (flow.kind === 'typing') return flow.quietSince === null ? { ...flow, quietSince: now } : flow;
  if (flow.kind === 'sent' && luady === 'down') return { kind: 'down', at: flow.at };
  if (flow.kind === 'down' && luady === 'running') return { kind: 'sent', at: flow.at };
  return flow;
}

function onTick(flow: LuadyFlow, now: number): LuadyFlow {
  if (flow.kind === 'answer') return now >= flow.until ? IDLE_FLOW : flow;
  if (flow.kind === 'typing' && flow.quietSince !== null && now - flow.quietSince >= QUIET_GRACE_MS) return IDLE_FLOW;
  if ((flow.kind === 'sent' || flow.kind === 'typing') && now - flow.at >= WAIT_CAP_MS) return IDLE_FLOW;
  return flow;
}

export function reduceLuadyFlow(flow: LuadyFlow, event: LuadyFlowEvent): LuadyFlow {
  switch (event.type) {
    // Writing again closes the answer that is open: the new message is what matters now.
    case 'send':
      if (event.luady === 'off') return IDLE_FLOW;
      return event.luady === 'down' ? { kind: 'down', at: event.now } : { kind: 'sent', at: event.now };
    case 'held': return waiting(flow) ? { kind: 'held', at: event.now } : flow;
    case 'status': return onStatus(flow, event.luady, event.now);
    case 'reply': return { kind: 'answer', messageId: event.messageId, until: event.now + ANSWER_MS };
    case 'close': return flow.kind === 'idle' ? flow : IDLE_FLOW;
    case 'tick': return onTick(flow, event.now);
  }
}

/** When the flow changes by itself next (an answer expiring, a quiet turn ending); null when it waits on an event. */
export function nextFlowChange(flow: LuadyFlow): number | null {
  switch (flow.kind) {
    case 'answer': return flow.until;
    case 'typing': return flow.quietSince === null ? flow.at + WAIT_CAP_MS : Math.min(flow.quietSince + QUIET_GRACE_MS, flow.at + WAIT_CAP_MS);
    case 'sent': return flow.at + WAIT_CAP_MS;
    default: return null;
  }
}

/** The words of the small pop above Luady for the states that have one. */
export function flowWords(flow: LuadyFlow): string | null {
  switch (flow.kind) {
    case 'sent': return 'New message';
    case 'held': return `${managerName()} is signed out. He gets it when he is back.`;
    case 'down': return `${managerName()} is offline right now. He gets it when he is back.`;
    case 'typing': return `${managerName()} is typing`;
    default: return null;
  }
}
