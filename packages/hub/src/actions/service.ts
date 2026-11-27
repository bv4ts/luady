import { z } from 'zod';
import { ACTION_ACTORS, ACTION_ID_RE, ChannelSchema, type ActionDTO, type Channel, type HostId } from '@luady/shared';
import type {
  ActionRecordEntry,
  ActionRequest,
  ActionService,
  Clock,
  Db,
  EventBus,
  Fleet,
  Logger,
  PinService,
  SessionService,
  OwnerChannel,
  QuestionService,
} from '../core/contracts.js';
import { KitTooOldError, NotFoundError, RefusedError, SessionPausedError, ValidationError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import type { PauseService } from '../activity/pause.js';
import type { TicketStore } from '../security/tickets.js';
import { executeAction, execFolder, type AccountActions } from './execute.js';
import { ACTION_KINDS, parseActionParams, type ParsedAction } from './params.js';
import { actionText, describeAction, tierOf } from './policy.js';
import { ACTION_LIST_MAX, createActionStore, toActionDTO, type ActionChange, type ActionRecord, type ActionStore } from './store.js';
import { clipText, sessionLabel } from './text.js';
import { visibleLines } from './visible.js';

export interface ActionDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  fleet: Fleet;
  sessions: SessionService;
  pin: PinService;
  channel: Pick<OwnerChannel, 'unlink'>;
  tickets: TicketStore;
  pauses: Pick<PauseService, 'pause' | 'resume'>;
  /** Sign-in and sign-out of Claude hosts and Codex (accounts/actions.ts). */
  accounts?: AccountActions;
  /** The manager's answers to sessions' questions: checked when asked, delivered when approved. */
  questions?: Pick<QuestionService, 'check' | 'answer'>;
  /** The host's sign-in is known to be out: a sign-in start there is tier 0 (actions/policy.ts). */
  hostSignedOut?: (host: HostId) => boolean;
  /** Owner setting: false means tier-1 actions run at once, without a PIN. Defaults to true. */
  requirePin?: () => boolean;
  /**
   * True only while the manager's running turn answers a message from the owner (luady/replies.ts). Absent, false or
   * unknown: the manager's session starts and sends wait for the PIN (actions/policy.ts).
   */
  managerOwnerTurn?: () => boolean;
}

/** Pending confirmations expire after 30 minutes. */
export const ACTION_TTL_MS = 30 * 60_000;
const ERROR_MAX = 2000;
/** The ticket goes back only to the caller; the audit row and the bus get this note. */
const TICKET_AUDIT_TEXT = 'terminal ticket issued (single use, valid 60 s)';

const RequestSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  actor: z.enum(ACTION_ACTORS),
  channel: ChannelSchema,
  params: z.record(z.string(), z.unknown()),
  pin: z.string().max(64).optional(),
  alwaysPin: z.boolean().optional(),
  sid: z.string().min(1).max(256).optional(),
});

interface Ctx {
  readonly deps: ActionDeps;
  readonly store: ActionStore;
}

type Outcome = { readonly ok: true; readonly result: string } | { readonly ok: false; readonly error: string; readonly cause: unknown };

/**
 * Refusals with a machine-readable code the website shows in plain words (`session_paused`, `kit_too_old`): the action
 * is still recorded as failed, then the error reaches the caller so the route answers 409 with that code.
 */
function isCodedRefusal(err: unknown): boolean {
  return err instanceof SessionPausedError || err instanceof KitTooOldError;
}

function now(ctx: Ctx): string {
  return isoNow(ctx.deps.clock);
}

function publish(ctx: Ctx, record: ActionRecord): ActionDTO {
  const dto = toActionDTO(record);
  ctx.deps.bus.emit('action.updated', dto);
  return dto;
}

function errorText(err: unknown): string {
  return clipText(err instanceof Error ? err.message : String(err), ERROR_MAX);
}

function labelFor(ctx: Ctx, sessionId: string): string {
  const session = ctx.deps.sessions.get(sessionId);
  if (session === undefined) throw new NotFoundError(`Unknown session ${sessionId}`);
  return sessionLabel(session);
}

/**
 * A host an action names must be one the fleet has, checked when it is asked: a server or this computer
 * for work on it, an SSH server for a terminal, any host (the manager's own included) or Codex for a sign-in.
 */
function checkHosts(ctx: Ctx, action: ParsedAction): void {
  const { fleet } = ctx.deps;
  const known = (host: string): boolean => fleet.hasServer(host) || fleet.hasLocal(host);
  switch (action.kind) {
    case 'session.start':
    case 'server.exec':
    case 'server.file_write':
    case 'server.claude_update':
      if (!known(action.params.server)) throw new ValidationError(`Unknown server: ${action.params.server}`);
      return;
    case 'terminal.open':
      if (!fleet.hasServer(action.params.server)) throw new ValidationError(`Unknown server: ${action.params.server}`);
      return;
    case 'account.login':
    case 'account.logout':
      if (action.params.target !== 'codex' && !fleet.hasHost(action.params.target)) throw new ValidationError(`Unknown host: ${action.params.target}`);
      return;
    default:
      return;
  }
}

