import type { ConnectionDTO, Settings } from '@luady/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { Badge } from '../../ui/Badge.js';
import { Banner } from '../../ui/Banner.js';
import { Switch } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import type { Tone } from '../../ui/tones.js';
import { ChannelsSection } from '../channels/ChannelsSection.js';
import { ConnectServices } from '../channels/ConnectServices.js';
import { ManagerSwitch } from '../settings/ManagerSwitch.js';
import { NIGHTLY_SWITCHES, type NightlyKey } from '../settings/general-settings.js';
import { StepButtons } from './StepButtons.js';

/** The five nightly switches, as they stand: all off on a new install; never ticked for the owner. */
export function NightlySwitches() {
  const api = useApi();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<NightlyKey | null>(null);
  useEffect(() => {
    let live = true;
    api.settings().then((read) => { if (live) setSettings(read); }, (err: unknown) => { if (live) setError(userMessage(err)); });
    return () => {
      live = false;
    };
  }, [api]);

  async function flip(key: NightlyKey, on: boolean) {
    setSaving(key);
    setError(null);
    try {
      setSettings(await api.updateSettings({ [key]: on }));
    } catch (err) {
      setError(`${userMessage(err)} Nothing was changed.`);
    } finally {
      setSaving(null);
    }
  }

  if (settings === null) return error !== null ? <Banner tone="error">{error}</Banner> : <Spinner label="Loading the nightly jobs" />;
  return (
    <div className="stack" data-testid="setup-nightly">
      {NIGHTLY_SWITCHES.map((item) => (
        <Switch key={item.key} label={item.label} description={`${item.line(settings)}${item.needsManager ? ' Needs the manager.' : ''}`}
          checked={settings[item.key]} disabled={saving !== null} onChange={(next) => void flip(item.key, next)} />
      ))}
      {error !== null ? <Banner tone="error">{error}</Banner> : null}
    </div>
  );
}

const CONNECTION_TONE: Readonly<Record<ConnectionDTO['state'], Tone>> = { connected: 'idle', not_connected: 'ended', unavailable: 'ended' };
const CONNECTION_STATE: Readonly<Record<ConnectionDTO['state'], string>> = { connected: 'Connected', not_connected: 'Not connected', unavailable: 'Not set up' };

/** How to switch each optional module on, in one line. */
const HOW_TO: Readonly<Record<string, string>> = {
  google: 'Add your Google app keys to secrets.env and restart Luady, then press Connect below.',
  wispr: 'Press Connect below and approve it on Wispr Flow.',
  imap: 'Add the IMAP lines to secrets.env and restart Luady.',
  jira: "Connect Jira from a room's Jira panel in the office.",
};

/** The optional modules with their state and, when off, how to switch them on. */
export function OptionalModules() {
  const api = useApi();
  const [rows, setRows] = useState<readonly ConnectionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.accounts().then((read) => { if (live) setRows(read.connections); }, (err: unknown) => { if (live) setError(userMessage(err)); });
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <div className="stack" data-testid="setup-modules">
      {error !== null ? <p className="text-muted">The list of optional modules could not load ({error}). You can see it later in Settings.</p> : null}
      {rows === null && error === null ? <Spinner label="Loading the optional modules" /> : null}
      {rows !== null ? (
        <ul className="setup-modules">
          {rows.map((row) => (
            <li key={`${row.id}-${row.label}`} className="setup-module">
              <span className="setup-module__name">{row.label}</span>
              <Badge tone={CONNECTION_TONE[row.state]}>{CONNECTION_STATE[row.state]}</Badge>
              {row.state === 'connected' ? null : <span className="text-muted setup-module__how">{HOW_TO[row.id] ?? 'See its guide in the add-on folder.'}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      <ConnectServices />
    </div>
  );
}

/**
 * The extras step's body: everything here is optional and starts off. The manager's box is
 * unticked with plain words on what it may touch; the nightly jobs are off; channels and modules say how to add them.
 */
export function SetupExtrasBody({ onNext, fromSettings = false }: { onNext: (action: 'done' | 'skip') => void; fromSettings?: boolean }) {
  return (
    <div className="stack stack--lg">
      <section className="setup-choice stack" aria-labelledby="extras-manager">
        <h2 id="extras-manager" className="setup-choice__title">The manager</h2>
        <ManagerSwitch wizard />
      </section>
      <section className="setup-choice stack" aria-labelledby="extras-nightly">
        <h2 id="extras-nightly" className="setup-choice__title">Nightly jobs</h2>
        <p className="text-muted">All off. Each runs at night only if you switch it on.</p>
        <NightlySwitches />
      </section>
      <section className="setup-choice stack" aria-labelledby="extras-channels">
        <h2 id="extras-channels" className="setup-choice__title">Chat channels</h2>
        <ChannelsSection compact />
      </section>
      <section className="setup-choice stack" aria-labelledby="extras-modules">
        <h2 id="extras-modules" className="setup-choice__title">Optional modules</h2>
        <OptionalModules />
      </section>
      <StepButtons onNext={() => onNext('done')} onSkip={() => onNext('skip')} fromSettings={fromSettings} />
    </div>
  );
}
