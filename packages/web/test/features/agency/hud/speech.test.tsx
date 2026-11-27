import type { BoardItemDTO } from '@luady/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../../src/features/agency/AgencyPage.js';
import { cardFromSaid, lengthClass } from '../../../../src/features/agency/hud/AgentSpeech.js';
import { BUBBLE_MIN_MS } from '../../../../src/features/agency/model/bubble-queue.js';
import { ANSWER_MS } from '../../../../src/features/agency/model/luady-flow.js';
import { LUADY_ACTOR_ID, type OverlayPoint } from '../../../../src/features/agency/stage-types.js';
import { chat, luadyStatus } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { agent, fleetOverview } from '../agency-fixtures.js';
import { resetStageSpy, stageProps } from '../stage-mock.js';

vi.mock('../../../../src/features/agency/scene/AgencyStage.js', () => import('../stage-mock.js'));

const ANSWER = `The payroll export is fixed.\n\n- CSV dates are ISO now\n- ${'All 41 tests pass on cedar and the README says how to run them. '.repeat(8)}`;

const point = (id: string, over: Partial<OverlayPoint> = {}): OverlayPoint => ({
  kind: 'actor', id, x: 600, y: 400, footY: 440, maxWidth: 58, visible: true, scale: 1.4, ...over,
});

function card(id: number): BoardItemDTO {
  return {
    id, title: 't', details: '', project: null, server: null, source: 'session', sourceRef: null, state: 'open', today: false, priority: 0,
    auto: false, runId: null, sessionId: null, result: null, createdAt: '', updatedAt: '', doneAt: null, dueAt: null, snoozeUntil: null,
  };
}

async function openOffice() {
  const api = fakeApi({
    luadyMessages: async () => ({ items: [chat({ id: 'old', text: 'An old answer.' })], nextCursor: null }),
    sendToLuady: async () => ({ ok: true }),
    createCard: async () => card(31),
  });
  const harness = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
  await screen.findByTestId('agency-stage');
  act(() => stageProps().onFrame([point('birch:app-backend'), point('ash:harbor-web', { x: 900 }), point(LUADY_ACTOR_ID, { x: 700, y: 300 })]));
  return harness;
}

const said = (sessionId: string, text: string, over: { truncated?: boolean; kind?: 'reply' | 'report' } = {}) => ({
  type: 'session.said' as const, sessionId, kind: over.kind ?? 'reply', text, truncated: over.truncated ?? false, at: new Date().toISOString(),
});

