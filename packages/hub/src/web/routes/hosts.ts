import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  HOST_GRANT_HEADER, HostGrantBodySchema, HostIdSchema, HostKitBodySchema, HostPinBodySchema, type HostCreatedDTO, type HostDTO, type HostGrantDTO,
  type HostJobDTO, type HostKeyDTO, type HostScanDTO,
} from '@luady/shared';
import { trustedProxyOf } from '../../config/defaults.js';
import { AuthError, NotFoundError } from '../../core/errors.js';
import { sha256Hex } from '../../core/ids.js';
import {
  HostAccessError, parseCreateBody, parseLocalBody, parseRemoveBody, parseUpdateBody, type HostCheckResult, type HostRemoveResult,
} from '../../hosts/index.js';
import type { RouteModule } from '../context.js';
import { clientIp } from '../rate-limit.js';
import { parseBody, parseParams } from '../validate.js';

/**
 * Hosts from the website. Every route sits behind the session, the page key and (for writes) the CSRF check of the
 * chain. On top of that each change needs the PIN in its body, or this host's grant in the `x-hub-grant` header (a PIN
 * check gave it, for ten minutes, to this session and this host only). Changes count in the `hosts` bucket (20 a
 * minute per client); scans and checks also in a per-host one (6 a minute). Without the PIN or the grant the answer is
 * 403; neither ever appears in an answer or a log line.
 */

const IdParamsSchema = z.strictObject({ id: HostIdSchema });

type Handler<T> = (request: FastifyRequest, sidHash: string, reply: FastifyReply) => Promise<T> | T;

/** The session's sid hash: grants are bound to it. The chain answers 401 before a route runs without a session. */
function sidHashOf(request: FastifyRequest): string {
  const session = request.luadySession;
  if (session === null) throw new AuthError('Login required');
  return sha256Hex(session.sid);
}

/** The PIN routes: a body without a PIN string is refused with 403 before anything is parsed. */
function requirePin(body: unknown): void {
  const pin = typeof body === 'object' && body !== null ? (body as { pin?: unknown }).pin : undefined;
  if (typeof pin !== 'string' || pin === '') throw new HostAccessError('pin_required', 'This change needs your PIN');
}

function grantOf(request: FastifyRequest): string | undefined {
  const value = request.headers[HOST_GRANT_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A handler with the session's sid hash. A missing PIN or grant (403) and a full hosts bucket (429, Retry-After) are
 * answered by the hub's error map (web/errors.ts).
 */
function guarded<T>(handler: Handler<T>): (request: FastifyRequest, reply: FastifyReply) => Promise<T> {
  return async (request, reply) => handler(request, sidHashOf(request), reply);
}

export const hostRoutes: RouteModule = (app, ctx) => {
  const { hosts } = ctx.deps;
  if (hosts === undefined) return;
  const trusted = trustedProxyOf(ctx.deps.config);
  const idOf = (request: FastifyRequest): string => parseParams(IdParamsSchema, request.params).id;
  const change = (request: FastifyRequest): void => hosts.limit('changes', clientIp(request, trusted));
  /**
   * A grant route: counted per client, then this host's grant checked, and only then (`probe` routes) counted per host,
   * so requests without the grant cannot use up a host's scans and checks.
   */
  const granted = (request: FastifyRequest, sidHash: string, probe = false): string => {
    const id = idOf(request);
    change(request);
    hosts.authorize(id, grantOf(request), sidHash);
    if (probe) hosts.limit('probe', id);
    return id;
  };
  const pinned = (request: FastifyRequest): void => {
    change(request);
    requirePin(request.body);
  };

  app.get('/api/hosts', async (): Promise<HostDTO[]> => hosts.list());
  app.get('/api/hosts/key', async (): Promise<HostKeyDTO> => hosts.key());
  app.get('/api/hosts/:id/job', async (request): Promise<HostJobDTO> => {
    const job = hosts.job(idOf(request));
    if (job === undefined) throw new NotFoundError('No kit job for this host yet');
    return job;
  });

  app.post('/api/hosts', guarded((request, sid): Promise<HostCreatedDTO> => {
    pinned(request);
    return hosts.create(parseCreateBody(request.body), sid);
  }));
  app.post('/api/hosts/local', guarded((request, sid): Promise<HostCreatedDTO> => {
    pinned(request);
    // On Windows the folder could never be right: say why before reading it.
    hosts.assertLocalSupported();
    return hosts.createLocal(parseLocalBody(request.body, hosts.home()), sid);
  }));
  app.post('/api/hosts/:id/grant', guarded((request, sid): Promise<HostGrantDTO> => {
    pinned(request);
    return hosts.grant(idOf(request), parseBody(HostGrantBodySchema, request.body).pin, sid);
  }));
  app.post('/api/hosts/:id/scan', guarded((request, sid): Promise<HostScanDTO> => hosts.scan(granted(request, sid, true))));
  app.post('/api/hosts/:id/pin', guarded((request, sid): Promise<HostDTO> => {
    const id = granted(request, sid);
    return hosts.pinKey(id, parseBody(HostPinBodySchema, request.body).fingerprint);
  }));
  app.post('/api/hosts/:id/check', guarded((request, sid): Promise<HostCheckResult> => hosts.check(granted(request, sid, true))));
  app.post('/api/hosts/:id/kit', guarded((request, sid, reply): HostJobDTO => {
    const id = granted(request, sid);
    const job = hosts.kit(id, parseBody(HostKitBodySchema, request.body).mode);
    reply.code(202);
    return job;
  }));
  app.put('/api/hosts/:id', guarded((request): Promise<HostDTO> => {
    pinned(request);
    return hosts.update(idOf(request), parseUpdateBody(request.body));
  }));
  app.post('/api/hosts/:id/remove', guarded((request): Promise<HostRemoveResult> => {
    pinned(request);
    return hosts.remove(idOf(request), parseRemoveBody(request.body));
  }));
};

