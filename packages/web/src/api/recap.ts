import { RecapDTOSchema } from '@luady/shared';
import { query, type Verbs } from './verbs.js';

/** What happened since the owner was last here (the welcome-back card). */
export function recapRoutes({ get }: Verbs) {
  return {
    recap: (since: string) => get(`/api/recap${query({ since })}`, RecapDTOSchema),
  };
}
