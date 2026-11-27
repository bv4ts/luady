import type { SessionDetailDTO } from '@luady/shared';
import { act, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { AgentPanel } from '../../../../src/features/agency/panels/AgentPanel.js';
import { RoomPanel } from '../../../../src/features/agency/panels/RoomPanel.js';
import { useStore } from '../../../../src/state/store.js';
import { account, accountHost, accounts, activityItem, detail, item, step } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { fleetOverview, snapshotOf } from '../agency-fixtures.js';

const ID = 'birch:app-backend';
const OTHER = 'birch:jira-1105';
const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function api(over: FakeApiOverrides = {}) {
  return fakeApi({
    transcript: async () => ({ items: [item({ text: 'Working on the payroll export.' })], nextCursor: null }),
    sessionActivity: async (id) => detail({ sessionId: id }),
    ...over,
  });
}

/** Shows which agent views the store holds, and loads an accounts reading for the meter. */
function Probe() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const limits = {
      reported: 'yes' as const, fiveHour: { usedPct: 62, resetsAt: soon(2) }, sevenDay: { usedPct: 41, resetsAt: soon(50) },
      updatedAt: soon(0),
    };
    dispatch({ type: 'accounts.loaded', accounts: accounts({ accounts: [account({ hosts: [accountHost({ host: 'birch' })], limits })] }) });
  }, [dispatch]);
  return <output data-testid="details">{Object.keys(state.details).join(',')}</output>;
}

function Panel({ initial = ID }: { initial?: string }) {
  const [id, setId] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setId(OTHER)}>switch</button>
      <button type="button" onClick={() => setId('')}>close</button>
      {id === '' ? null : <AgentPanel snapshot={snapshotOf()} actorId={id} />}
      <Probe />
    </>
  );
}

const withDetail = (value: Partial<SessionDetailDTO>) => api({ sessionActivity: async (id) => detail({ sessionId: id, ...value }) });

