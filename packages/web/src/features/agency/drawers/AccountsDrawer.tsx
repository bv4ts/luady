import { HQ_PALETTE } from '@luady/office';
import type { AccountDTO } from '@luady/shared';
import { useEffect, useState } from 'react';
import { Button } from '../../../ui/Button.js';
import { Spinner } from '../../../ui/Spinner.js';
import { PanelHead } from '../panels/PanelHead.js';
import { AccountCard } from './AccountCard.js';
import { CodexCard } from './CodexCard.js';
import { Connections } from './Connections.js';
import { ACCOUNTS_MISSING, type AccountsState } from './useAccounts.js';
import './drawers.css';

/** Luady's own account first, then the rest in the hub's order. */
const claudeAccounts = (accounts: readonly AccountDTO[]): readonly AccountDTO[] =>
  accounts.filter((a) => a.provider === 'claude').toSorted((a, b) => Number(b.isManager) - Number(a.isManager));

/** Accounts and limits: one card per Claude sign-in, then ChatGPT, then the other connections. */
export function AccountsDrawer({ accounts: state }: { accounts: AccountsState }) {
  const list = state.accounts;
  // The hub tells the page about limit changes at most every 30 seconds: opening the drawer reads them now.
  const [stale] = useState(() => state.accounts !== null);
  const { reload } = state;
  useEffect(() => {
    if (stale) void reload();
  }, [stale, reload]);
  const now = new Date();
  const codex = list?.accounts.find((a) => a.provider === 'codex') ?? null;
  return (
    <>
      <PanelHead title="Accounts and limits" palette={HQ_PALETTE}>Who each server is signed in as, and how full its limits are</PanelHead>
      <div className="agency-panel__body acct-drawer" data-testid="accounts-drawer">
        {list === null && state.loading ? <Spinner size="lg" label="Loading the accounts" /> : null}
        {state.error === null ? null : (
          <p className="acct__note" role="status">
            {state.error}{' '}
            {state.error === ACCOUNTS_MISSING ? null : (
              <Button size="sm" variant="secondary" disabled={state.loading} onClick={() => void state.reload()}>Try again</Button>
            )}
          </p>
        )}
        {list === null ? null : (
          <>
            {claudeAccounts(list.accounts).map((account) => <AccountCard key={account.id} account={account} now={now} />)}
            {codex === null ? null : <CodexCard account={codex} />}
            <Connections connections={list.connections} />
          </>
        )}
      </div>
    </>
  );
}
