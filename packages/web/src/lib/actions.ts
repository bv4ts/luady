import type { ActionDTO } from '@luady/shared';
import type { ToastKind } from '../state/reducer.js';
import { truncate } from './format.js';

/** Confirmations expire after 30 minutes. */
export const ACTION_TTL_MS = 30 * 60 * 1000;

export function describeAction(action: ActionDTO): { kind: ToastKind; text: string } {
  switch (action.status) {
    case 'done':
      return { kind: 'success', text: action.result ? `#${action.id} done: ${truncate(action.result, 160)}` : `#${action.id} done: ${action.summary}` };
    case 'failed':
      return { kind: 'error', text: `#${action.id} failed: ${action.error ?? 'unknown error'}` };
    case 'denied':
      return { kind: 'info', text: `Cancelled #${action.id}` };
    case 'expired':
      return { kind: 'info', text: `#${action.id} expired` };
    case 'approved':
      return { kind: 'info', text: `#${action.id} approved, running now` };
    case 'pending_confirmation':
      return { kind: 'info', text: `#${action.id} is waiting for confirmation` };
  }
}

export function expiresIn(createdAt: string, now: number = Date.now()): string {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 'expiry unknown';
  const left = created + ACTION_TTL_MS - now;
  return left <= 0 ? 'expired' : `expires in ${Math.ceil(left / 60_000)}m`;
}
