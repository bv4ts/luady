import { TimelineDTOSchema } from '@luady/shared';
import { query, type Verbs } from './verbs.js';

/** One owner day (`YYYY-MM-DD`, today when left out) for the today strip. */
export function timelineRoutes({ get }: Verbs) {
  return {
    timeline: (day?: string) => get(`/api/timeline${query({ day })}`, TimelineDTOSchema),
  };
}
