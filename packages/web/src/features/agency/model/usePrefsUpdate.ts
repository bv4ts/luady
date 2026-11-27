import { mergeWebPrefs, type UpdateWebPrefsBody } from '@luady/shared';
import { useCallback } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError, userMessage } from '../../../api/errors.js';
import { useStore } from '../../../state/store.js';

/** How a change of the website preferences ended. 'here': the hub cannot keep it yet, so it holds on this page only. */
export type PrefsOutcome = 'saved' | 'here' | 'failed';

/** An older hub (404) or one whose preferences are not built yet (501). */
const notThereYet = (err: unknown): boolean => isApiError(err) && (err.status === 404 || err.status === 501);

/**
 * Changes the website preferences (sound, day and night) at once on this page, then on the hub so every device
 * agrees. When the hub cannot keep them yet the change stays on this page; any other refusal puts it back and says so.
 */
export function usePrefsUpdate(): (patch: UpdateWebPrefsBody) => Promise<PrefsOutcome> {
  const api = useApi();
  const { state, dispatch, toast } = useStore();
  const current = state.prefs.value;
  return useCallback(async (patch: UpdateWebPrefsBody) => {
    const before = current;
    dispatch({ type: 'prefs.loaded', prefs: mergeWebPrefs(before, patch) });
    try {
      dispatch({ type: 'prefs.loaded', prefs: await api.updatePrefs(patch) });
      return 'saved';
    } catch (err) {
      if (notThereYet(err)) return 'here';
      dispatch({ type: 'prefs.loaded', prefs: before });
      toast('error', userMessage(err));
      return 'failed';
    }
  }, [api, current, dispatch, toast]);
}
