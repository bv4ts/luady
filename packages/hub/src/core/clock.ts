import type { Clock } from './contracts.js';

/** Wall-clock time for production. Tests use createFakeClock() from test/helpers/fakes.ts. */
export const systemClock: Clock = {
  now: () => new Date(),
};
