import { z } from 'zod';
import {
  CreateKbPageBodySchema, HostIdSchema, KbScopeSchema, KbSyncBodySchema, LIMITS, UpdateKbPageBodySchema, type KbListDTO,
  type KbPageFullDTO,
} from '@luady/shared';
import type { Fleet } from '../../core/contracts.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { EmptyBodySchema } from '../schemas.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

/** A page's or a copy's host: a server or this computer the fleet has (checked at run time). Absent passes. */
function knownHost<T extends string | undefined>(fleet: Pick<Fleet, 'hasServer' | 'hasLocal'>, named: T): T {
  if (typeof named === 'string' && !fleet.hasServer(named) && !fleet.hasLocal(named)) throw new ValidationError(`Unknown server: ${named}`);
  return named;
}

const blank = (value: unknown): unknown => (value === '' ? undefined : value);
const PageParamsSchema = z.strictObject({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const KbQuerySchema = z.strictObject({
  scope: z.preprocess(blank, KbScopeSchema.optional()),
  server: z.preprocess(blank, HostIdSchema.optional()),
  project: z.preprocess(blank, z.string().max(LIMITS.boardProjectMax).optional()),
  query: z.preprocess(blank, z.string().max(200).optional()),
});

/** The knowledge base: pages, and their copy to every server's ~/luady-kb/. */
export const kbRoutes: RouteModule = (app, ctx) => {
  const { kb, fleet } = ctx.deps;
  const pageId = (params: unknown): number => parseParams(PageParamsSchema, params).id;
  app.get('/api/kb', async (request): Promise<KbListDTO> => kb.list(parseQuery(KbQuerySchema, request.query)));
  app.post('/api/kb/sync', async (request): Promise<{ ok: true }> => {
    const { server } = parseBody(KbSyncBodySchema, request.body);
    await kb.sync(knownHost(fleet, server));
    return { ok: true };
  });
  app.get('/api/kb/:id', async (request): Promise<KbPageFullDTO> => {
    const id = pageId(request.params);
    const page = kb.get(id);
    if (page === null) throw new NotFoundError(`No knowledge page ${id}`);
    return page;
  });
  app.post('/api/kb', async (request): Promise<KbPageFullDTO> => {
    const body = parseBody(CreateKbPageBodySchema, request.body);
    knownHost(fleet, body.server);
    return kb.create(body, 'owner');
  });
  app.put('/api/kb/:id', async (request): Promise<KbPageFullDTO> =>
    kb.update(pageId(request.params), parseBody(UpdateKbPageBodySchema, request.body), 'owner'));
  app.post('/api/kb/:id/delete', async (request): Promise<{ ok: true }> => {
    const id = pageId(request.params);
    parseBody(EmptyBodySchema, request.body);
    await kb.remove(id);
    return { ok: true };
  });
};
