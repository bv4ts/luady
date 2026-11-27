import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { fleetOverview } from './agency-fixtures.js';

const gate = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
});

vi.mock('../../../src/features/agency/scene/AgencyStage.js', async () => {
  await gate.opened;
  return import('./stage-mock.js');
});

describe('AgencyPage while the stage code loads', () => {
  it('shows the page shell with "Opening the office…" and the HUD already usable', async () => {
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }) });
    await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    expect(screen.getByText('Opening the office…').getAttribute('role')).toBe('status');
    expect(screen.getByRole('group', { name: 'Rooms' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message to Luady' })).toBeTruthy();
    expect(screen.queryByTestId('agency-stage')).toBeNull();
    await act(async () => {
      gate.open();
    });
    expect(await screen.findByTestId('agency-stage')).toBeTruthy();
    expect(screen.queryByText('Opening the office…')).toBeNull();
  });
});
