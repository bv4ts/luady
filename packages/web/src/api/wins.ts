import { WinsDTOSchema } from '@luady/shared';
import { query, type Verbs } from './verbs.js';

/** What shipped in the last days (the wins wall). */
export function winsRoutes({ get }: Verbs) {
  return {
    wins: (days?: number) => get(`/api/wins${query({ days })}`, WinsDTOSchema),
  };
}
