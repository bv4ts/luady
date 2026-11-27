import { Link } from 'react-router';
import { sectionsIn, type SettingsSection } from './sections.js';
import './settings.css';

/** The office with the Accounts and limits drawer open (sign-ins, sign-outs and plan limits live there). */
export const ACCOUNTS_LINK = '/?open=accounts';

function Section({ section }: { section: SettingsSection }) {
  const Component = section.component;
  return <Component />;
}

/** The Settings page renders the registry (features/settings/sections.ts). */
export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1>Settings</h1>
          <p className="page-header__sub">Notifications, the office, rooms, servers, channels, security and the audit log.</p>
        </div>
        <Link className="btn btn--secondary" to={ACCOUNTS_LINK}>Accounts and limits</Link>
      </header>
      <div className="settings-grid">
        <div className="stack stack--lg">
          {sectionsIn('main').map((section) => <Section key={section.id} section={section} />)}
        </div>
        <div className="stack stack--lg">
          {sectionsIn('side').map((section) => <Section key={section.id} section={section} />)}
        </div>
      </div>
      {sectionsIn('wide').map((section) => <Section key={section.id} section={section} />)}
    </div>
  );
}
