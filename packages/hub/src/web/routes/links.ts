import { z } from 'zod';
import { CreateLinkBodySchema, UpdateLinkBodySchema, type LinkDTO, type LinkListDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { EmptyBodySchema } from '../schemas.js';
import { knownServer, parseBody, parseParams } from '../validate.js';

const LinkParamsSchema = z.strictObject({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/** The links shelf: the owner's quick links per office; `https://` only. */
export const linkRoutes: RouteModule = (app, ctx) => {
  const { links, fleet } = ctx.deps;
  const linkId = (params: unknown): number => parseParams(LinkParamsSchema, params).id;
  app.get('/api/links', async (): Promise<LinkListDTO> => ({ items: links.list() }));
  // The office key is a room id on the wire; it is checked here as one of the fleet's servers.
  app.post('/api/links', async (request): Promise<LinkDTO> => {
    const body = parseBody(CreateLinkBodySchema, request.body);
    knownServer(fleet, body.server);
    return links.create(body);
  });
  app.put('/api/links/:id', async (request): Promise<LinkDTO> =>
    links.update(linkId(request.params), parseBody(UpdateLinkBodySchema, request.body)));
  app.post('/api/links/:id/delete', async (request): Promise<{ ok: true }> => {
    const id = linkId(request.params);
    parseBody(EmptyBodySchema, request.body);
    await links.remove(id);
    return { ok: true };
  });
};
