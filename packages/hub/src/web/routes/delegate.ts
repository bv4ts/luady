import { DelegateBodySchema, type DelegateResultDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { knownServer, parseBody } from '../validate.js';

/** Run and Give to…: cards, tickets and notes go to Luady, or to a named session or office. */
export const delegateRoutes: RouteModule = (app, ctx) => {
  const { board, fleet } = ctx.deps;
  app.post('/api/delegate', async (request): Promise<DelegateResultDTO> => {
    const body = parseBody(DelegateBodySchema, request.body);
    for (const what of body.what) if (what.kind === 'jira') knownServer(fleet, what.server);
    if (body.to.kind === 'server') knownServer(fleet, body.to.server);
    // The auth chain let this request through only with the owner's session and page key: it is the owner asking.
    return board.delegate(body, { ownerOnWebsite: request.luadySession !== null && request.luadySession !== undefined });
  });
};
