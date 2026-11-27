import { z } from 'zod';
import {
  CreateBoardItemBodySchema, UpdateBoardItemBodySchema, type BoardItemDTO, type BoardItemDetailDTO, type BoardListDTO,
} from '@luady/shared';
import { NotFoundError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { EmptyBodySchema } from '../schemas.js';
import { knownServer, parseBody, parseParams } from '../validate.js';

export const CardIdParamsSchema = z.strictObject({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/** The owner's board: list, add, open, edit and delete cards. */
export const boardRoutes: RouteModule = (app, ctx) => {
  const { board, fleet } = ctx.deps;
  app.get('/api/board', async (): Promise<BoardListDTO> => ({ items: board.list() }));
  app.post('/api/board', async (request): Promise<BoardItemDTO> => {
    const body = parseBody(CreateBoardItemBodySchema, request.body);
    knownServer(fleet, body.server);
    return board.add({ ...body, source: body.source ?? 'web' }, 'owner');
  });
  app.get('/api/board/:id', async (request): Promise<BoardItemDetailDTO> => {
    const { id } = parseParams(CardIdParamsSchema, request.params);
    const detail = board.detail(id);
    if (detail === null) throw new NotFoundError(`No card #${id}`);
    return detail;
  });
  app.put('/api/board/:id', async (request): Promise<BoardItemDTO> => {
    const { id } = parseParams(CardIdParamsSchema, request.params);
    const body = parseBody(UpdateBoardItemBodySchema, request.body);
    knownServer(fleet, body.server);
    return board.update(id, body, 'owner');
  });
  app.post('/api/board/:id/delete', async (request): Promise<{ ok: true }> => {
    const { id } = parseParams(CardIdParamsSchema, request.params);
    parseBody(EmptyBodySchema, request.body);
    await board.remove(id, 'owner');
    return { ok: true };
  });
};
