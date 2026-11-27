import type { MeDTO, SetupStateDTO } from '@luady/shared';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useApi } from '../api/context.js';
import { isApiError, userMessage } from '../api/errors.js';
import { ClaimScreen, LinkedClaimScreen, PinScreen } from '../features/setup/ClaimStep.js';
import { SetupStateProvider, useSetupApi, type SetupStateValue } from '../features/setup/context.js';
import { LOGIN_LINK_PATH } from '../features/setup/steps.js';
import { reportError } from '../lib/report.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Button } from '../ui/Button.js';
import { Spinner } from '../ui/Spinner.js';
import { AuthProvider, type AuthValue } from './AuthContext.js';
import { takeLinkToken, tokenOfHash } from './link-token.js';
import { LoginLinkPage } from './LoginLinkPage.js';
import { PinSetupPage } from './PinSetupPage.js';
import { SignedOutPage } from './SignedOutPage.js';
import './auth.css';

type GateState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous'; readonly setup: SetupStateDTO | null }
  | { readonly status: 'ready'; readonly me: MeDTO; readonly setup: SetupStateDTO | null }
  | { readonly status: 'error'; readonly message: string; readonly reload: boolean };

function ErrorScreen({ message, reload, onRetry }: { message: string; reload: boolean; onRetry: () => void }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <BrandMark size={44} />
        <div className="stack">
          <h1 className="auth-title">{reload ? 'Sign-in check failed' : "Can't reach Luady"}</h1>
          <p className="text-muted">{message}</p>
        </div>
        <Button variant="primary" className="btn--block" icon="restart" onClick={onRetry}>{reload ? 'Reload page' : 'Try again'}</Button>
      </div>
    </main>
  );
}

/**
 * The setup state and `/api/me`, read together. The state needs no sign-in; when it cannot be read (an
 * older hub, a hiccup) the gate goes on with `/api/me` alone.
 */
function useGateSession() {
  const api = useApi();
  const setupApi = useSetupApi();
  const [gate, setGate] = useState<GateState>({ status: 'loading' });

  const load = useCallback(async () => {
    const [setupRead, meRead] = await Promise.allSettled([setupApi === null ? Promise.resolve(null) : setupApi.state(), api.me()]);
    const setup = setupRead.status === 'fulfilled' ? setupRead.value : null;
    // A network failure shows through /api/me; anything else (a 5xx, a strange answer) is worth a note.
    if (setupRead.status === 'rejected' && !(isApiError(setupRead.reason) && setupRead.reason.status === 0)) reportError('setup state', setupRead.reason);
    if (meRead.status === 'fulfilled') return setGate({ status: 'ready', me: meRead.value, setup });
    const err: unknown = meRead.reason;
    if (isApiError(err) && err.status === 401) return setGate({ status: 'anonymous', setup });
    // 403 forbidden = Access/CSRF/Origin failure; only a full reload lets Cloudflare Access re-authenticate.
    return setGate({ status: 'error', message: userMessage(err), reload: isApiError(err, 'forbidden') });
  }, [api, setupApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      reportError('logout', err);
    }
    setGate((now) => ({ status: 'anonymous', setup: 'setup' in now ? now.setup : null }));
  }, [api]);

  const signalAuthLost = useCallback(() => setGate((now) => ({ status: 'anonymous', setup: 'setup' in now ? now.setup : null })), []);
  const retry = useCallback(() => {
    setGate({ status: 'loading' });
    void load();
  }, [load]);
  const apply = useCallback((next: SetupStateDTO) => {
    setGate((now) => (now.status === 'ready' || now.status === 'anonymous' ? { ...now, setup: next } : now));
  }, []);

  const me = gate.status === 'ready' ? gate.me : null;
  const value = useMemo<AuthValue | null>(
    () => (me ? { me, refreshMe: load, logout, signalAuthLost } : null),
    [me, load, logout, signalAuthLost],
  );
  const setup = gate.status === 'ready' || gate.status === 'anonymous' ? gate.setup : null;
  const setupValue = useMemo<SetupStateValue>(() => ({ state: setup, apply, refresh: load }), [setup, apply, load]);
  return { gate, load, retry, value, setupValue };
}

