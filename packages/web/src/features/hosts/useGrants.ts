import { useCallback, useMemo, useRef } from 'react';
import { isApiError } from '../../api/errors.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useHostsApi } from './context.js';

/**
 * The grants of one page: a PIN check gives a host's flow ten minutes without asking again. They are
 * kept in memory only, never in browser storage; after a reload, or once one runs out, the PIN is asked once more.
 */
export interface Grants {
  /** Runs `op` with the host's grant, asking for the PIN when there is none or it ran out; null when the owner cancels. */
  withGrant<T>(host: string, op: (grant: string) => Promise<T>): Promise<T | null>;
  remember(host: string, grant: string): void;
}

export function useGrants(): Grants {
  const api = useHostsApi();
  const { runPinned } = usePin();
  const held = useRef<ReadonlyMap<string, string>>(new Map());

  const remember = useCallback((host: string, grant: string) => {
    held.current = new Map([...held.current, [host, grant]]);
  }, []);

  const fresh = useCallback(async (host: string): Promise<string | null> => {
    const made = await runPinned(async (pin) => (await api.grant(host, mustPin(pin))).grant, {
      title: 'Confirm with your PIN', detail: `To go on with ${host}`, require: true,
    });
    if (made !== null) remember(host, made);
    return made;
  }, [api, remember, runPinned]);

  const withGrant = useCallback(async <T,>(host: string, op: (grant: string) => Promise<T>): Promise<T | null> => {
    const known = held.current.get(host);
    if (known !== undefined) {
      try {
        return await op(known);
      } catch (err) {
        if (!isApiError(err, 'grant_required')) throw err;
        held.current = new Map([...held.current].filter(([name]) => name !== host));
      }
    }
    const grant = await fresh(host);
    return grant === null ? null : op(grant);
  }, [fresh]);

  return useMemo(() => ({ withGrant, remember }), [withGrant, remember]);
}
