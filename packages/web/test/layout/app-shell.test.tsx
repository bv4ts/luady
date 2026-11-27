import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/api/errors.js';
import { action, me, overview, question } from '../fixtures.js';
import { fakeApi, type FakeApi } from '../helpers/fake-api.js';
import { createFakeWs } from '../helpers/fake-ws.js';
import { resetStageSpy } from '../features/agency/stage-mock.js';

vi.mock('../../src/features/agency/scene/AgencyStage.js', () => import('../features/agency/stage-mock.js'));

const OFFICE_LOAD_MS = 10_000;

function renderApp(api: FakeApi, route = '/inbox') {
  const ws = createFakeWs();
  const view = render(<MemoryRouter initialEntries={[route]}><App api={api} createWs={ws.factory} /></MemoryRouter>);
  return { ...view, ws, user: userEvent.setup() };
}

beforeEach(() => {
  resetStageSpy();
});

describe('App shell', () => {
  it('shows the inbox, the six sections and a live pending badge', async () => {
    const api = fakeApi({ me: async () => me(), overview: async () => overview({ questions: [question()], actions: [action()] }) });
    const { ws } = renderApp(api);
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByTestId('nav-inbox')).toBe(await within(nav).findByRole('link', { name: 'Inbox, 2 waiting' }));
    const sections = [
      ['nav-office', 'Office'], ['nav-sessions', 'Sessions'], ['nav-manager', 'Luady'], ['nav-servers', 'Servers'], ['nav-settings', 'Settings'],
    ] as const;
    for (const [testId, name] of sections) {
      expect(within(nav).getByTestId(testId)).toBe(within(nav).getByRole('link', { name }));
    }
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('data-testid')))
      .toEqual(['nav-office', 'nav-inbox', 'nav-sessions', 'nav-manager', 'nav-servers', 'nav-settings']);
    expect(within(nav).getByTestId('nav-office').getAttribute('href')).toBe('/');
    expect(within(nav).getByTestId('nav-inbox').getAttribute('href')).toBe('/inbox');
    ws.emit({ type: 'question.updated', question: question({ state: 'answered' }) });
    expect(within(nav).getByRole('link', { name: 'Inbox, 1 waiting' })).toBeTruthy();
  });

  it('marks the current section and navigates between pages', async () => {
    const api = fakeApi({ me: async () => me(), overview: async () => overview() });
    const { user } = renderApp(api);
    await screen.findByRole('heading', { name: 'Inbox' });
    await user.click(screen.getByTestId('nav-sessions'));
    expect(await screen.findByRole('heading', { name: 'Sessions' })).toBeTruthy();
    expect(screen.getByTestId('nav-sessions').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-inbox').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('nav-office').getAttribute('aria-current')).toBeNull();
    await user.click(screen.getByTestId('nav-inbox'));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByTestId('nav-inbox').getAttribute('aria-current')).toBe('page');
  });

  it('opens the office at / outside the shell, with a way to the classic view', async () => {
    const api = fakeApi({ me: async () => me(), overview: async () => overview(), luadyMessages: async () => ({ items: [], nextCursor: null }) });
    const { user } = renderApp(api, '/');
    // The office page is a lazy chunk: its first import (and transform) can take longer than findBy's default second.
    expect(await screen.findByTestId('agency-stage', {}, { timeout: OFFICE_LOAD_MS })).toBeTruthy();
    expect(screen.getByTestId('agency-page')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
    await user.click(screen.getByTestId('agency-classic-link'));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    await user.click(screen.getByTestId('nav-office'));
    expect(await screen.findByTestId('agency-stage')).toBeTruthy();
  });

  it('warns about a reconnecting socket and a primary chat channel that is down, never about having no channel', async () => {
    const api = fakeApi({ me: async () => me(), overview: async () => overview() });
    const { ws } = renderApp(api);
    await screen.findByRole('heading', { name: 'Inbox' });
    expect(screen.queryByText(/updates reach only this website/)).toBeNull();
    ws.emit({ type: 'channel.status', channel: {
      id: 'test-channel', kind: 'channel', name: 'Test chat', state: 'down', detail: null, since: null, primary: true, capabilities: null, panel: null,
    } });
    expect(await screen.findByText('Test chat is not connected, so updates reach only this website.')).toBeTruthy();
    ws.setStatus('reconnecting', 1);
    expect(screen.getByText(/Reconnecting to Luady/)).toBeTruthy();
  });

  it('shows the PIN screen instead of the app while no PIN is set', async () => {
    const api = fakeApi({ me: async () => me({ pinSet: false }), overview: async () => overview() });
    renderApp(api);
    expect(await screen.findByTestId('pin-new-input')).toBeTruthy();
    expect(screen.getByTestId('pin-confirm-input')).toBeTruthy();
    expect(screen.getByTestId('setup-code-input')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByTestId('nav-inbox')).toBeNull();
    expect(api.overview).not.toHaveBeenCalled();
  });

  it('shows the signed-out screen when there is no app session', async () => {
    const api = fakeApi({ me: async () => { throw new ApiError(401, 'auth', 'No session'); } });
    renderApp(api);
    const signIn = await screen.findByTestId('login-passkey-button');
    expect(signIn).toBe(screen.getByRole('button', { name: 'Sign in with passkey' }));
    expect(screen.getByTestId('setup-code-input')).toBeTruthy();
    expect(screen.queryByTestId('nav-inbox')).toBeNull();
  });

  it('shows a not-found page for unknown paths', async () => {
    const api = fakeApi({ me: async () => me(), overview: async () => overview() });
    renderApp(api, '/nowhere');
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the inbox' }).getAttribute('href')).toBe('/inbox');
  });

  it('starts main.tsx with the zod CSP switch', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    expect(source.split('\n').find((line) => line.startsWith('import '))).toBe("import './zod-csp.js';");
  });
});
