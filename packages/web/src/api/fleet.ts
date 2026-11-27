import { FleetHistoryDTOSchema } from '@luady/shared';
import type { Verbs } from './verbs.js';

/** 24 hours of every server and account (the fleet wall). */
export function fleetRoutes({ get }: Verbs) {
  return {
    fleetHistory: () => get('/api/fleet/history', FleetHistoryDTOSchema),
  };
}
