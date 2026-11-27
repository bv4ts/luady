import { Suspense, lazy, useMemo } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';
import type { LuadyApi } from './api/client.js';
import { ApiProvider } from './api/context.js';
import { createSetupApi, type SetupApi } from './api/setup.js';
import { createWsClient, wsUrl } from './api/ws.js';
import { useAuth } from './auth/AuthContext.js';
import { AuthGate } from './auth/AuthGate.js';
import { OfficeBoundary } from './features/agency/OfficeBoundary.js';
import { CLASSIC_PATH, officeFallbackState } from './features/agency/office-notice.js';
import { InboxPage } from './features/inbox/InboxPage.js';
import { LuadyPage } from './features/luady/LuadyPage.js';
import { ServerDetailPage } from './features/servers/ServerDetailPage.js';
import { ServersPage } from './features/servers/ServersPage.js';
import { NewSessionPage } from './features/sessions/NewSessionPage.js';
import { SessionPage } from './features/sessions/SessionPage.js';
import { SessionsPage } from './features/sessions/SessionsPage.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { SetupApiProvider } from './features/setup/context.js';
import { SetupChanges, SetupGuard, SetupWizard } from './features/setup/SetupWizard.js';
import { AppShell } from './layout/AppShell.js';
import { PinProvider } from './pin/PinProvider.js';
import { StoreProvider, type CreateWs } from './state/store.js';
import { PresenceReporter } from './state/usePresenceReporter.js';
import { EmptyState } from './ui/EmptyState.js';
import { Spinner } from './ui/Spinner.js';
import { Toasts } from './ui/Toasts.js';

const TerminalPage = lazy(() => import('./features/terminal/TerminalPage.js').then((module) => ({ default: module.TerminalPage })));
const AgencyPage = lazy(() => import('./features/agency/AgencyPage.js').then((module) => ({ default: module.AgencyPage })));

export const createBrowserWs: CreateWs = (handlers) => createWsClient({ url: wsUrl('/ws'), ...handlers });

function NotFound() {
  return (
    <div className="page">
      <EmptyState icon="alert" title="Page not found" body="This address doesn't exist in Luady."
        action={<Link className="btn btn--secondary" to={CLASSIC_PATH}>Go to the inbox</Link>} />
    </div>
  );
}

function TerminalRoute() {
  return (
    <Suspense fallback={<div className="full-screen-center"><Spinner size="lg" label="Loading the terminal" /></div>}>
      <TerminalPage />
    </Suspense>
  );
}

/** The office is the home page; if its code cannot load or crashes, the owner lands on the classic Inbox. */
function OfficeRoute() {
  return (
    <OfficeBoundary fallback={<Navigate to={CLASSIC_PATH} replace state={officeFallbackState('office-crashed')} />}>
      <Suspense fallback={<div className="full-screen-center"><Spinner size="lg" label="Opening the office" /></div>}>
        <AgencyPage />
      </Suspense>
    </OfficeBoundary>
  );
}

function AuthedApp({ createWs }: { createWs: CreateWs }) {
  const { signalAuthLost } = useAuth();
  return (
    <StoreProvider createWs={createWs} onAuthLost={signalAuthLost}>
      <PresenceReporter />
      <SetupChanges />
      <PinProvider>
        <SetupGuard>
          <Routes>
            <Route path="setup/*" element={<SetupWizard />} />
            <Route path="terminal/:server" element={<TerminalRoute />} />
            <Route index element={<OfficeRoute />} />
            <Route element={<AppShell />}>
              <Route path="inbox" element={<InboxPage />} />
              <Route path="sessions" element={<SessionsPage />} />
              <Route path="sessions/new" element={<NewSessionPage />} />
              <Route path="sessions/:id" element={<SessionPage />} />
              <Route path="manager" element={<LuadyPage />} />
              <Route path="servers" element={<ServersPage />} />
              <Route path="servers/:name" element={<ServerDetailPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </SetupGuard>
        <Toasts />
      </PinProvider>
    </StoreProvider>
  );
}

/**
 * The website: the auth gate first (it reads the setup state before anything else: claim, sign-in, PIN), then the app,
 * which leads to the setup steps after the PIN until setup is done.
 */
export function App({ api, setupApi, createWs = createBrowserWs }: { api: LuadyApi; setupApi?: SetupApi; createWs?: CreateWs }) {
  const setup = useMemo(() => setupApi ?? createSetupApi({ csrf: () => api.csrf() }), [setupApi, api]);
  return (
    <ApiProvider api={api}>
      <SetupApiProvider api={setup}>
        <AuthGate>
          <AuthedApp createWs={createWs} />
        </AuthGate>
      </SetupApiProvider>
    </ApiProvider>
  );
}
