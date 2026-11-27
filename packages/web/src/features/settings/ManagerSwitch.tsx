import { SELF_HOST_ID, managerName } from '@luady/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { LoginFlow } from '../agency/drawers/LoginFlow.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Switch } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import { managerSwitchApi, type ManagerSwitchView } from './manager-switch-api.js';

export interface ManagerSwitchProps {
  /** In the setup wizard: unticked by default, with the plain words about what the manager may touch. */
  wizard?: boolean;
  onChange?(on: boolean): void;
}

/** What the manager may touch, said once, in plain words (the wizard and Settings show the same). */
export const MANAGER_PLAIN_WORDS =
  'Switched on, the manager acts with the rights of the user on each of your hosts. Without your PIN it reads files there, sends you files, runs read-only commands, and starts and messages sessions while it answers you; your PIN guards other commands, file writes, stopping sessions, and sessions it starts or messages at any other time. It reads mail and calendar only if you connect them. It uses your Claude plan (strongest model, effort high).';

/** While it sets itself up the page asks again this often. */
export const SWITCH_POLL_MS = 3_000;

function StepList({ view }: { view: ManagerSwitchView }) {
  return (
    <ul className="stack" aria-label="Setting up the manager">
      {view.steps.map((step) => (
        <li key={step.id} data-state={step.state}>
          {step.id}: {step.state}{step.detail === null ? '' : ` (${step.detail})`}
        </li>
      ))}
    </ul>
  );
}

function stateLine(view: ManagerSwitchView): string {
  switch (view.state) {
    case 'off': return 'Off.';
    case 'starting': return 'Setting itself up on this machine…';
    case 'on': return 'On.';
    case 'failed': return 'It could not finish setting itself up.';
  }
}

/** The view, refreshed while the manager sets itself up. */
function useSwitchView(): { view: ManagerSwitchView | null; error: string | null; refresh: () => void } {
  const [view, setView] = useState<ManagerSwitchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    managerSwitchApi.view().then(
      (next) => {
        if (!live) return;
        setView(next);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(userMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    if (view?.state !== 'starting') return undefined;
    const timer = setTimeout(refresh, SWITCH_POLL_MS);
    return () => clearTimeout(timer);
  }, [view, refresh]);
  return { view, error, refresh };
}

/**
 * The manager on or off: unticked on a new install. Ticked, the hub sets the manager up (its folder,
 * its own kit, its own tmux server); only then is its own Claude sign-in offered.
 */
export function ManagerSwitch({ wizard = false, onChange }: ManagerSwitchProps) {
  const api = useApi();
  const { view, error, refresh } = useSwitchView();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  async function toggle(on: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateSettings({ manager_enabled: on });
      onChange?.(on);
      if (!on) setSigningIn(false);
      refresh();
    } catch (err) {
      setSaveError(userMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (error !== null && view === null) return <div data-testid="manager-switch"><Banner tone="error">{error}</Banner></div>;
  if (view === null) return <div data-testid="manager-switch"><Spinner label="Loading the manager switch" /></div>;
  return (
    <div className="stack" data-testid="manager-switch" data-state={view.state}>
      <Switch label={`Use the manager (${managerName()})`} description={MANAGER_PLAIN_WORDS} checked={view.enabled} disabled={saving}
        onChange={(next) => void toggle(next)} />
      {wizard && !view.enabled ? <p className="text-subtle">You can switch it on later in Settings.</p> : null}
      {view.enabled ? <p className="text-subtle" role="status">{stateLine(view)}</p> : null}
      {view.enabled && (view.state === 'starting' || view.state === 'failed') ? <StepList view={view} /> : null}
      {saveError !== null ? <Banner tone="error">{saveError}</Banner> : null}
      {view.enabled && view.signIn && !signingIn ? (
        <Button variant="ghost" onClick={() => setSigningIn(true)}>Sign the manager in to Claude</Button>
      ) : null}
      {view.enabled && view.signIn && signingIn ? <LoginFlow host={SELF_HOST_ID} /> : null}
    </div>
  );
}
