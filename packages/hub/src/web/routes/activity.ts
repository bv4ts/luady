import type { ActivityListDTO, SessionDetailDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { knownSessionId } from './sessions.js';

/** The map's activity snapshot and one session's agent-view detail. Pause and resume live with the session actions. */
export const activityRoutes: RouteModule = (app, ctx) => {
  const { sessions, activity } = ctx.deps;
  app.get('/api/activity', async (): Promise<ActivityListDTO> => ({ items: activity.snapshot() }));
  app.get('/api/sessions/:id/activity', async (request): Promise<SessionDetailDTO> => activity.detail(knownSessionId(sessions, request.params)));
};
