import {
  ExecBodySchema,
  FileWriteBodySchema,
  PinBodySchema,
  TerminalOpenBodySchema,
  type ActionDTO,
  type HostId,
} from '@luady/shared';
import { NotFoundError, RefusedError } from '../../core/errors.js';
import type { Fleet } from '../../core/contracts.js';
import type { RouteModule, WebContext } from '../context.js';
import { PinRequiredError } from '../errors.js';
import { ownerAction } from '../owner-action.js';
import { FILE_READ_MAX_BYTES, FilePathQuerySchema, ServerParamsSchema, TICKET_RE } from '../schemas.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

/** `:name` is any host id on the wire; it must be a server or this computer the fleet has (never the manager's own). */
function serverParam(fleet: Pick<Fleet, 'hasServer' | 'hasLocal'>, params: unknown): HostId {
  const name = parseParams(ServerParamsSchema, params).name;
  if (!fleet.hasServer(name) && !fleet.hasLocal(name)) throw new NotFoundError(`Unknown server: ${name}`);
  return name;
}

/** Tier 0/1: the classifier decides; tier 1 without a PIN in the body → 428 pin_required. */
async function exec(ctx: WebContext, server: HostId, rawBody: unknown): Promise<ActionDTO> {
  const body = parseBody(ExecBodySchema, rawBody);
  const verdict = ctx.deps.classify(body.command);
  if (verdict.tier === 1 && body.pin === undefined) throw new PinRequiredError(`PIN required: ${verdict.reason}`);
  const params = { server, command: body.command, ...(body.cwd === undefined ? {} : { cwd: body.cwd }) };
  return ownerAction(ctx.deps.actions, 'server.exec', params, verdict.tier === 1 ? body.pin : undefined);
}

/**
 * The terminal.open action issues the single-use ticket (TicketStore.issue) and returns it as `result`. The ticket
 * is bound to the session asking (`sid`): the terminal socket of any other session is refused.
 */
async function openTerminal(ctx: WebContext, rawBody: unknown, sid: string | undefined): Promise<{ ticket: string }> {
  const body = parseBody(TerminalOpenBodySchema, rawBody);
  if (sid === undefined) throw new RefusedError('The terminal could not be opened');
  const params = { server: body.server, target: body.target };
  const action = await ownerAction(ctx.deps.actions, 'terminal.open', params, body.pin, { sid });
  if (action.status !== 'done' || action.result === null || !TICKET_RE.test(action.result)) {
    throw new RefusedError(action.error ?? 'The terminal could not be opened');
  }
  return { ticket: action.result };
}

export const serverRoutes: RouteModule = (app, ctx) => {
  const { fleet, projects, actions } = ctx.deps;
  app.get('/api/servers', async () => fleet.servers());
  app.get('/api/servers/:name/projects', async (request) => projects.list(serverParam(fleet, request.params)));
  app.post('/api/servers/:name/exec', async (request) => exec(ctx, serverParam(fleet, request.params), request.body));
  app.get('/api/servers/:name/file', async (request) => {
    const server = serverParam(fleet, request.params);
    const { path } = parseQuery(FilePathQuerySchema, request.query);
    // This computer's hub folders (its config, secrets, data, the manager's home) are refused here too.
    const why = fleet.hubPathRefusal?.(server, path) ?? null;
    if (why !== null) throw new RefusedError(why);
    return fleet.client(server).fileRead(path, FILE_READ_MAX_BYTES);
  });
  app.put('/api/servers/:name/file', async (request) => {
    const server = serverParam(fleet, request.params);
    const body = parseBody(FileWriteBodySchema, request.body);
    return ownerAction(actions, 'server.file_write', { server, path: body.path, content: body.content }, body.pin);
  });
  app.post('/api/servers/:name/update-claude', async (request) => {
    const server = serverParam(fleet, request.params);
    const { pin } = parseBody(PinBodySchema, request.body);
    return ownerAction(actions, 'server.claude_update', { server }, pin);
  });
  app.post('/api/terminal/open', async (request) => openTerminal(ctx, request.body, request.luadySession?.sid));
};
