import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { PinSchema } from '@luady/shared';
import { CONNECT_SERVICES, ConnectForbiddenError, type ConnectKind } from '../../google/connect-flow.js';
import type { ConnectService } from '../../core/contracts.js';
import { HubError } from '../../core/errors.js';
import type { RouteModule, WebContext } from '../context.js';
import { errorBody } from '../errors.js';
import { parseBody, parseParams } from '../validate.js';

/** The static page the provider's redirect lands on (packages/web/public): its own script finishes the connect. */
export const CONNECT_RETURN_PAGE = 'connect-return.html';

const ServiceParamsSchema = z.strictObject({ service: z.enum(CONNECT_SERVICES) });
const StartBodySchema = z.strictObject({
  pin: PinSchema.optional(),
  /** Google only: the account's label (personal, work…). */
  label: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,23}$/i).optional(),
});
const FinishBodySchema = z.strictObject({ code: z.string().min(1).max(2048), state: z.string().min(1).max(200) });

function page(text: string): string {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect</title><body><p>${safe}</p></body>`;
}

/** A small text page (no script) for what the callback can answer by itself. */
export function sendPage(reply: FastifyReply, status: number, text: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(page(text));
}

/**
 * The provider's redirect. A website link's state is bound to a session the redirect cannot carry, so
 * the callback serves the static return page and finishes nothing; a chat link's state (no session) is finished here.
 * The page's script reads `code` and `state` from its own address and posts them to `finish`.
 */
export async function connectCallback(
  ctx: WebContext, connect: ConnectService, service: ConnectKind, query: { code?: string | undefined; state?: string | undefined },
  reply: FastifyReply, failed: string | null,
): Promise<FastifyReply> {
  if (failed !== null || query.code === undefined || query.state === undefined) {
    return sendPage(reply, 400, `The account did not connect (${failed ?? 'missing code'}). Try again from Settings on the website.`);
  }
  const plan = connect.callback(service, query.state);
  if (plan === 'expired') return sendPage(reply, 400, 'This connect link expired or was already used. Start again from Settings on the website.');
  if (plan === 'page') {
    const html = await readFile(join(ctx.deps.config.webDir, CONNECT_RETURN_PAGE), 'utf8').catch(() => null);
    if (html === null) return sendPage(reply, 503, 'The website is not built on this hub, so the connect cannot finish here.');
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }
  try {
    return sendPage(reply, 200, `✅ ${await connect.finishChat(service, query.state, query.code)} You can close this tab.`);
  } catch (err) {
    ctx.deps.log.warn({ service, err: err instanceof Error ? err.message : String(err) }, 'connect: a chat link callback failed');
    return sendPage(reply, 400, `❌ ${err instanceof Error ? err.message : 'Connection failed'}`);
  }
}

/** `POST /api/connect/:service { pin }` and its `finish`: session, page key and CSRF like any /api call. */
export const connectRoutes: RouteModule = (app, ctx) => {
  const connect = ctx.deps.connect;
  if (connect === undefined) return;
  app.post('/api/connect/:service', async (request, reply) => {
    const { service } = parseParams(ServiceParamsSchema, request.params);
    const body = parseBody(StartBodySchema, request.body);
    const sid = request.luadySession?.sid;
    if (sid === undefined) return reply.code(401).send(errorBody('auth', 'Login required'));
    // Connecting an account needs the PIN, as Jira does; a wrong one counts toward the lockout.
    if (body.pin === undefined) return reply.code(403).send(errorBody('pin_required', 'Enter your PIN to connect an account'));
    await ctx.deps.pin.verify(body.pin, 'web');
    if (!connect.available(service)) return reply.code(404).send(errorBody('not_found', `${service === 'google' ? 'Google' : 'Wispr Flow'} is not set up on this hub`));
    return connect.start(service, sid, body.label ?? null);
  });
  app.post('/api/connect/:service/finish', async (request, reply) => {
    const { service } = parseParams(ServiceParamsSchema, request.params);
    const { code, state } = parseBody(FinishBodySchema, request.body);
    const sid = request.luadySession?.sid;
    if (sid === undefined) return reply.code(401).send(errorBody('auth', 'Login required'));
    try {
      return { ok: true as const, message: await connect.finish(service, sid, state, code) };
    } catch (err) {
      if (err instanceof ConnectForbiddenError) return reply.code(403).send(errorBody('forbidden', err.message));
      if (err instanceof HubError) throw err;
      // The provider refused the code: said plainly, never a 500.
      ctx.deps.log.warn({ service, err: err instanceof Error ? err.message : String(err) }, 'connect: the provider refused the code');
      return reply.code(400).send(errorBody('connect_failed', err instanceof Error ? err.message : 'The account did not connect'));
    }
  });
};