beforeEach(() => {
  resetStageSpy();
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agent speech on the map', () => {
  it('opens a bubble with the name and the words when an agent says something, placed above it', async () => {
    const { ws } = await openOffice();
    act(() => ws.emit(said('birch:app-backend', 'All **41** tests pass.')));
    const bubble = await screen.findByRole('group', { name: 'app-backend said' });
    expect(bubble.textContent).toContain('All 41 tests pass.');
    expect(bubble.querySelector('strong')?.textContent).toBe('41');
    expect((bubble as HTMLElement).style.transform).toMatch(/^translate3d\(/);
    expect((bubble as HTMLElement).hidden).toBe(false);
  });

  it('folds into a speech mark after its time, and the mark shows it again', async () => {
    const { ws } = await openOffice();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => ws.emit(said('birch:app-backend', 'Done.')));
    expect(screen.getByRole('group', { name: 'app-backend said' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(BUBBLE_MIN_MS + 100);
    });
    expect(screen.queryByRole('group', { name: 'app-backend said' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show what app-backend said' }));
    expect(screen.getByRole('group', { name: 'app-backend said' })).toBeTruthy();
  });

  it('a long message has More, which opens it to be read whole; a cut one also offers the agent view', async () => {
    const { ws } = await openOffice();
    act(() => ws.emit(said('birch:app-backend', ANSWER, { truncated: true })));
    const bubble = screen.getByRole('group', { name: 'app-backend said' });
    expect(bubble.getAttribute('data-long')).toBe('both');
    fireEvent.click(within(bubble).getByRole('button', { name: 'More' }));
    expect(bubble.getAttribute('data-expanded')).toBe('true');
    fireEvent.click(within(bubble).getByRole('button', { name: 'Open app-backend for the rest' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'app-backend' })).toBeTruthy());
  });

  it('Add to board makes a card from the words, with the office and project', async () => {
    const { ws, api } = await openOffice();
    act(() => ws.emit(said('birch:app-backend', 'Found a flaky test in checkout.\nIt fails one run in five.', { kind: 'report' })));
    const bubble = screen.getByRole('group', { name: 'app-backend said' });
    expect(bubble.textContent).toContain('Report');
    fireEvent.click(within(bubble).getByRole('button', { name: 'Add to board' }));
    await waitFor(() => expect(api.createCard).toHaveBeenCalledWith({
      title: 'Found a flaky test in checkout.', details: 'Found a flaky test in checkout.\nIt fails one run in five.', source: 'session',
      sourceRef: 'birch:app-backend', server: 'birch', project: 'app-backend',
    }));
    expect(await screen.findByText('Added to the board as #31.')).toBeTruthy();
  });

  it('the close button folds it at once', async () => {
    const { ws } = await openOffice();
    act(() => ws.emit(said('ash:harbor-web', 'Waiting on you.')));
    fireEvent.click(screen.getByRole('button', { name: 'Close what harbor-web said' }));
    expect(screen.queryByRole('group', { name: 'harbor-web said' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show what harbor-web said' })).toBeTruthy();
  });

  it('nothing for a session that is not on the map', async () => {
    const { ws } = await openOffice();
    act(() => ws.emit(said('birch:nobody', 'Hello.')));
    expect(screen.queryAllByTestId('agent-speech')).toHaveLength(0);
  });
});

describe("Luady's message flow on the map", () => {
  it('sent, typing, then his whole answer above him; it closes from its button', async () => {
    const { ws, user } = await openOffice();
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), 'how is payroll?{Enter}');
    expect(screen.getByTestId('luady-pop').textContent).toContain('New message');
    act(() => ws.emit({ type: 'manager.status', status: luadyStatus({ state: 'busy' }) }));
    const typing = screen.getByTestId('luady-pop');
    expect(typing.getAttribute('data-flow')).toBe('typing');
    expect(typing.querySelectorAll('.speech__dots i')).toHaveLength(3);
    act(() => ws.emit({ type: 'manager.message', message: chat({ id: 'a1', text: ANSWER, ts: new Date().toISOString() }) }));
    const answer = screen.getByRole('region', { name: "Luady's answer" });
    // Never cut, never dots: every word of it is there.
    expect(answer.textContent).toContain('All 41 tests pass on cedar and the README says how to run them. '.repeat(8).trim());
    expect(screen.queryByTestId('luady-pop')).toBeNull();
    fireEvent.click(within(answer).getByRole('button', { name: "Close Luady's answer" }));
    expect(screen.queryByRole('region', { name: "Luady's answer" })).toBeNull();
  });

  it('his answer goes after 45 seconds', async () => {
    const { ws } = await openOffice();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => ws.emit({ type: 'manager.message', message: chat({ id: 'a2', text: 'Morning.', ts: new Date().toISOString() }) }));
    expect(screen.getByRole('region', { name: "Luady's answer" })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(ANSWER_MS + 100);
    });
    expect(screen.queryByRole('region', { name: "Luady's answer" })).toBeNull();
  });

  it('a message the hub keeps says he is signed out', async () => {
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }), sendToLuady: async () => ({ ok: true as const, held: true }) });
    const { user } = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), 'hello{Enter}');
    await waitFor(() => expect(screen.getByTestId('luady-pop').textContent).toBe('Luady is signed out. He gets it when he is back.'));
  });

  it('writing while he is offline says so', async () => {
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }), sendToLuady: async () => ({ ok: true }) });
    const { user } = await renderPage(<AgencyPage />, { api, overview: fleetOverview({ manager: luadyStatus({ state: 'down' }) }) });
    await screen.findByTestId('agency-stage');
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), 'hello{Enter}');
    expect(screen.getByTestId('luady-pop').textContent).toBe('Luady is offline right now. He gets it when he is back.');
  });

  it('an old answer that came with the page does not pop up', async () => {
    await openOffice();
    expect(screen.queryByRole('region', { name: "Luady's answer" })).toBeNull();
  });
});

describe('speech helpers', () => {
  const base = { sessionId: 'birch:a', kind: 'reply' as const, truncated: false, at: '' };
  it('knows when words are longer than a bubble shows', () => {
    expect(lengthClass({ ...base, text: 'Short.' })).toBe('short');
    expect(lengthClass({ ...base, text: 'x'.repeat(100) })).toBe('office');
    expect(lengthClass({ ...base, text: 'a\nb\nc' })).toBe('office');
    expect(lengthClass({ ...base, text: 'x'.repeat(300) })).toBe('both');
    expect(lengthClass({ ...base, text: 'Short.', truncated: true })).toBe('both');
  });

  it('a card from words leaves out an office it does not know', () => {
    expect(cardFromSaid({ ...base, text: '**Ship** it' }, agent('birch', 'x', { host: 'hq' as never, project: null }))).toEqual({
      title: 'Ship it', details: '**Ship** it', source: 'session', sourceRef: 'birch:a',
    });
  });
});
