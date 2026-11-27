import { z } from 'zod';
import type { RouteModule } from '../context.js';
import { parseQuery } from '../validate.js';
import { connectCallback, sendPage } from './connect.js';

const CallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(), state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(), error_description: z.string().max(500).optional(),
});

/**
 * Wispr Flow's OAuth redirect. Cross-site, so the strict session cookie never arrives: it is session-exempt. A website
 * link gets the return page (finished there with the session); a `/wispr` chat link is finished by its
 * single-use state.
 */
export const wisprRoutes: RouteModule = (app, ctx) => {
  const connect = ctx.deps.connect;
  const ready = ctx.deps.meetings !== undefined && ctx.deps.meetings !== null && connect !== undefined;
  app.get('/api/wispr/callback', async (request, reply) => {
    const query = parseQuery(CallbackQuery, request.query);
    if (!ready || connect === undefined) return sendPage(reply, 404, 'Meetings are not set up on the hub.');
    const failed = query.error_description ?? query.error ?? null;
    return connectCallback(ctx, connect, 'wispr', query, reply, failed);
  });
};