describe('agent view detail', () => {
  it('fetches once, subscribes to steps and renders appended steps without refetching', async () => {
    const harness = await renderPage(<Panel />, { api: api(), overview: fleetOverview() });
    expect(harness.api.sessionActivity).toHaveBeenCalledTimes(1);
    expect(harness.ws.stepSubscriptions.get(ID)).toBe(1);
    expect(screen.getByTestId('current-step').textContent).toContain('Thinking…');
    expect(screen.getByText('41%')).toBeTruthy();
    expect(screen.getByText('claude-opus-4-5')).toBeTruthy();
    expect(screen.getByText('5h 62% · week 41%')).toBeTruthy();
    harness.ws.emit({
      type: 'steps.appended', sessionId: ID, todos: null, helpers: null,
      steps: [step({ id: 'run1', tool: 'Bash', kind: 'run', title: 'npm test', endedAt: null, ok: null, added: null, removed: null })],
    });
    expect(screen.getByTestId('current-step').textContent).toContain('npm test');
    const recent = screen.getByRole('list', { name: 'Recent steps' });
    expect(within(recent).getAllByRole('listitem').map((li) => li.textContent)[0]).toContain('npm test');
    expect(within(recent).getAllByRole('listitem')[1]?.textContent).toContain('+12 −3');
    expect(harness.api.sessionActivity).toHaveBeenCalledTimes(1);
  });

  it('hides Plan and Helpers when there are none, and shows them when there are', async () => {
    await renderPage(<Panel />, { api: api(), overview: fleetOverview() });
    expect(screen.queryByTestId('plan-list')).toBeNull();
    expect(screen.queryByText(/helper/)).toBeNull();
  });

  it('shows the plan with its marks and the helpers', async () => {
    const todos = [
      { id: '1', subject: 'Read the export code', status: 'completed' as const },
      { id: '2', subject: 'Fix the date format', status: 'in_progress' as const },
      { id: '3', subject: 'Run the tests', status: 'pending' as const },
    ];
    const helpers = [{ agentId: 'h1', agentType: 'Explore', startedAt: '2026-10-09T12:00:00.000Z' }];
    await renderPage(<Panel />, { api: withDetail({ todos, helpers }), overview: fleetOverview() });
    const plan = screen.getByTestId('plan-list');
    expect(within(plan).getAllByRole('listitem').map((li) => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending']);
    expect(within(plan).getByText('Fix the date format')).toBeTruthy();
    expect(screen.getByText('1 helper: Explore')).toBeTruthy();
  });

  it('says Pausing after this step… and then Paused once the pause hit', async () => {
    let hit = false;
    const harness = await renderPage(<Panel />, {
      api: api({ sessionActivity: async (id) => detail({ sessionId: id, paused: true, pauseHit: hit }) }),
      overview: fleetOverview(),
    });
    expect(screen.getByTestId('current-step').textContent).toContain('Pausing after this step…');
    hit = true;
    harness.ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: null, paused: true })] });
    await flush();
    expect(screen.getByTestId('current-step').textContent).toContain('Paused');
    expect(screen.getByTestId('current-step').textContent).not.toContain('Pausing');
  });

  it('the header says paused, not working, while the owner holds it', async () => {
    const harness = await renderPage(<Panel />, { api: api(), overview: fleetOverview() });
    const pill = () => document.querySelector('.agency-pill')?.textContent;
    const before = pill();
    harness.ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: null, paused: true })] });
    await flush();
    expect(pill()).toBe('paused');
    harness.ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: ID, tool: null, paused: false })] });
    await flush();
    expect(pill()).toBe(before);
  });

  it('closes the subscription and the slice on unmount', async () => {
    const harness = await renderPage(<Panel />, { api: api(), overview: fleetOverview() });
    expect(screen.getByTestId('details').textContent).toBe(ID);
    await harness.user.click(screen.getByRole('button', { name: 'close' }));
    expect(harness.ws.stepSubscriptions.size).toBe(0);
    expect(screen.getByTestId('details').textContent).toBe('');
  });

  it('closes the first subscription before opening the second when switching agents', async () => {
    const harness = await renderPage(<Panel />, { api: api(), overview: fleetOverview() });
    const real = harness.ws.client.subscribeSteps.getMockImplementation();
    if (real === undefined) throw new Error('the fake has no subscribeSteps');
    let firstStillOpen: boolean | null = null;
    harness.ws.client.subscribeSteps.mockImplementation((id) => {
      if (id === OTHER) firstStillOpen = harness.ws.stepSubscriptions.has(ID);
      return real(id);
    });
    await harness.user.click(screen.getByRole('button', { name: 'switch' }));
    expect(firstStillOpen).toBe(false);
    expect([...harness.ws.stepSubscriptions.keys()]).toEqual([OTHER]);
    expect(screen.getByTestId('details').textContent).toBe(OTHER);
  });

  it('refetches the detail after a reconnect, so no step is missed and none shows twice', async () => {
    const harness = await renderPage(<Panel />, { api: api(), overview: fleetOverview() });
    harness.ws.setStatus('open', 1);
    harness.ws.setStatus('reconnecting', 1);
    harness.ws.setStatus('open', 2);
    await flush();
    expect(harness.api.sessionActivity).toHaveBeenCalledTimes(2);
    const recent = screen.getByRole('list', { name: 'Recent steps' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(1);
  });

  it('with an older hub (404) still shows the transcript and no error toast', async () => {
    const missing = async () => { throw new ApiError(404, 'not_found', 'Route not found'); };
    await renderPage(<Panel />, { api: api({ sessionActivity: missing }), overview: fleetOverview() });
    expect(await screen.findByText('Working on the payroll export.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Recent steps' })).toBeNull();
  });
});

describe('room rows say what each agent is doing', () => {
  it('adds the tool in words, or paused', async () => {
    const { ws } = await renderPage(<RoomPanel snapshot={snapshotOf()} roomId="birch" dispatch={vi.fn()} />, {
      api: fakeApi({ activity: async () => ({ items: [] }) }), overview: fleetOverview(),
    });
    ws.emit({ type: 'activity.updated', items: [
      activityItem({ sessionId: ID, tool: 'edit' }), activityItem({ sessionId: OTHER, tool: null, paused: true }),
    ] });
    expect(screen.getByRole('button', { name: /app-backend/ }).textContent).toContain('editing');
    expect(screen.getByRole('button', { name: /jira-1105/ }).textContent).toContain('paused');
  });
});
