import type { Dispatch } from 'react';
import { useStore } from '../../../state/store.js';
import { limitsNote } from '../drawers/account-text.js';
import { accountOfHost, shortLimits } from '../model/limits.js';
import type { AgencyUiAction } from '../model/ui-state.js';

/** The room's account limit ("5h 62% · week 41%", or why there is none); opens Accounts and limits. Hidden without accounts. */
export function AccountLine({ host, dispatch }: { host: string; dispatch: Dispatch<AgencyUiAction> }) {
  const { state } = useStore();
  const account = accountOfHost(state.accounts?.accounts, host);
  if (account === null) return null;
  const text = shortLimits(account, Date.now()) ?? limitsNote(account.limits) ?? 'Limits not reported right now.';
  return (
    <button type="button" className="agency-account-line" onClick={() => dispatch({ type: 'open', panel: 'accounts' })}>
      <span className="agency-account-line__lead">Account</span>
      <span>{text}</span>
    </button>
  );
}
