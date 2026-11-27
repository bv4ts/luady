import type { SessionDTO } from '@luady/shared';
import { useCallback } from 'react';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { sessionLabel } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import { COMPACT_TEXT, canCompact } from '../model/compact.js';

/**
 * "Compact now": types `/compact` into the session, which shortens its context, and says so in a
 * toast. `offer` is true from 60% context in use, for a session that can take a message.
 */
export function useCompact(session: SessionDTO | undefined) {
  const api = useApi();
  const { state, toast } = useStore();
  const pct = session === undefined ? null : (state.activity[session.id]?.contextPct ?? null);
  const offer = session !== undefined && canCompact(session, pct);
  const compact = useCallback(async () => {
    if (session === undefined) return;
    try {
      await api.sendToSession(session.id, { text: COMPACT_TEXT });
      toast('success', `Compacting ${sessionLabel(session)}: it shortens its context and carries on.`);
    } catch (err) {
      toast('error', userMessage(err));
    }
  }, [api, session, toast]);
  return { offer, pct, compact };
}
