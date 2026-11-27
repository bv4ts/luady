import type { SetupStateDTO } from '@luady/shared';
import { createContext, useContext, type ReactNode } from 'react';
import type { SetupApi } from '../../api/setup.js';

/**
 * The first run's API and state for the pages that show it. The App provides the API; the auth gate reads the state
 * (before anything else) and shares it with the signed-in app, which moves it on with each step's answer and with the
 * hub's `setup.changed` messages.
 */
const SetupApiContext = createContext<SetupApi | null>(null);

export function SetupApiProvider({ api, children }: { api: SetupApi; children: ReactNode }) {
  return <SetupApiContext value={api}>{children}</SetupApiContext>;
}

/** Null when nothing provides one (a test of one page, or an embed without the setup routes). */
export function useSetupApi(): SetupApi | null {
  return useContext(SetupApiContext);
}

export interface SetupStateValue {
  /** Null when the hub did not say (an older hub, or the state could not be read): the app then ignores the first-run state. */
  readonly state: SetupStateDTO | null;
  /** A newer state from a step's answer or a `setup.changed` message. */
  apply(next: SetupStateDTO): void;
  /** Reads the sign-in and the state again. */
  refresh(): Promise<void>;
}

const NO_STATE: SetupStateValue = { state: null, apply: () => undefined, refresh: async () => undefined };
const SetupStateContext = createContext<SetupStateValue>(NO_STATE);

export function SetupStateProvider({ value, children }: { value: SetupStateValue; children: ReactNode }) {
  return <SetupStateContext value={value}>{children}</SetupStateContext>;
}

export function useSetupState(): SetupStateValue {
  return useContext(SetupStateContext);
}
