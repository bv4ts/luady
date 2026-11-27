import { SaidListDTOSchema } from '@luady/shared';
import type { Verbs } from './verbs.js';

/** What each live agent said last, for the speech bubbles after a page load. */
export function saidRoutes({ get }: Verbs) {
  return {
    said: () => get('/api/said', SaidListDTOSchema),
  };
}
