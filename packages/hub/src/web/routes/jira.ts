import { z } from 'zod';
import {
  JiraAssignBodySchema, JiraCommentBodySchema, JiraConnectBodySchema, JiraDisconnectBodySchema, JiraEditBodySchema, JiraKeySchema,
  JiraTransitionBodySchema, JiraViewSchema, RoomIdSchema, type JiraBoardDTO, type JiraIssueDetailDTO, type JiraSiteDTO,
  type JiraSitesDTO, type HostId,
} from '@luady/shared';
import type { RouteModule } from '../context.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

/** Jira is kept per room: `:server` is a room id. */
const ServerParamsSchema = z.strictObject({ server: RoomIdSchema });
const IssueParamsSchema = z.strictObject({ server: RoomIdSchema, key: JiraKeySchema });
const BoardQuerySchema = z.strictObject({
  view: z.preprocess((value) => (value === '' ? undefined : value), JiraViewSchema.default('sprint')),
  refresh: z.enum(['0', '1']).optional(),
});

/**
 * Jira per office. Connecting and disconnecting need the PIN, checked here before the
 * service runs; the token goes only to the service and never into a log or an answer.
 */
export const jiraRoutes: RouteModule = (app, ctx) => {
  const { jira, pin } = ctx.deps;
  const server = (params: unknown): HostId => parseParams(ServerParamsSchema, params).server;
  const issue = (params: unknown): { server: HostId; key: string } => parseParams(IssueParamsSchema, params);
  app.get('/api/jira', async (): Promise<JiraSitesDTO> => jira.sites());
  app.put('/api/jira/:server/connection', async (request): Promise<JiraSiteDTO> => {
    const office = server(request.params);
    const { baseUrl, email, token, pin: code } = parseBody(JiraConnectBodySchema, request.body);
    await pin.verify(code, 'web');
    return jira.connect(office, { baseUrl, email, token });
  });
  app.post('/api/jira/:server/disconnect', async (request): Promise<{ ok: true }> => {
    const office = server(request.params);
    await pin.verify(parseBody(JiraDisconnectBodySchema, request.body).pin, 'web');
    await jira.disconnect(office);
    return { ok: true };
  });
  app.get('/api/jira/:server/board', async (request): Promise<JiraBoardDTO> => {
    const office = server(request.params);
    const { view, refresh } = parseQuery(BoardQuerySchema, request.query);
    return jira.board(office, view, refresh === '1');
  });
  app.get('/api/jira/:server/issues/:key', async (request): Promise<JiraIssueDetailDTO> => {
    const at = issue(request.params);
    return jira.issue(at.server, at.key, { seen: true });
  });
  app.post('/api/jira/:server/issues/:key/transition', async (request): Promise<JiraIssueDetailDTO> => {
    const at = issue(request.params);
    return jira.transition(at.server, at.key, parseBody(JiraTransitionBodySchema, request.body).transitionId);
  });
  app.post('/api/jira/:server/issues/:key/comment', async (request): Promise<JiraIssueDetailDTO> => {
    const at = issue(request.params);
    return jira.comment(at.server, at.key, parseBody(JiraCommentBodySchema, request.body).text);
  });
  app.put('/api/jira/:server/issues/:key', async (request): Promise<JiraIssueDetailDTO> => {
    const at = issue(request.params);
    return jira.edit(at.server, at.key, parseBody(JiraEditBodySchema, request.body));
  });
  app.post('/api/jira/:server/issues/:key/assign', async (request): Promise<JiraIssueDetailDTO> => {
    const at = issue(request.params);
    return jira.assign(at.server, at.key, parseBody(JiraAssignBodySchema, request.body).me);
  });
};
