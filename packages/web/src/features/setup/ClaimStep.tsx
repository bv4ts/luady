import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { SetupStateDTO } from '@luady/shared';
import { useState } from 'react';
import { isApiError, userMessage } from '../../api/errors.js';
import { PIN_PURPOSE, PinSetupForm } from '../../auth/PinSetupPage.js';
import { LoginLinkHelp, PasskeyClaimForm } from '../../auth/SignedOutPage.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { useSetupApi } from './context.js';
import { SetupFrame } from './SetupFrame.js';

const REMOTE_NOTE = 'This hub can be reached from other machines, so a passkey is required before anything else. Login links are off.';

function NoPasskeyBrowser({ remote }: { remote: boolean }) {
  return (
    <Banner tone="warn">
      {remote ? "This browser can't make passkeys. Open Luady in Chrome, Edge or Firefox." : "This browser can't make passkeys. Use a login link instead (below)."}
    </Banner>
  );
}

/** Claim, for a visitor who is not signed in: a passkey with the setup code, or the login-link way. */
export function ClaimScreen({ state, onRegistered }: { state: SetupStateDTO; onRegistered: (setupCode: string) => Promise<void> }) {
  const supported = browserSupportsWebAuthn();
  return (
    <SetupFrame screen="claim" state={state} title="Claim this install" testId="setup-claim"
      intro={<p>When Luady started, it printed a one-time setup code in its terminal. Only someone at that terminal can claim this install.</p>}>
      {state.remote ? <Banner tone="warn">{REMOTE_NOTE}</Banner> : null}
      {!supported ? <NoPasskeyBrowser remote={state.remote} /> : null}
      <section className="setup-choice stack" aria-labelledby="claim-passkey">
        <h2 id="claim-passkey" className="setup-choice__title">Create a passkey <span className="setup-tag">Recommended</span></h2>
        <p className="text-muted">A passkey signs you in with this device's fingerprint, face or screen lock.</p>
        <PasskeyClaimForm disabled={!supported} onRegistered={onRegistered} submitLabel="Create a passkey" />
      </section>
      {state.remote ? null : (
        <section className="setup-choice stack" aria-labelledby="claim-link">
          <h2 id="claim-link" className="setup-choice__title">No passkey? Use a login link</h2>
          <LoginLinkHelp remote={false} />
          <p className="text-muted">It also prints the setup code: you need it to choose your PIN next.</p>
        </section>
      )}
    </SetupFrame>
  );
}

/**
 * Claim, after a login link signed this browser in: add a passkey (recommended), or skip it. The skip is the hub's to
 * allow (a link session, on this computer, never on a remote install); the install is claimed once the PIN is set.
 */
export function LinkedClaimScreen({ state, onRegistered, onSkipped }: {
  state: SetupStateDTO; onRegistered: (setupCode: string) => Promise<void>; onSkipped: (next: SetupStateDTO) => void;
}) {
  const api = useSetupApi();
  const supported = browserSupportsWebAuthn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function skip() {
    if (api === null) return;
    setBusy(true);
    setError(null);
    try {
      onSkipped(await api.step({ step: 'passkey', action: 'skip' }));
    } catch (err) {
      setBusy(false);
      // The hub's refusal (403) says why in plain words; it is not a failed sign-in check.
      setError(`${isApiError(err, 'forbidden') ? err.message : userMessage(err)} You can still add a passkey above.`);
    }
  }

  return (
    <SetupFrame screen="claim" state={state} title="Add a passkey?" testId="setup-claim-linked"
      intro={<p>You are signed in with a login link. A passkey makes the next sign-in one tap; you can also add one later in Settings.</p>}>
      {state.remote ? <Banner tone="warn">{REMOTE_NOTE}</Banner> : null}
      {!supported ? <NoPasskeyBrowser remote={state.remote} /> : null}
      <section className="setup-choice stack" aria-labelledby="linked-passkey">
        <h2 id="linked-passkey" className="setup-choice__title">Add a passkey <span className="setup-tag">Recommended</span></h2>
        <p className="text-muted">Use the setup code that <code>npm run luady -- login</code> printed.</p>
        <PasskeyClaimForm disabled={!supported} onRegistered={onRegistered} submitLabel="Add a passkey" />
      </section>
      {state.remote ? null : (
        <section className="setup-choice stack" aria-labelledby="linked-skip">
          <h2 id="linked-skip" className="setup-choice__title">Skip for now</h2>
          <p className="text-muted">Without a passkey you sign in with <code>npm run luady -- login</code> each time, on this computer only.</p>
          {error !== null ? <Banner tone="error">{error}</Banner> : null}
          <Button variant="secondary" busy={busy} disabled={api === null} data-testid="setup-skip-passkey" onClick={() => void skip()}>Skip for now</Button>
        </section>
      )}
    </SetupFrame>
  );
}

/** The first PIN: it always needs the setup code, even after a login link. */
export function PinScreen({ state, setupCode, onDone, onCodeRejected }: {
  state: SetupStateDTO; setupCode: string | null; onDone: () => Promise<void>; onCodeRejected: () => void;
}) {
  return (
    <SetupFrame screen="pin" state={state} title="Choose a PIN" testId="setup-pin"
      intro={<p>{PIN_PURPOSE} Use 6 to 12 digits you do not use elsewhere.</p>}>
      {setupCode === null ? <p className="text-muted">You also need the setup code from the terminal where Luady runs.</p> : null}
      <PinSetupForm setupCode={setupCode} onDone={onDone} onCodeRejected={onCodeRejected} />
    </SetupFrame>
  );
}
