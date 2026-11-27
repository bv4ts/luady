import type { FleetHistoryDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';

/** The fleet wall: 24 hours of every server and every account. */
export const fleetHistoryRoutes: RouteModule = (app, ctx) => {
  const { fleetHistory } = ctx.deps;
  app.get('/api/fleet/history', async (): Promise<FleetHistoryDTO> => fleetHistory.history());
};
