import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createApiClient } from '../../src/api/client.js';
import { ApiProvider } from '../../src/api/context.js';
import { AuthProvider, type AuthValue } from '../../src/auth/AuthContext.js';
import { OfficePrefs } from '../../src/features/settings/OfficePrefs.js';
import '../../src/features/settings/settings.css';
import { AgencyPage } from '../../src/features/agency/AgencyPage.js';
import { PinProvider } from '../../src/pin/PinProvider.js';
import { StoreProvider } from '../../src/state/store.js';
import { PresenceReporter } from '../../src/state/usePresenceReporter.js';
import { Toasts } from '../../src/ui/Toasts.js';
import { DemoModal } from './demo-modal.js';
import type { FakeHub } from './fake-hub.js';
import { createDemoWs } from './fake-socket.js';

const AUTH: AuthValue = {
  me: { owner: 'owner@example.com', authMode: 'local', passkeys: 1, pinSet: true, csrf: 'demo' },
  refreshMe: async () => undefined,
  logout: async () => undefined,
  signalAuthLost: () => undefined,
};

/** Where the demo opens: the settings part (`?page=settings`), a drawer (`?open=accounts`) or the office. */
function entryOf(params: URLSearchParams): string {
  if (params.get('page') === 'settings') return '/settings';
  const open = params.get('open');
  return open === null ? '/' : `/?open=${open}`;
}

/**
 * The office demo's page (main.tsx mounts it, the demo tests render it): the real office page, its store and the real
 * API client, every request answered by the pretend hub and every live message from its socket.
 */
export function OfficeDemo({ hub, params }: { hub: FakeHub; params: URLSearchParams }) {
  const [api] = useState(() => createApiClient({ fetch: hub.fetch }));
  const [createWs] = useState(() => createDemoWs(hub));
  return (
    <ApiProvider api={api}>
      <MemoryRouter initialEntries={[entryOf(params)]}>
        <AuthProvider value={AUTH}>
          <StoreProvider createWs={createWs} onAuthLost={() => undefined}>
            <PresenceReporter />
            <PinProvider>
              <Routes>
                <Route path="/" element={<><AgencyPage /><DemoModal params={params} /></>} />
                {/* The office part of the settings page, alone (?page=settings). */}
                <Route path="/settings" element={<div className="page"><h1>Settings</h1><OfficePrefs /></div>} />
                <Route path="*" element={<p className="page">Left the office demo.</p>} />
              </Routes>
              <Toasts />
            </PinProvider>
          </StoreProvider>
        </AuthProvider>
      </MemoryRouter>
    </ApiProvider>
  );
}
