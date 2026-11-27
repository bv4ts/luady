import { z } from 'zod';
import { LIMITS, type WinsDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { parseQuery } from '../validate.js';

const WinsQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(LIMITS.winsDaysMax).default(LIMITS.winsDaysDefault),
});

/** The wins wall: what shipped in the last days. */
export const winsRoutes: RouteModule = (app, ctx) => {
  const { wins } = ctx.deps;
  app.get('/api/wins', async (request): Promise<WinsDTO> => wins.wins(parseQuery(WinsQuerySchema, request.query).days));
};
