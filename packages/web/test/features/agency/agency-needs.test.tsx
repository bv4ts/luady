import type { AgencySnapshot } from '@luady/office';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../src/features/agency/AgencyPage.js';
import { offMapNeedPath } from '../../../src/features/agency/model/need-route.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { fleetOverview, snapshotOf } from './agency-fixtures.js';
import { resetStageSpy, stageProps } from './stage-mock.js';

const holder = vi.hoisted(() => ({ snapshot: null as AgencySnapshot | null }));

vi.mock('../../../src/features/agency/scene/AgencyStage.js', () => import('./stage-mock.js'));
vi.mock('../../../src/features/agency/model/useAgencySnapshot.js', () => ({
  useAgencySnapshot: (): AgencySnapshot => {
    if (holder.snapshot === null) throw new Error('set holder.snapshot first');
    return holder.snapshot;
  },
}));

/** A hand-made snapshot: one waiting agent on the map, one waiting session without a character. */
function withOffMapNeed(): AgencySnapshot {
  return { ...snapshotOf(), needs: ['ash:harbor-web', 'birch:overflowed'] };
}

beforeEach(() => {
  resetStageSpy();
});

describe('offMapNeedPath', () => {
  const { actors } = withOffMapNeed();

  it('is null when the next need has a character on the map', () => {
    expect(offMapNeedPath(['ash:harbor-web', 'birch:overflowed'], null, actors)).toBeNull();
    expect(offMapNeedPath([], null, actors)).toBeNull();
  });

  it('is the classic session page when the next need has no character', () => {
    expect(offMapNeedPath(['ash:harbor-web', 'birch:overflowed'], 'ash:harbor-web', actors)).toBe('/sessions/birch%3Aoverflowed');
    expect(offMapNeedPath(['local:off'], null, actors)).toBe('/sessions/local%3Aoff');
  });
});

describe('the bell with a waiting session that has no character', () => {
  it('selects the one on the map, then opens the classic page of the one that is not', async () => {
    holder.snapshot = withOffMapNeed();
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }), transcript: async () => ({ items: [], nextCursor: null }) });
    const { user } = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    const bell = screen.getByRole('button', { name: '2 need you' });
    await user.click(bell);
    expect(stageProps().selectedId).toBe('ash:harbor-web');
    expect(screen.getByTestId('location').textContent).toBe('/');
    await user.click(bell);
    expect(screen.getByTestId('location').textContent).toBe('/sessions/birch%3Aoverflowed');
  });
});
