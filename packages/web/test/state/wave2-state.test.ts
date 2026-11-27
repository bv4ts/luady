import { DEFAULT_WEB_PREFS, type WsServerMessage } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_PREFS, loadPrefs } from '../../src/state/prefs.js';
import { initialState, reducer, type AppAction, type AppState } from '../../src/state/reducer.js';

const AT = '2026-11-15T09:00:00.000Z';
const ws = (message: WsServerMessage): AppAction => ({ type: 'ws.message', message });
const run = (state: AppState, ...actions: AppAction[]): AppState => actions.reduce(reducer, state);

describe('prefs slice', () => {
  it('starts on the defaults, not loaded', () => {
    expect(EMPTY_PREFS).toEqual({ value: DEFAULT_WEB_PREFS, loaded: false });
  });

  it('a load replaces the value and marks it loaded; an equal value keeps the same object', () => {
    const loaded = loadPrefs(EMPTY_PREFS, { sound: { muted: true, volume: 0.3 }, dayNight: false });
    expect(loaded).toEqual({ value: { sound: { muted: true, volume: 0.3 }, dayNight: false }, loaded: true });
    expect(loadPrefs(loaded, { sound: { muted: true, volume: 0.3 }, dayNight: false })).toBe(loaded);
    expect(loadPrefs(EMPTY_PREFS, DEFAULT_WEB_PREFS).value).toBe(EMPTY_PREFS.value);
  });
});

describe('prefs and change counters in the store', () => {
  it('starts with the default prefs and every new version at 0', () => {
    expect(initialState).toMatchObject({ prefs: EMPTY_PREFS, prefsVersion: 0, schedulesVersion: 0, linksVersion: 0 });
  });

  it('loads prefs, and the three *.changed messages bump their counters', () => {
    const state = run(initialState,
      { type: 'prefs.loaded', prefs: { ...DEFAULT_WEB_PREFS, dayNight: false } },
      ws({ type: 'prefs.changed', at: AT }), ws({ type: 'schedules.changed', at: AT }), ws({ type: 'schedules.changed', at: AT }),
      ws({ type: 'links.changed', at: AT }));
    expect(state.prefs).toEqual({ value: { ...DEFAULT_WEB_PREFS, dayNight: false }, loaded: true });
    expect(state).toMatchObject({ prefsVersion: 1, schedulesVersion: 2, linksVersion: 1, jiraVersion: 0 });
  });
});
