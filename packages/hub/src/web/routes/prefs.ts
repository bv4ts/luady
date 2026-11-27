import { UpdateWebPrefsBodySchema, type WebPrefsDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { parseBody } from '../validate.js';

/** The website preferences (sound, day and night), the same on every device. */
export const prefsRoutes: RouteModule = (app, ctx) => {
  const { prefs } = ctx.deps;
  app.get('/api/prefs', async (): Promise<WebPrefsDTO> => prefs.get());
  app.put('/api/prefs', async (request): Promise<WebPrefsDTO> => prefs.update(parseBody(UpdateWebPrefsBodySchema, request.body)));
};
