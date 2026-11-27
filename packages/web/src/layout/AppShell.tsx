import { Outlet, useLocation } from 'react-router';
import { officeNoticeText } from '../features/agency/office-notice.js';
import { pendingCount } from '../state/selectors.js';
import { useStore } from '../state/store.js';
import { BrandMark } from '../ui/BrandMark.js';
import { NavBar } from './NavBar.js';
import { StatusBanners } from './StatusBanners.js';
import { managerName } from '@luady/shared';

/** Titles by path prefix; the manager's is read at render (the settings load sets the display name after start). */
const TITLES: ReadonlyArray<readonly [string, () => string]> = [
  ['/inbox', () => 'Inbox'], ['/sessions', () => 'Sessions'], ['/manager', managerName], ['/servers', () => 'Servers'],
  ['/settings', () => 'Settings'],
];

function titleFor(pathname: string): string {
  return TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1]() ?? 'Luady';
}

export function AppShell() {
  const { state } = useStore();
  const location = useLocation();
  const live = state.connection.status === 'open';

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <NavBar pending={pendingCount(state)} connection={state.connection.status} />
      <div className="app__body">
        <header className="topbar">
          <BrandMark size={28} />
          <span className="topbar__title">{titleFor(location.pathname)}</span>
          <span className={live ? 'dot dot--on' : 'dot'} role="img" aria-label={live ? 'Live' : 'Not connected'} />
        </header>
        <StatusBanners connection={state.connection.status} notice={officeNoticeText(location.state)} />
        <main id="main" className="app__main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
