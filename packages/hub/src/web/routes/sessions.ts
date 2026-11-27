import { CreateSessionBodySchema, PinBodySchema, SendBodySchema, StopBodySchema } from '@luady/shared';
import type { SessionService } from '../../core/contracts.js';
import { NotFoundError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { ownerAction } from '../owner-action.js';
import { EmptyBodySchema, PageQuerySchema, SessionIdParamsSchema } from '../schemas.js';
import { knownServer, parseBody, parseParams, parseQuery, projectFolderOn } from '../validate.js';

/** Validates :id and resolves it to a known session; unknown → 404 before any action is created. */
export function knownSessionId(sessions: SessionService, params: unknown): string {
  const { id } = parseParams(SessionIdParamsSchema, params);
  if (sessions.get(id) === undefined) throw new NotFoundError(`Unknown session: ${id}`);
  return id;
}

export const sessionRoutes: RouteModule = (app, ctx) => {
  const { sessions, actions, fleet } = ctx.deps;
  app.get('/api/sessions', async () => sessions.list());
  app.get('/api/sessions/:id/transcript', async (request) => {
    const id = knownSessionId(sessions, request.params);
    const query = parseQuery(PageQuerySchema, request.query);
    return sessions.transcript(id, query.cursor, query.limit);
  });
  app.post('/api/sessions', async (request) => {
    const body = parseBody(CreateSessionBodySchema, request.body);
    const server = knownServer(fleet, body.server);
    const cwd = projectFolderOn(fleet, server, body.cwd);
    return ownerAction(actions, 'session.start', { server, cwd, prompt: body.prompt, name: body.name });
  });
  app.post('/api/sessions/:id/send', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    const { text } = parseBody(SendBodySchema, request.body);
    return ownerAction(actions, 'session.send', { sessionId, text });
  });
  app.post('/api/sessions/:id/interrupt', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    parseBody(EmptyBodySchema, request.body);
    return ownerAction(actions, 'session.interrupt', { sessionId });
  });
  app.post('/api/sessions/:id/pause', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    parseBody(EmptyBodySchema, request.body);
    return ownerAction(actions, 'session.pause', { sessionId });
  });
  app.post('/api/sessions/:id/resume', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    parseBody(EmptyBodySchema, request.body);
    return ownerAction(actions, 'session.resume', { sessionId });
  });
  app.post('/api/sessions/:id/stop', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    const body = parseBody(StopBodySchema, request.body);
    return ownerAction(actions, 'session.stop', { sessionId, force: body.force ?? false }, body.pin);
  });
  app.post('/api/sessions/:id/restart', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    const { pin } = parseBody(PinBodySchema, request.body);
    return ownerAction(actions, 'session.restart', { sessionId }, pin);
  });
  app.post('/api/sessions/:id/delete', async (request) => {
    const sessionId = knownSessionId(sessions, request.params);
    const { pin } = parseBody(PinBodySchema, request.body);
    return ownerAction(actions, 'session.delete', { sessionId }, pin);
  });
};
