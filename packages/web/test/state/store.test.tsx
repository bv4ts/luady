import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/context.js';
import { ApiError } from '../../src/api/errors.js';
import { StoreProvider, useStore } from '../../src/state/store.js';
import { Toasts } from '../../src/ui/Toasts.js';
import { activityItem, me, notice, overview, presence, question, session } from '../fixtures.js';
import { fakeApi, type FakeApi } from '../helpers/fake-api.js';
import { createFakeWs } from '../helpers/fake-ws.js';

function Probe() {
  const { state, toast, subscribeSteps, live } = useStore();
  const signals = () => {
    subscribeSteps('cedar:a:0.0');
    live.setVisible(true);
    live.touch();
    live.ackNotices(['n1']);
  };
  return (
    <div>
      <p data-testid="sessions">{state.sessions.map((s) => `${s.displayName}=${s.state}`).join(',')}</p>
      <p data-testid="questions">{state.questions.length}</p>
      <p data-testid="connection">{`${state.connection.status}:${state.connection.epoch}`}</p>
      <p data-testid="loaded">{String(state.loaded)}</p>
      <p data-testid="live">{`${Object.keys(state.activity).length}:${state.notices.length}:${state.presence?.mode ?? 'none'}`}</p>
      <p data-testid="prefs">{`${String(state.prefs.loaded)}:${String(state.prefs.value.dayNight)}:${String(state.prefs.value.sound.volume)}`}</p>
      <p data-testid="step-c">{`${String(state.board.loaded)}:${Object.keys(state.board.cards).length}:${Object.keys(state.missions).length}:${Object.keys(state.said.bySession).length}`}</p>
      <button type="button" onClick={signals}>signals</button>
      <button type="button" onClick={() => toast('info', 'Hello from a toast')}>toast</button>
      <Toasts />
    </div>
  );
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function mount(api: FakeApi) {
  const ws = createFakeWs();
  const onAuthLost = vi.fn();
  const view = render(
    <ApiProvider api={api}>
      <StoreProvider createWs={ws.factory} onAuthLost={onAuthLost}>
        <Probe />
      </StoreProvider>
    </ApiProvider>,
  );
  await flush();
  return { ws, onAuthLost, view };
}

describe('StoreProvider', () => {
  it('loads the overview on mount and applies live messages', async () => {
    const { ws } = await mount(fakeApi({ overview: async () => overview() }));
    expect(screen.getByTestId('sessions').textContent).toBe('meadow-hr=idle');
    expect(screen.getByTestId('questions').textContent).toBe('1');
    expect(ws.client.start).toHaveBeenCalledTimes(1);
    ws.emit({ type: 'session.updated', session: session({ state: 'working' }) });
    ws.emit({ type: 'question.updated', question: question({ state: 'answered' }) });
    expect(screen.getByTestId('sessions').textContent).toBe('meadow-hr=working');
    expect(screen.getByTestId('questions').textContent).toBe('0');
  });

  it('refetches the overview after a reconnect', async () => {
    const api = fakeApi({ overview: async () => overview(), me: async () => me() });
    const { ws } = await mount(api);
    ws.setStatus('open', 1);
    ws.setStatus('reconnecting', 1);
    ws.setStatus('open', 2);
    await flush();
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('connection').textContent).toBe('open:2');
  });

  it('checks the session while reconnecting', async () => {
    const api = fakeApi({
      overview: async () => overview(),
      me: async () => { throw new ApiError(401, 'auth', 'No session'); },
    });
    const { ws, onAuthLost } = await mount(api);
    ws.setStatus('reconnecting', 1);
    await flush();
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('reports a lost login when the socket closes with 4401', async () => {
    const { ws, onAuthLost } = await mount(fakeApi({ overview: async () => overview() }));
    ws.expire();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('reports a lost login when the overview answers 401', async () => {
    const { onAuthLost } = await mount(fakeApi({ overview: async () => { throw new ApiError(401, 'auth', 'No session'); } }));
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('shows an error toast when the overview fails for another reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mount(fakeApi({ overview: async () => { throw new ApiError(0, 'network', 'Cannot reach Luady. Check your connection and try again.'); } }));
    expect(screen.getByRole('alert').textContent).toContain('Cannot reach Luady');
  });

  it('shows and dismisses toasts', async () => {
    const user = userEvent.setup();
    await mount(fakeApi({ overview: async () => overview() }));
    await user.click(screen.getByRole('button', { name: 'toast' }));
    expect(screen.getByText('Hello from a toast')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Hello from a toast')).toBeNull();
  });

  it('loads activity, notices and presence after the overview, and again on every reconnect', async () => {
    const api = fakeApi({
      overview: async () => overview(), me: async () => me(),
      activity: async () => ({ items: [activityItem()] }),
      notices: async () => ({ items: [notice()] }),
      presence: async () => presence(),
    });
    const { ws } = await mount(api);
    expect(screen.getByTestId('live').textContent).toBe('1:1:here');
    ws.setStatus('open', 1);
    ws.setStatus('reconnecting', 1);
    ws.setStatus('open', 2);
    await flush();
    expect(api.activity).toHaveBeenCalledTimes(2);
    expect(api.notices).toHaveBeenCalledTimes(2);
    expect(api.presence).toHaveBeenCalledTimes(2);
  });

  it('a presence update pushed while the presence reading is on its way wins over that reading', async () => {
    let answer: (value: ReturnType<typeof presence>) => void = () => undefined;
    const api = fakeApi({
      overview: async () => overview(), me: async () => me(),
      activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      presence: () => new Promise((resolve) => { answer = resolve; }),
    });
    const { ws } = await mount(api);
    ws.emit({ type: 'presence.updated', presence: presence({ mode: 'here' }) });
    await act(async () => {
      answer(presence({ mode: 'chat', online: false }));
      await Promise.resolve();
    });
    await flush();
    expect(screen.getByTestId('live').textContent).toBe('0:0:here');
  });

  it('an older hub that answers 404 leaves those slices empty, with no toast and no sign-out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = async () => { throw new ApiError(404, 'not_found', 'Route GET /api/activity not found'); };
    const { onAuthLost } = await mount(fakeApi({
      overview: async () => overview(), activity: missing, notices: missing, presence: missing,
    }));
    expect(screen.getByTestId('loaded').textContent).toBe('true');
    expect(screen.getByTestId('live').textContent).toBe('0:0:none');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('loads the board, missions and speech next to them', async () => {
    const at = '2026-11-15T09:00:00.000Z';
    const card = {
      id: 1, title: 'Card', details: '', project: null, server: null, source: 'web' as const, sourceRef: null, state: 'open' as const,
      today: false, priority: 0 as const, auto: false, runId: null, sessionId: null, result: null, createdAt: at, updatedAt: at,
      doneAt: null, dueAt: null, snoozeUntil: null,
    };
    const mission = { sessionId: 'birch:a', label: 'birch · a', title: 'x', phase: 'idle' as const, turns: 0, note: null, lastText: null, openedAt: at, idleSince: at };
    const api = fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      presence: async () => presence(),
      board: async () => ({ items: [card] }),
      missions: async () => ({ items: [mission] }),
      said: async () => ({ items: [{ sessionId: 'birch:a', kind: 'reply', text: 'Done.', truncated: false, at }] }),
    });
    await mount(api);
    expect(screen.getByTestId('step-c').textContent).toBe('true:1:1:1');
  });

  it('loads the website preferences at start and again on every prefs.changed', async () => {
    const api = fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      presence: async () => presence(), board: async () => ({ items: [] }), missions: async () => ({ items: [] }), said: async () => ({ items: [] }),
      prefs: async () => ({ sound: { muted: false, volume: 0.6 }, dayNight: false }),
    });
    const { ws } = await mount(api);
    expect(screen.getByTestId('prefs').textContent).toBe('true:false:0.6');
    api.prefs.mockResolvedValue({ sound: { muted: true, volume: 0.2 }, dayNight: true });
    ws.emit({ type: 'prefs.changed', at: '2026-11-15T09:00:00.000Z' });
    await flush();
    expect(api.prefs).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('prefs').textContent).toBe('true:true:0.2');
  });

  it('an older hub without /api/prefs keeps the default preferences', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = async () => { throw new ApiError(404, 'not_found', 'Route GET /api/prefs not found'); };
    await mount(fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      presence: async () => presence(), board: async () => ({ items: [] }), missions: async () => ({ items: [] }), said: async () => ({ items: [] }),
      prefs: missing,
    }));
    expect(screen.getByTestId('prefs').textContent).toBe('false:true:0.6');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a hub without the board, missions and speech routes (404) or with their stubs (501) leaves those slices empty, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = async () => { throw new ApiError(404, 'not_found', 'Route GET /api/board not found'); };
    const stub = async () => { throw new ApiError(501, 'not_built_yet', 'Not built yet'); };
    const { onAuthLost } = await mount(fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      presence: async () => presence(), board: missing, missions: stub, said: missing, prefs: missing,
    }));
    expect(screen.getByTestId('step-c').textContent).toBe('false:0:0:0');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a 401 from one of them is a lost login', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { onAuthLost } = await mount(fakeApi({
      overview: async () => overview(), activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
      presence: async () => { throw new ApiError(401, 'auth', 'No session'); },
    }));
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('passes step subscriptions and the live signals to the socket', async () => {
    const { ws } = await mount(fakeApi({ overview: async () => overview() }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'signals' }));
    expect(ws.client.subscribeSteps).toHaveBeenCalledWith('cedar:a:0.0');
    expect(ws.client.setVisible).toHaveBeenCalledWith(true);
    expect(ws.client.touch).toHaveBeenCalledTimes(1);
    expect(ws.client.ackNotices).toHaveBeenCalledWith(['n1']);
  });

  it('stops the socket when unmounted', async () => {
    const { ws, view } = await mount(fakeApi({ overview: async () => overview() }));
    view.unmount();
    expect(ws.client.stop).toHaveBeenCalledTimes(1);
  });
});