/**
 * A file write or a session start in the hub's own folders on "this computer" is refused before anything is stored, to
 * the owner and the manager alike and whatever the PIN (security/hub-paths.ts). The fleet checks file verbs again.
 */
function checkHubPaths(ctx: Ctx, action: ParsedAction): void {
  const refusal = (server: string, path: string, use: 'read' | 'write'): string | null => ctx.deps.fleet.hubPathRefusal?.(server, path, use) ?? null;
  const why = action.kind === 'server.file_write' ? refusal(action.params.server, action.params.path, 'write')
    : action.kind === 'session.start' ? refusal(action.params.server, action.params.cwd, 'read')
      : null;
  if (why !== null) throw new RefusedError(why);
}

/**
 * An answer to a session's question is checked when it is asked (the question is open, the answers fit it and none is
 * shaped like the PIN), so a bad one is refused at once instead of waiting for the PIN. Returns the question's session.
 */
function checkQuestion(ctx: Ctx, action: ParsedAction): string | null {
  if (action.kind !== 'question.answer') return null;
  if (ctx.deps.questions === undefined) throw new RefusedError('Questions are not available on this hub');
  return ctx.deps.questions.check(action.params.qid, action.params.answers).sessionLabel;
}

function lookup(ctx: Ctx, id: string): ActionRecord | undefined {
  return ACTION_ID_RE.test(id) ? ctx.store.get(id) : undefined;
}

function notPending(ctx: Ctx, id: string): RefusedError {
  return new RefusedError(`Action ${id} is ${lookup(ctx, id)?.status ?? 'unknown'}, not waiting for confirmation`);
}

function requirePending(ctx: Ctx, id: string): ActionRecord {
  const record = lookup(ctx, id);
  if (record === undefined) throw new NotFoundError(`Unknown action ${id}`);
  if (record.status !== 'pending_confirmation') throw notPending(ctx, id);
  return record;
}

function isStale(ctx: Ctx, record: ActionRecord): boolean {
  return ctx.deps.clock.now().getTime() - Date.parse(record.createdAt) >= ACTION_TTL_MS;
}

function expire(ctx: Ctx, record: ActionRecord): boolean {
  const expired = ctx.store.transition(record.id, 'pending_confirmation', { status: 'expired', decidedAt: now(ctx) });
  if (expired === null) return false;
  publish(ctx, expired);
  return true;
}

async function attempt(ctx: Ctx, record: ActionRecord, sid: string | undefined): Promise<Outcome> {
  try {
    const action = parseActionParams(record.kind, record.params);
    const context = { actor: record.actor, channel: record.channel, ...(sid === undefined ? {} : { sid }) };
    return { ok: true, result: await executeAction(action, context, ctx.deps) };
  } catch (err) {
    return { ok: false, error: errorText(err), cause: err };
  }
}

/** `sid`: the website session that asked, when the action runs within its request (never stored). */
async function run(ctx: Ctx, record: ActionRecord, sid?: string): Promise<ActionDTO> {
  const outcome = await attempt(ctx, record, sid);
  const isTicket = record.kind === 'terminal.open';
  const change: ActionChange = outcome.ok
    ? { status: 'done', executedAt: now(ctx), resultText: isTicket ? TICKET_AUDIT_TEXT : outcome.result }
    : { status: 'failed', executedAt: now(ctx), error: outcome.error };
  if (!outcome.ok) ctx.deps.log.warn({ id: record.id, kind: record.kind, error: outcome.error }, 'action failed');
  const finished = ctx.store.transition(record.id, 'approved', change);
  if (finished === null) throw new RefusedError(`Action ${record.id} changed while it was running`);
  const dto = publish(ctx, finished);
  if (!outcome.ok && isCodedRefusal(outcome.cause)) throw outcome.cause;
  return outcome.ok && isTicket ? { ...dto, result: outcome.result } : dto;
}

/** Compare-and-set to approved, so a deny or expiry that won the race is never executed. */
async function approveAndRun(ctx: Ctx, id: string, sid?: string): Promise<ActionDTO> {
  const approved = ctx.store.transition(id, 'pending_confirmation', { status: 'approved', decidedAt: now(ctx) });
  if (approved === null) throw notPending(ctx, id);
  publish(ctx, approved);
  return run(ctx, approved, sid);
}

/** A server command without a folder gets the host's own one (actions/execute.ts execFolder), so it is classified there. */
function withExecFolder(action: ParsedAction, fleet: Pick<Fleet, 'hostInfo'>): ParsedAction {
  if (action.kind !== 'server.exec' || action.params.cwd !== undefined) return action;
  return { ...action, params: { ...action.params, cwd: execFolder(fleet, action.params.server) } };
}

