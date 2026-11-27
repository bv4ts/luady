import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { INTERNAL_PATHS, TOOL_DEFS, type ToolName } from '@luady/shared';
import type { AddonToolRegistry } from '../channels/addon-tools.js';
import { ADDON_PATH_PREFIX, FRAME_MAX_BYTES } from '../channels/host.js';
import type { HubConfig, Logger, ToolContext, ToolHandler } from '../core/contracts.js';
import { HubError } from '../core/errors.js';
import { MANAGER_OFF_CODE, ManagerOffError } from '../luady/errors.js';
import { toolHostRefusal } from '../tools/common.js';
import { bearerMatches } from './auth.js';

/** The add-ons' part of the tool context: their tools, and how to tell an add-on's token from the hub's. */
export interface AddonsSeam {
  readonly tools: Pick<AddonToolRegistry, 'catalogue' | 'has' | 'call'>;
  /** True for any add-on's token: refused (403) on every route but the add-on's own. */
  isAddonToken(bearer: string | undefined): boolean;
}

declare module '../core/contracts.js' {
  interface ToolContext {
    /** The add-ons' tools and tokens; absent on a hub built without channels. */
    addons?: AddonsSeam;
  }
}

export interface InternalDeps {
  config: HubConfig;
  log: Logger;
  handlers: Record<ToolName, ToolHandler>;
  toolContext: ToolContext;
  /** Called after a tool that messages the owner succeeded (see OWNER_MESSAGE_TOOLS). */
  onOwnerTold?: () => void;
  /**
   * Whether the manager is switched on and ready, asked at every call. The manager's tool routes answer only then: a
   * manager session left over after the switch went off gets nothing.
   */
  managerReady: () => boolean;
  /**
   * Route plugins the wire modules contribute (the add-on route, the status route). Every one sits behind the hub
   * token, except the add-on route under `/internal/addon/`, which checks the add-on's own token.
   */
  routes?: readonly FastifyPluginAsync[];
}

/** Tools whose success means the owner already got a chat message in this turn. */
/** send_file is not here: files come with a caption only, so the summary the manager writes after them must still be sent. */
export const OWNER_MESSAGE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['notify_user', 'mission_done']);

const BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const TOOL_NAME_ECHO_MAX = 64;
type ToolRequest = FastifyRequest<{ Params: { name: string } }>;

const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_DEFS, name);

function statusCodeOf(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  return 500;
}

/** The manager is off or not ready: 409 `manager_off`, before the tool's name or arguments are looked at. */
function managerOff(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({ ok: false, error: new ManagerOffError().message, code: MANAGER_OFF_CODE });
}

function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** An add-on tool: the hub checks only the size of the arguments; the add-on validates them. */
async function runAddonTool(deps: InternalDeps, addons: AddonsSeam, name: string, request: ToolRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const answer = await addons.tools.call(name, request.body ?? {});
    return reply.code(200).send(answer.ok ? { ok: true, text: answer.text } : { ok: false, error: answer.text });
  } catch (err) {
    if (err instanceof HubError) return reply.code(200).send({ ok: false, error: err.message });
    deps.log.error({ err, tool: name }, 'internal: add-on tool call failed');
    return reply.code(500).send({ ok: false, error: 'Internal error' });
  }
}

async function runTool(deps: InternalDeps, request: ToolRequest, reply: FastifyReply): Promise<FastifyReply> {
  const name = request.params.name;
  const addons = deps.toolContext.addons;
  // A name an add-on offers is never a live built-in (the registry refuses those), so the order cannot shadow one.
  if (addons?.tools.has(name) === true) return runAddonTool(deps, addons, name, request, reply);
  if (!isToolName(name)) {
    return reply.code(404).send({ ok: false, error: `Unknown tool: ${name.slice(0, TOOL_NAME_ECHO_MAX)}` });
  }
  const schema: z.ZodType = TOOL_DEFS[name].input;
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ ok: false, error: z.prettifyError(parsed.error) });
  const refusal = toolHostRefusal(name, parsed.data, deps.toolContext.fleet);
  if (refusal !== null) return reply.code(400).send({ ok: false, error: refusal });
  try {
    const text = await deps.handlers[name](parsed.data, deps.toolContext);
    if (OWNER_MESSAGE_TOOLS.has(name)) deps.onOwnerTold?.();
    return reply.code(200).send({ ok: true, text });
  } catch (err) {
    if (err instanceof HubError) return reply.code(200).send({ ok: false, error: err.message });
    deps.log.error({ err, tool: name }, 'internal: tool handler failed');
    return reply.code(500).send({ ok: false, error: 'Internal error' });
  }
}

/** `GET /internal/tools`: the built-in tool names, plus each connected add-on's tools with the id of the add-on that owns it. */
function toolList(deps: InternalDeps): {
  ok: true; builtin: readonly string[]; addon: Array<{ name: string; description: string; input: Record<string, unknown>; addon: string }>;
} {
  const catalogue = deps.toolContext.addons?.tools.catalogue();
  const builtin = catalogue?.builtin ?? Object.keys(TOOL_DEFS);
  const addon = (catalogue?.addon ?? []).map((tool) => ({ name: tool.name, description: tool.description, input: tool.input, addon: tool.addon }));
  return { ok: true, builtin, addon };
}

export async function createInternalServer(deps: InternalDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
  await app.register(websocket, { options: { maxPayload: FRAME_MAX_BYTES } });

  app.addHook('onRequest', async (request, reply) => {
    // The add-on route checks the add-on's own token before the upgrade (channels/host.ts).
    if (pathOf(request.url).startsWith(ADDON_PATH_PREFIX)) return;
    if (!bearerMatches(request.headers.authorization, deps.config.hubSocketToken)) {
      // An add-on's token is real but belongs on its own route only.
      const foreign = deps.toolContext.addons?.isAddonToken(request.headers.authorization) === true;
      return reply.code(foreign ? 403 : 401).send({ ok: false, error: foreign ? 'forbidden' : 'unauthorized' });
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    const status = statusCodeOf(err);
    if (status >= 500) deps.log.error({ err }, 'internal: request failed');
    const message = status < 500 && err instanceof Error ? err.message : 'Internal error';
    return reply.code(status).send({ ok: false, error: message });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ ok: false, error: 'not found' }));

  app.get(INTERNAL_PATHS.health, async () => ({ ok: true }));
  app.get(INTERNAL_PATHS.tools, async (_request, reply) => (deps.managerReady() ? toolList(deps) : managerOff(reply)));
  app.post<{ Params: { name: string } }>(`${INTERNAL_PATHS.tools}/:name`, async (request, reply) => (
    deps.managerReady() ? runTool(deps, request, reply) : managerOff(reply)
  ));
  for (const plugin of deps.routes ?? []) await app.register(plugin);

  return app;
}
