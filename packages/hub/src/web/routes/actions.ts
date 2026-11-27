import { PinBodySchema } from '@luady/shared';
import { NotFoundError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { ActionIdParamsSchema, ActionsQuerySchema, EmptyBodySchema } from '../schemas.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

export const actionRoutes: RouteModule = (app, ctx) => {
  const { actions } = ctx.deps;
  app.get('/api/actions', async (request) => {
    const query = parseQuery(ActionsQuerySchema, request.query);
    return actions.list(query.status === undefined ? { limit: query.limit } : { status: query.status, limit: query.limit });
  });
  // The whole text an action types or writes, hidden characters marked: the confirmation card's full view.
  app.get('/api/actions/:id/text', async (request) => {
    const { id } = parseParams(ActionIdParamsSchema, request.params);
    const text = actions.fullText?.(id);
    if (text === undefined) throw new NotFoundError(`Unknown action ${id}`);
    return { text };
  });
  app.post('/api/actions/:id/confirm', async (request) => {
    const { id } = parseParams(ActionIdParamsSchema, request.params);
    const { pin } = parseBody(PinBodySchema, request.body);
    return actions.confirm(id, pin, 'web');
  });
  app.post('/api/actions/:id/deny', async (request) => {
    const { id } = parseParams(ActionIdParamsSchema, request.params);
    parseBody(EmptyBodySchema, request.body);
    return actions.deny(id, 'web');
  });
};
