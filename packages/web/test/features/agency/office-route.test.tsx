import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/App.js';
import { me } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { createFakeWs } from '../../helpers/fake-ws.js';
import { fleetOverview } from './agency-fixtures.js';
import { resetStageSpy, stageProps, stageSpy } from './stage-mock.js';

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('./stage-mock.js'));

const WEBGL_NOTICE = 'The office view needs WebGL, which this browser does not offer. Showing the classic view.';

function renderOffice() {
  const api = fakeApi({
    me: async () => me(), overview: async () => fleetOverview(), luadyMessages: async () => ({ items: [], nextCursor: null }),
  });
  const ws = createFakeWs();
  render(<MemoryRouter initialEntries={['/']}><App api={api} createWs={ws.factory} /></MemoryRouter>);
  return { api, ws, user: userEvent.setup() };
}

// The office page is a lazy chunk; loading it once here keeps the first test's 1-second wait about rendering, not compiling.
beforeAll(async () => {
  await import('../../../src/features/agency/AgencyPage.js');
});

beforeEach(() => {
  resetStageSpy();
});

describe('the office route', () => {
  it('renders the stage with the live snapshot and a classic view link to /inbox', async () => {
    renderOffice();
    const stage = await screen.findByTestId('agency-stage');
    await vi.waitFor(() => expect(stage.getAttribute('data-actors')).toBe('5'));
    const classic = screen.getByTestId('agency-classic-link');
    expect(classic.getAttribute('href')).toBe('/inbox');
    expect(classic.textContent).toContain('Classic view');
  });

  it('falls back to the classic Inbox with a one-line notice when WebGL is missing', async () => {
    renderOffice();
    await screen.findByTestId('agency-stage');
    act(() => stageProps().onFailed('webgl-unavailable'));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByText(WEBGL_NOTICE)).toBeTruthy();
    expect(screen.queryByTestId('agency-stage')).toBeNull();
  });

  it('says the office could not start for any other failure, and the notice goes away on the next page', async () => {
    const { user } = renderOffice();
    await screen.findByTestId('agency-stage');
    act(() => stageProps().onFailed('init-threw'));
    expect(await screen.findByText('The office view could not start. Showing the classic view.')).toBeTruthy();
    await user.click(screen.getByTestId('nav-sessions'));
    expect(await screen.findByRole('heading', { name: 'Sessions' })).toBeTruthy();
    expect(screen.queryByText(/Showing the classic view/)).toBeNull();
  });

  it('lands on the classic Inbox when the stage crashes while drawing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stageSpy.crash = true;
    renderOffice();
    expect(await screen.findByText('The office view could not start. Showing the classic view.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    error.mockRestore();
  });
});
