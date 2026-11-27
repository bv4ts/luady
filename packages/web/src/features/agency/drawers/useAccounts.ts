import type { AccountsDTO } from '@luady/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError } from '../../../api/errors.js';
import { reportError } from '../../../lib/report.js';
import { useStore } from '../../../state/store.js';

/** An older hub has no accounts route: retrying cannot help. */
export const ACCOUNTS_MISSING = 'This hub cannot list accounts yet. Update Luady to see them here.';

export interface AccountsState {
  readonly accounts: AccountsDTO | null;
  readonly loading: boolean;
  /** Set when the last load failed (an older hub answers 404). */
  readonly error: string | null;
  reload(): Promise<void>;
}

/**
 * The accounts list in the store (the energy bar and the agent meters read it there). Loads on mount and whenever an
 * `accounts.changed` arrives; mount it once per page.
 */
export function useAccounts(): AccountsState {
  const api = useApi();
  const { state, dispatch } = useStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      dispatch({ type: 'accounts.loaded', accounts: await api.accounts() });
      setError(null);
    } catch (err) {
      const missing = isApiError(err) && err.status === 404;
      if (!missing) reportError('accounts', err);
      setError(missing ? ACCOUNTS_MISSING : 'The accounts could not load.');
    } finally {
      setLoading(false);
    }
  }, [api, dispatch]);

  const version = state.accountsVersion;
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const accounts = state.accounts;
  return useMemo(() => ({ accounts, loading, error, reload }), [accounts, loading, error, reload]);
}
