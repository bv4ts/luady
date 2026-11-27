import type { MissionListDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';

/** The missions Luady runs now (the board's Running lane, the agent view). */
export const missionRoutes: RouteModule = (app, ctx) => {
  const { board } = ctx.deps;
  app.get('/api/missions', async (): Promise<MissionListDTO> => ({ items: board.missions() }));
};