/** Whether the owner still has to choose a PIN: the hub's step says so, or, without a state, `/api/me` does. */
function needsPin(me: MeDTO, setup: SetupStateDTO | null): boolean {
  return setup === null ? !me.pinSet : setup.step === 'pin';
}

/**
 * The gate in front of the app: the setup state first, then the sign-in.
 *
 * - `/setup/login` is the login link's page (its token leaves the address bar on the first look).
 * - Unclaimed: the claim screen. Claimed but signed out: the sign-in (with the login-link way when not remote).
 * - Signed in: the claim screen of a login-link session, the PIN screen, or the app (which shows the later steps).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { gate, load, retry, value, setupValue } = useGateSession();
  const location = useLocation();
  const navigate = useNavigate();
  const setupApi = useSetupApi();
  const onLinkPage = location.pathname === LOGIN_LINK_PATH;
  // Taken from the address bar at once, before anything is drawn; kept in memory only, and only until it is spent.
  const [linkToken, setLinkToken] = useState(() => (onLinkPage ? takeLinkToken() ?? tokenOfHash(location.hash) : null));
  // The router's own copy of the address loses the fragment too.
  useEffect(() => {
    if (onLinkPage && location.hash !== '') navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [onLinkPage, location.hash, location.pathname, location.search, navigate]);
  const onTokenSpent = useCallback(() => setLinkToken(null), []);
  // First run: the one setup code lives only here, in memory (never Web Storage), until the PIN is saved.
  const [setupCode, setSetupCode] = useState<string | null>(null);
  const onRegistered = useCallback(async (code: string) => {
    setSetupCode(code);
    await load();
  }, [load]);
  const onPinSaved = useCallback(async () => {
    setSetupCode(null);
    await load();
  }, [load]);
  const onCodeRejected = useCallback(() => setSetupCode(null), []);
  const onLinkSignedIn = useCallback(async () => {
    await load();
    navigate('/', { replace: true });
  }, [load, navigate]);

  if (gate.status === 'loading') return <div className="full-screen-center"><Spinner size="lg" label="Loading Luady" /></div>;
  if (gate.status === 'error') {
    const onRetry = gate.reload ? () => window.location.reload() : retry;
    return <ErrorScreen message={gate.message} reload={gate.reload} onRetry={onRetry} />;
  }
  const setup = gate.setup;
  if (onLinkPage && setupApi !== null) {
    const pinNeeded = setup === null ? null : setup.step !== 'claim' && setup.step !== 'pin';
    return <LoginLinkPage api={setupApi} token={linkToken} pinNeeded={pinNeeded} onSignedIn={onLinkSignedIn} onTokenSpent={onTokenSpent} />;
  }
  if (!value) {
    if (setup !== null && !setup.claimed) return <ClaimScreen state={setup} onRegistered={onRegistered} />;
    return <SignedOutPage onSignedIn={load} onRegistered={onRegistered} setup={setup} />;
  }
  if (setup !== null && setup.step === 'claim') {
    return <LinkedClaimScreen state={setup} onRegistered={onRegistered} onSkipped={setupValue.apply} />;
  }
  if (needsPin(value.me, setup)) {
    return (
      <AuthProvider value={value}>
        {setup === null
          ? <PinSetupPage setupCode={setupCode} onDone={onPinSaved} onCodeRejected={onCodeRejected} />
          : <PinScreen state={setup} setupCode={setupCode} onDone={onPinSaved} onCodeRejected={onCodeRejected} />}
      </AuthProvider>
    );
  }
  return (
    <AuthProvider value={value}>
      <SetupStateProvider value={setupValue}>{children}</SetupStateProvider>
    </AuthProvider>
  );
}
