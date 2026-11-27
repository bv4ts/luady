import { UpdateWebPrefsBodySchema, WebPrefsDTOSchema } from '@luady/shared';
import type { z } from 'zod';
import { checked, type Verbs } from './verbs.js';

export type UpdatePrefsInput = z.input<typeof UpdateWebPrefsBodySchema>;

/** The website preferences (sound, day and night), the same on every device. */
export function prefsRoutes({ get, put }: Verbs) {
  return {
    prefs: () => get('/api/prefs', WebPrefsDTOSchema),
    updatePrefs: async (body: UpdatePrefsInput) => put('/api/prefs', WebPrefsDTOSchema, checked(UpdateWebPrefsBodySchema, body)),
  };
}
