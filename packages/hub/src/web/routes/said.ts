import type { SaidListDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';

/** What each live agent said last, for bubbles after a page load. */
export const saidRoutes: RouteModule = (app, ctx) => {
  const { said } = ctx.deps;
  app.get('/api/said', async (): Promise<SaidListDTO> => ({ items: said.list() }));
};
