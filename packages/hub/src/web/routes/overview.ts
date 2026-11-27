import { SELF_HOST_ID, type OverviewDTO } from '@luady/shared';
import type { RouteModule, WebContext } from '../context.js';

/** The Luady brain session (origin 'system') is never part of the overview. */
export function buildOverview(ctx: WebContext): OverviewDTO {
  const { fleet, sessions, questions, actions, luady, rooms, channels } = ctx.deps;
  return {
    servers: fleet.servers(),
    sessions: sessions.list().filter((session) => session.origin !== 'system'),
    questions: questions.pending(),
    actions: actions.pending(),
    manager: luady.status(),
    selfHost: SELF_HOST_ID,
    // The rooms and the declared channels; empty until their services exist.
    rooms: rooms?.list().items ?? [],
    channels: channels?.list() ?? [],
  };
}

export const overviewRoutes: RouteModule = (app, ctx) => {
  app.get('/api/overview', async () => buildOverview(ctx));
};
