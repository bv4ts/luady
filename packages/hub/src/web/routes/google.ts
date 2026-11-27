import { z } from 'zod';
import type { RouteModule } from '../context.js';
import { parseQuery } from '../validate.js';
import { connectCallback, sendPage } from './connect.js';

const ConnectQuery = z.object({ t: z.string().min(16).max(100).optional() });
const CallbackQuery = z.object({ code: z.string().min(1).max(2048).optional(), state: z.string().min(1).max(200).optional(), error: z.string().max(200).optional() });

/**
 * Google account connect. Both routes are opened from links where the strict session cookie does not travel (the chat
 * link, then Google's redirect), so both are session-exempt. `/connect` trusts a single-use code that only reached the
 * owner's chat (`/google`); `/callback` serves the return page for a website link (finished there with
 * the session) and finishes a chat link by its single-use state.
 */
export const googleRoutes: RouteModule = (app, ctx) => {
  const connect = ctx.deps.connect;
  const ready = ctx.deps.google !== undefined && ctx.deps.google !== null && connect !== undefined;
  app.get('/api/google/connect', async (request, reply) => {
    if (!ready || connect === undefined) return sendPage(reply, 404, 'Google is not set up on the hub yet.');
    const { t } = parseQuery(ConnectQuery, request.query);
    const url = t === undefined ? null : connect.chatGoogleUrl(t);
    if (url === null) return sendPage(reply, 401, 'This link expired or was already used. Send /google for a new one, or connect from Settings on the website.');
    return reply.redirect(url);
  });
  app.get('/api/google/callback', async (request, reply) => {
    const query = parseQuery(CallbackQuery, request.query);
    if (!ready || connect === undefined) return sendPage(reply, 404, 'Google is not set up on the hub yet.');
    return connectCallback(ctx, connect, 'google', query, reply, query.error ?? null);
  });
};
