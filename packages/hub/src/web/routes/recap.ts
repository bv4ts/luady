import { z } from 'zod';
import type { RecapDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { parseQuery } from '../validate.js';

/** A missing or unreadable `since` is a 400; the service clamps it to the last 7 days. */
const RecapQuerySchema = z.strictObject({ since: z.iso.datetime({ offset: true }) });

/** The welcome-back card: what happened since the owner was last here. */
export const recapRoutes: RouteModule = (app, ctx) => {
  const { recap } = ctx.deps;
  app.get('/api/recap', async (request): Promise<RecapDTO> => recap.recap(new Date(parseQuery(RecapQuerySchema, request.query).since)));
};