async function request(ctx: Ctx, req: ActionRequest): Promise<ActionDTO> {
  const parsed = RequestSchema.safeParse(req);
  if (!parsed.success) throw new ValidationError(`Invalid action request: ${z.prettifyError(parsed.error)}`);
  const { kind, actor, channel, params, pin, alwaysPin, sid } = parsed.data;
  const asked = parseActionParams(kind, params);
  checkHosts(ctx, asked);
  checkHubPaths(ctx, asked);
  const askedOf = checkQuestion(ctx, asked);
  // A command without a folder runs in the host's own home: named in the stored row, not in the owner's summary.
  const action = withExecFolder(asked, ctx.deps.fleet);
  const verdict = alwaysPin === true
    ? { tier: 1 as const, reason: 'an account change on the website always needs the PIN' }
    : tierOf(action, {
      actor,
      ownerTurn: actor === 'manager' && ctx.deps.managerOwnerTurn?.() === true,
      ...(ctx.deps.hostSignedOut === undefined ? {} : { signedOut: ctx.deps.hostSignedOut }),
    });
  const autoApproved = verdict.tier === 1 && alwaysPin !== true && ctx.deps.requirePin?.() === false;
  const stamp = now(ctx);
  const record = ctx.store.insert({
    actor,
    channel,
    kind,
    tier: verdict.tier,
    summary: describeAction(asked, (sessionId) => labelFor(ctx, sessionId), () => askedOf),
    params: action.params,
    status: verdict.tier === 0 || autoApproved ? 'approved' : 'pending_confirmation',
    createdAt: stamp,
    decidedAt: verdict.tier === 0 || autoApproved ? stamp : null,
  });
  ctx.deps.log.info({ id: record.id, kind, actor, channel, tier: verdict.tier, autoApproved }, 'action requested');
  publish(ctx, record);
  if (verdict.tier === 0 || autoApproved) return run(ctx, record, sid);
  if (pin === undefined) return toActionDTO(record);
  await ctx.deps.pin.verify(pin, channel);
  return approveAndRun(ctx, record.id, sid);
}

async function confirm(ctx: Ctx, id: string, pin: string, via: Channel): Promise<ActionDTO> {
  const record = requirePending(ctx, id);
  if (isStale(ctx, record)) {
    expire(ctx, record);
    throw new RefusedError(`Action ${id} expired`);
  }
  await ctx.deps.pin.verify(pin, via);
  ctx.deps.log.info({ id, via }, 'action confirmed');
  return approveAndRun(ctx, id);
}

async function deny(ctx: Ctx, id: string, via: Channel): Promise<ActionDTO> {
  requirePending(ctx, id);
  const denied = ctx.store.transition(id, 'pending_confirmation', { status: 'denied', decidedAt: now(ctx) });
  if (denied === null) throw notPending(ctx, id);
  ctx.deps.log.info({ id, via }, 'action denied');
  return publish(ctx, denied);
}

/** An audit row for what already happened: stored as done at once, published, never executed. */
function record(ctx: Ctx, entry: ActionRecordEntry): ActionDTO {
  const action = parseActionParams(entry.kind, entry.params);
  const stamp = now(ctx);
  const row = ctx.store.insert({
    actor: entry.actor, channel: entry.channel, kind: entry.kind, tier: 0, summary: entry.summary, params: action.params,
    status: 'approved', createdAt: stamp, decidedAt: stamp,
  });
  const done = ctx.store.transition(row.id, 'approved', { status: 'done', executedAt: stamp, resultText: entry.result });
  ctx.deps.log.info({ id: row.id, kind: entry.kind, actor: entry.actor }, 'action recorded');
  return publish(ctx, done ?? row);
}

/** The whole text of an action, hidden characters marked (the website's full view); see ActionService.fullText. */
function fullText(ctx: Ctx, id: string): string | null | undefined {
  const record = lookup(ctx, id);
  if (record === undefined) return undefined;
  const text = actionText(parseActionParams(record.kind, record.params));
  return text === null ? null : visibleLines(text);
}

function sweepExpired(ctx: Ctx): number {
  const cutoff = new Date(ctx.deps.clock.now().getTime() - ACTION_TTL_MS).toISOString();
  return ctx.store.pendingCreatedUpTo(cutoff).filter((record) => expire(ctx, record)).length;
}

export function createActionService(deps: ActionDeps): ActionService {
  const ctx: Ctx = { deps, store: createActionStore(deps.db) };
  return {
    request: (req) => request(ctx, req),
    confirm: (id, pin, via) => confirm(ctx, id, pin, via),
    deny: (id, via) => deny(ctx, id, via),
    get: (id) => {
      const record = lookup(ctx, id);
      return record === undefined ? undefined : toActionDTO(record);
    },
    list: (filter) => ctx.store.list(filter).map(toActionDTO),
    pending: () => ctx.store.list({ status: 'pending_confirmation', limit: ACTION_LIST_MAX }).map(toActionDTO),
    sweepExpired: () => sweepExpired(ctx),
    record: (entry) => record(ctx, entry),
    fullText: (id) => fullText(ctx, id),
  };
}
