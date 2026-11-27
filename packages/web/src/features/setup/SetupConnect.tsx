import type { HostDTO } from '@luady/shared';
import { useState } from 'react';
import { LoginFlow } from '../agency/drawers/LoginFlow.js';
import { Badge } from '../../ui/Badge.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { HostsSection } from '../hosts/HostsSection.js';
import { useHostList } from '../hosts/store.js';
import { StepButtons } from './StepButtons.js';

/** Said before anything is connected (sessions run with permissions bypassed). */
export const BYPASS_WARNING =
  'Sessions that Luady starts run with permissions bypassed: Claude Code does not ask before it edits files or runs commands. Connect only machines and folders you are happy for it to change.';

function hostLabel(host: HostDTO): string {
  return host.kind === 'local' ? 'This computer' : host.id;
}

/** One machine's Claude sign-in: done, possible (the kit is there), or waiting for the kit. */
function SignInRow({ host }: { host: HostDTO }) {
  const [open, setOpen] = useState(false);
  const status = host.kitVersion === null
    ? <span className="text-muted">Install the kit first (Continue setup, above).</span>
    : host.claudeSignedIn === true
      ? <Badge tone="idle">Signed in to Claude</Badge>
      : <Button size="sm" variant="primary" data-testid={`setup-signin-${host.id}`} onClick={() => setOpen(true)}>Sign in to Claude</Button>;
  return (
    <li className="setup-signin stack">
      <div className="row">
        <strong>{hostLabel(host)}</strong>
        {open ? null : status}
      </div>
      {open ? <LoginFlow host={host.id} name={hostLabel(host)} /> : null}
    </li>
  );
}

/**
 * The connect step's body: each machine's link and kit (the hosts list, short form) and its Claude
 * sign-in. Claude's own credentials stay on the machine; the page only passes on the one-time sign-in code.
 */
export function SetupConnectBody({ onNext, fromSettings = false }: { onNext: (action: 'done' | 'skip') => void; fromSettings?: boolean }) {
  const list = useHostList();
  const pinned = (list.hosts ?? []).filter((host) => host.state === 'pinned');
  return (
    <div className="stack stack--lg">
      <Banner tone="warn"><span data-testid="setup-bypass-warning">{BYPASS_WARNING}</span></Banner>
      <section className="stack" aria-labelledby="setup-machines">
        <h2 id="setup-machines" className="setup-choice__title">Machines and their kit</h2>
        <HostsSection compact />
      </section>
      <section className="stack" aria-labelledby="setup-claude">
        <h2 id="setup-claude" className="setup-choice__title">Claude sign-in</h2>
        {pinned.length === 0
          ? <p className="text-muted">No machine is added yet. Add one in the rooms step, or later in Settings.</p>
          : <ul className="setup-signins">{pinned.map((host) => <SignInRow key={host.id} host={host} />)}</ul>}
      </section>
      <StepButtons onNext={pinned.length > 0 ? () => onNext('done') : null} onSkip={() => onNext('skip')} fromSettings={fromSettings} />
    </div>
  );
}
