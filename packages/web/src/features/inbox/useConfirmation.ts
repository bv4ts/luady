import { PIN_RE, type ActionDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../api/context.js';
import { isApiError, userMessage } from '../../api/errors.js';
import { describeAction } from '../../lib/actions.js';
import { pinNotice } from '../../pin/pin-notice.js';
import { useStore } from '../../state/store.js';

export type ConfirmBusy = 'approve' | 'deny' | null;

/** Card errors: PIN problems stay on the card (a lock disables Approve); a 409 means it was decided elsewhere. */
function useConfirmFailure(id: string) {
  const { dispatch, refresh, toast } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const fail = useCallback(async (err: unknown) => {
    const notice = pinNotice(err);
    if (notice) {
      setError(notice.message);
      setLocked(notice.kind === 'locked' || notice.kind === 'not_set');
    } else if (isApiError(err) && err.status === 409) {
      toast('info', `#${id} was already decided or has expired.`);
      dispatch({ type: 'action.removed', id });
      await refresh();
    } else {
      setError(userMessage(err));
    }
  }, [dispatch, id, refresh, toast]);

  return { error, setError, locked, fail };
}

/** Approve (tier 1, PIN typed on the card) or deny one pending confirmation. */
export function useConfirmation(action: ActionDTO) {
  const api = useApi();
  const { dispatch, toast } = useStore();
  const { error, setError, locked, fail } = useConfirmFailure(action.id);
  const [busy, setBusy] = useState<ConfirmBusy>(null);
  const { id } = action;

  const run = useCallback(async (kind: 'approve' | 'deny', call: () => Promise<ActionDTO>) => {
    setBusy(kind);
    setError(null);
    try {
      const result = await call();
      dispatch({ type: 'action.removed', id });
      const outcome = describeAction(result);
      toast(outcome.kind, outcome.text);
    } catch (err) {
      await fail(err);
    } finally {
      setBusy(null);
    }
  }, [dispatch, fail, id, setError, toast]);

  /** Resolves false when the PIN is malformed and nothing was sent. */
  const approve = useCallback(async (pin: string): Promise<boolean> => {
    if (!PIN_RE.test(pin)) {
      setError('Enter your 6–12 digit PIN.');
      return false;
    }
    await run('approve', () => api.confirmAction(id, { pin }));
    return true;
  }, [api, id, run, setError]);

  const deny = useCallback(() => run('deny', () => api.denyAction(id)), [api, id, run]);

  return { approve, deny, busy, error, locked };
}
