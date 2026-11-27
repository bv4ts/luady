import type { MeDTO, OverviewDTO } from '@luady/shared';
import { act, render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi, type Mock } from 'vitest';
import { ApiProvider } from '../../src/api/context.js';
import { AuthProvider, type AuthValue } from '../../src/auth/AuthContext.js';
import { PinProvider } from '../../src/pin/PinProvider.js';
import { StoreProvider } from '../../src/state/store.js';
import { Toasts } from '../../src/ui/Toasts.js';
import { me as meFixture, overview as overviewFixture } from '../fixtures.js';
import { fakeApi, type FakeApi } from './fake-api.js';
import { createFakeWs, type FakeWs } from './fake-ws.js';

export interface PageOptions {
  readonly api?: FakeApi;
  readonly overview?: OverviewDTO;
  readonly me?: MeDTO;
  /** One entry or a history stack; the last entry is the current location. */
  readonly route?: string | readonly string[];
  readonly path?: string;
}

export interface FakeAuth extends AuthValue {
  readonly refreshMe: Mock<() => Promise<void>>;
  readonly logout: Mock<() => Promise<void>>;
  readonly signalAuthLost: Mock<() => void>;
}

export interface PageHarness extends RenderResult {
  readonly api: FakeApi;
  readonly ws: FakeWs;
  readonly auth: FakeAuth;
  readonly user: ReturnType<typeof userEvent.setup>;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

export async function renderPage(ui: ReactElement, options: PageOptions = {}): Promise<PageHarness> {
  const api = options.api ?? fakeApi();
  api.overview.mockResolvedValue(options.overview ?? overviewFixture());
  const ws = createFakeWs();
  const auth: FakeAuth = {
    me: options.me ?? meFixture(),
    refreshMe: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    signalAuthLost: vi.fn(),
  };
  const entries = typeof options.route === 'string' ? [options.route] : [...(options.route ?? ['/'])];
  const user = userEvent.setup();
  const result = render(
    <ApiProvider api={api}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <AuthProvider value={auth}>
          <StoreProvider createWs={ws.factory} onAuthLost={auth.signalAuthLost}>
            <PinProvider>
              <Routes>
                <Route path={options.path ?? '*'} element={ui} />
                {options.path ? <Route path="*" element={null} /> : null}
              </Routes>
              <LocationProbe />
              <Toasts />
            </PinProvider>
          </StoreProvider>
        </AuthProvider>
      </MemoryRouter>
    </ApiProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { ...result, api, ws, auth, user };
}
