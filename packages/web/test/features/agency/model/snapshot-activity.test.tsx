import type { AgencySnapshot } from '@luady/office';
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAgencySnapshot } from '../../../../src/features/agency/model/useAgencySnapshot.js';
import { useStore } from '../../../../src/state/store.js';
import { activityItem, notice } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { fleetOverview } from '../agency-fixtures.js';

const ID = 'birch:app-backend';
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function Probe({ seen }: { seen: AgencySnapshot[] }) {
  seen.push(useAgencySnapshot());
  const { dispatch } = useStore();
  return (
    <button type="button" onClick={() => dispatch({ type: 'ws.message', message: { type: 'notice.created', notice: notice() } })}>
      notice
    </button>
  );
}

async function open() {
  const seen: AgencySnapshot[] = [];
  const api = fakeApi({ activity: async () => ({ items: [] }), notices: async () => ({ items: [] }) });
  const harness = await renderPage(<Probe seen={seen} />, { overview: fleetOverview(), api });
  return { ...harness, last: () => seen.at(-1) as AgencySnapshot };
}

beforeEach(() => {
  localStorage.clear();
});

describe('the map follows live activity', () => {
  it('shows the tool bubble and the pause icon from the activity slice', async () => {
    const { ws, last } = await open();
    expect(last().actors[ID]?.visual.bubble).toBe('dots');
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: 'edit', lastStepAt: ago(1000) })] });
    expect(last().actors[ID]?.visual.bubble).toBe('pencil');
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: null, paused: true, lastStepAt: ago(1000) })] });
    expect(last().actors[ID]?.visual.bubble).toBe('pause');
  });

  it('keeps the same snapshot object when an unrelated slice changes', async () => {
    const { ws, user, last } = await open();
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: 'run', lastStepAt: ago(1000) })] });
    const before = last();
    await user.click(screen.getByRole('button', { name: 'notice' }));
    await act(async () => undefined);
    expect(last()).toBe(before);
  });

  it('passes helpers and context use to the map', async () => {
    const { ws, last } = await open();
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, helpers: 2, contextPct: 93, lastStepAt: ago(1000) })] });
    expect(last().actors[ID]?.helpers).toBe(2);
    expect(last().actors[ID]?.strained).toBe(true);
    expect(last().actors['birch:jira-1105']?.helpers).toBe(0);
  });

  it('measures silence from the last step: a recent step shows no "?" while an old one does', async () => {
    const { ws, last } = await open();
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: null, lastStepAt: ago(60_000) })] });
    expect(last().actors[ID]?.visual.bubble).not.toBe('ask');
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: null, lastStepAt: ago(20 * 60_000) })] });
    expect(last().actors[ID]?.visual.bubble).toBe('ask');
  });
});
