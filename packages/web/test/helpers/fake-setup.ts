import type { SetupStateDTO } from '@luady/shared';
import { vi, type Mock } from 'vitest';
import type { SetupApi } from '../../src/api/setup.js';

export type FakeSetupApi = { [K in keyof SetupApi]: Mock<SetupApi[K]> };

export function setupState(over: Partial<SetupStateDTO> = {}): SetupStateDTO {
  return { step: 'claim', claimed: false, authMode: 'local', remote: false, skipped: [], ...over };
}

/** Each call of state, step or finish answers the next state of the list; the last one repeats. */
export function fakeSetupApi(states: readonly SetupStateDTO[]): FakeSetupApi {
  const queue = [...states];
  const next = async (): Promise<SetupStateDTO> => (queue.length > 1 ? queue.shift() : queue[0]) ?? setupState();
  return {
    state: vi.fn<SetupApi['state']>(next),
    login: vi.fn<SetupApi['login']>(async () => ({ pageKey: 'k'.repeat(43) })),
    step: vi.fn<SetupApi['step']>(next),
    finish: vi.fn<SetupApi['finish']>(next),
  };
}
