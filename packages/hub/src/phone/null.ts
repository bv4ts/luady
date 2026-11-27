import type { PhoneService } from '../core/contracts.js';

/** The phone when Twilio is not set up: never enabled; calls resolve and do nothing. */
export function createNullPhone(): PhoneService {
  return {
    enabled: () => false,
    callForQuestion: async (): Promise<void> => undefined,
    callOwner: async (): Promise<void> => undefined,
  };
}
