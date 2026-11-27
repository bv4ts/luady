import type { ReactElement } from 'react';
import { NavLink } from 'react-router';
import type { WsStatus } from '../api/ws.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Icon } from '../ui/Icon.js';
import { OfficeIcon } from './OfficeIcon.js';
import { managerName } from '@luady/shared';

interface NavItem {
  readonly to: string;
  /** A function, so the manager's display name is read at render (the settings load sets it after start). */
  readonly label: () => string;
  readonly icon: ReactElement;
  /** The e2e selects nav links only by these ids. */
  readonly testId: string;
  /** Shows the count of what waits for the owner. */
  readonly pending?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { to: '/', label: () => 'Office', icon: <OfficeIcon />, testId: 'nav-office' },
  { to: '/inbox', label: () => 'Inbox', icon: <Icon name="inbox" />, testId: 'nav-inbox', pending: true },
  { to: '/sessions', label: () => 'Sessions', icon: <Icon name="sessions" />, testId: 'nav-sessions' },
  { to: '/manager', label: managerName, icon: <Icon name="manager" />, testId: 'nav-manager' },
  { to: '/servers', label: () => 'Servers', icon: <Icon name="server" />, testId: 'nav-servers' },
  { to: '/settings', label: () => 'Settings', icon: <Icon name="settings" />, testId: 'nav-settings' },
];

const CONNECTION_LABEL: Readonly<Record<WsStatus, string>> = {
  idle: 'Starting…', connecting: 'Connecting…', open: 'Live', reconnecting: 'Reconnecting…', stopped: 'Offline',
};

export function NavBar({ pending, connection }: { pending: number; connection: WsStatus }) {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__brand"><BrandMark size={32} /><span className="nav__name">Luady</span></div>
      <ul className="nav__list">
        {ITEMS.map((item) => {
          const badge = item.pending === true && pending > 0;
          return (
            <li key={item.to}>
              <NavLink to={item.to} end={item.to === '/'} className="nav__link" data-testid={item.testId}>
                <span className="nav__icon">
                  {item.icon}
                  {badge ? <span className="count nav__count" aria-hidden="true">{pending > 99 ? '99+' : pending}</span> : null}
                </span>
                <span className="nav__label">{item.label()}</span>
                {badge ? <span className="visually-hidden">, {pending} waiting</span> : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <p className="nav__status">
        <span className={connection === 'open' ? 'dot dot--on' : 'dot'} aria-hidden="true" />
        {CONNECTION_LABEL[connection]}
      </p>
    </nav>
  );
}
