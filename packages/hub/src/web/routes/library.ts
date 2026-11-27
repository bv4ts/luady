import { LibraryRefreshBodySchema, type LibraryDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { knownServer, parseBody } from '../validate.js';

/** The Library: every project, the skills per office and Luady's own skills. */
export const libraryRoutes: RouteModule = (app, ctx) => {
  const { library, fleet } = ctx.deps;
  app.get('/api/library', async (): Promise<LibraryDTO> => library.get());
  app.post('/api/library/refresh', async (request): Promise<{ ok: true }> => {
    const { server } = parseBody(LibraryRefreshBodySchema, request.body);
    await library.refresh(knownServer(fleet, server));
    return { ok: true };
  });
};
