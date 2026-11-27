import { isSelfHost, type AccountDTO, type AccountHostDTO } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../../../api/context.js';
import { Button } from '../../../ui/Button.js';
import { useRooms } from '../../rooms/useRooms.js';
import { accountTitle, hostLine, hostNameIn, whenText } from './account-text.js';
import { LimitBars } from './LimitBars.js';
import { LoginFlow } from './LoginFlow.js';
import { SignOutButton, type SignOutWords } from './SignOutButton.js';
import { managerName } from '@luady/shared';

function signOutWords(account: AccountDTO, host: AccountHostDTO, name: string): SignOutWords {
  const pinTitle = `Sign out ${name}`;
  if (account.isManager && isSelfHost(host.host)) {
    return {
      title: `Sign ${managerName()} out?`, body: `${managerName()} goes quiet until you sign in again. Messages you send meanwhile are kept and passed on.`, pinTitle,
      done: `Signed ${managerName()} out. He is quiet until you sign in again.`,
    };
  }
  return { title: `Sign ${name} out of Claude?`, body: 'Its sessions stop working until you sign in again.', pinTitle, done: `Signed ${name} out of Claude.` };
}

/** One server on the account: its sign-in in words, Log in (with the inline sign-in flow) and Log out. */
function HostRow({ account, host, now }: { account: AccountDTO; host: AccountHostDTO; now: Date }) {
  const api = useApi();
  const name = hostNameIn(host.host, useRooms());
  const [signingIn, setSigningIn] = useState(false);
  return (
    <li className="acct-host">
      <div className="acct-host__row">
        <span className="acct-host__line">{hostLine(host, now, name)}</span>
        <span className="acct-host__actions">
          <Button size="sm" variant={host.loggedIn === true ? 'ghost' : 'primary'} icon="key" data-testid="account-login"
            aria-expanded={signingIn} onClick={() => setSigningIn((open) => !open)}>
            {signingIn ? 'Close' : host.loggedIn === true ? 'Log in again' : 'Log in'}
          </Button>
          {host.canLogout && host.loggedIn !== false ? (
            <SignOutButton label="Log out" words={signOutWords(account, host, name)} call={(pin) => api.logoutAccount(host.host, { pin })} />
          ) : null}
        </span>
      </div>
      {signingIn ? <LoginFlow host={host.host} name={name} /> : null}
    </li>
  );
}

const updatedOf = (account: AccountDTO): string | null =>
  account.limits.updatedAt ?? account.hosts.map((h) => h.checkedAt).filter((at): at is string => at !== null).toSorted().at(-1) ?? null;

/** One Claude account: who, plan, the servers on it, both limits with their reset times, and when it was read. */
export function AccountCard({ account, now }: { account: AccountDTO; now: Date }) {
  const updated = updatedOf(account);
  return (
    <article className="acct" data-testid="account-card" aria-label={accountTitle(account)}>
      <header className="acct__head">
        <h3 className="acct__title" dir="auto">{accountTitle(account)}</h3>
        {account.plan === null ? null : <span className="acct__plan">{account.plan}</span>}
        {account.isManager ? <span className="acct__tag">{managerName()}</span> : null}
      </header>
      <ul className="acct__hosts">
        {account.hosts.map((host) => <HostRow key={host.host} account={account} host={host} now={now} />)}
      </ul>
      <LimitBars limits={account.limits} now={now} />
      {updated === null ? null : <p className="acct__updated">{`Updated ${whenText(updated, now)}`}</p>}
    </article>
  );
}
