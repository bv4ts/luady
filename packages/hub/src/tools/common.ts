import { z } from 'zod';
import { TOOL_DEFS, isUnderRoot, type ActionDTO, type ToolInput, type ToolName } from '@luady/shared';
import type { ActionKind, Fleet, ToolContext, ToolHandler } from '../core/contracts.js';
import { RefusedError, ValidationError } from '../core/errors.js';

/** What a tool answers when its service is not wired into the hub. */
export const NOT_AVAILABLE_YET = 'Not available yet.';

export function parseToolInput<N extends ToolName>(name: N, input: unknown): ToolInput<N> {
  const schema: z.ZodType = TOOL_DEFS[name].input;
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(`Invalid input for ${name}: ${z.prettifyError(result.error)}`);
  return result.data as ToolInput<N>;
}

/** The Jira tools' `server` names a room (Jira is per room); the Jira service checks it. */
const ROOM_ARGUMENT_TOOLS: ReadonlySet<ToolName> = new Set(['jira_search', 'jira_get', 'jira_comment', 'jira_transition']);

/**
 * A tool's `server` takes any host id on the wire; the hub checks here, when the tool runs, that it
 * names a host the fleet has: an SSH server or this computer, or for send_file also the manager's own workspace on the
 * self host. The self host is never a server for any other tool.
 */
export function toolHostRefusal(name: ToolName, args: unknown, fleet: Pick<Fleet, 'hasServer' | 'hasLocal' | 'hasHost'>): string | null {
  if (ROOM_ARGUMENT_TOOLS.has(name)) return null;
  const named = typeof args === 'object' && args !== null ? (args as { server?: unknown }).server : undefined;
  if (typeof named !== 'string') return null;
  const known = name === 'send_file' ? fleet.hasHost(named) : fleet.hasServer(named) || fleet.hasLocal(named);
  return known ? null : `unknown server: ${named}`;
}

/**
 * A path in the hub's own folders on "this computer" is refused to every tool, whatever the PIN (security/hub-paths.ts);
 * the fleet refuses its file verbs there too, so this only says so before the kit is asked.
 */
export function refuseHubPath(fleet: Pick<Fleet, 'hubPathRefusal'>, server: string, path: string): void {
  const why = fleet.hubPathRefusal?.(server, path) ?? null;
  if (why !== null) throw new RefusedError(why);
}

/** A folder a session starts in must lie in that host's projects folder (the host's row). */
export function checkProjectFolder(fleet: Pick<Fleet, 'hostInfo'>, server: string, cwd: string): void {
  const root = fleet.hostInfo(server)?.projectsRoot ?? null;
  if (root === null || !isUnderRoot(cwd, root)) throw new ValidationError(`cwd must be inside the projects folder of ${server}${root === null ? '' : ` (${root})`}`);
}

/** Wraps a tool body with TOOL_DEFS input validation; defaults are applied before `run` sees the args. */
export function defineTool<N extends ToolName>(name: N, run: (args: ToolInput<N>, ctx: ToolContext) => Promise<string>): ToolHandler {
  return async (input, ctx) => {
    const args = parseToolInput(name, input);
    const refusal = toolHostRefusal(name, args, ctx.fleet);
    if (refusal !== null) throw new ValidationError(`Invalid input for ${name}: ${refusal}`);
    return run(args, ctx);
  };
}

/** Luady's own actions always run as actor luady on the event channel. */
export function requestAsLuady(ctx: ToolContext, kind: ActionKind, params: Record<string, unknown>): Promise<ActionDTO> {
  return ctx.actions.request({ kind, actor: 'manager', channel: 'event', params });
}

export function formatActionResult(dto: ActionDTO): string {
  switch (dto.status) {
    case 'pending_confirmation':
      return `pending_confirmation: action ${dto.id} — waiting for owner PIN (expires in 30 min).`;
    case 'done':
      return `done: action ${dto.id} — ${dto.result ?? 'ok'}`;
    case 'failed':
      return `failed: action ${dto.id} — ${dto.error ?? 'unknown error'}`;
    default:
      return `${dto.status}: action ${dto.id}`;
  }
}
