import { posix } from 'node:path';
import { z } from 'zod';
import { HostIdSchema, NAME_RE, QID_RE, TARGET_RE, isSelfHost, parseSessionId } from '@luady/shared';
import type { ActionKind } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { referencesDeniedPath } from '../security/risk-paths.js';


const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A session on any host but the manager's own (open ids; the action service checks the host exists). */
function isWorkerSessionId(id: string): boolean {
  const parsed = parseSessionId(id);
  return parsed !== null && !isSelfHost(parsed.host);
}

function isCleanAbsolutePath(path: string): boolean {
  return path.startsWith('/') && !CONTROL_CHARS.test(path);
}

/** A normalised absolute folder; that it lies in the host's projects folder is the session service's check (its row). */
function isProjectFolder(path: string): boolean {
  return isCleanAbsolutePath(path) && !path.split('/').includes('..') && posix.normalize(path) !== '/';
}

const Reason = z.string().max(300).optional();
/** A session asks at most a few questions at once; more answers than this is never a real reply. */
const ANSWERS_MAX = 10;
const SessionId = z.string().min(1).max(160).refine(isWorkerSessionId, 'must be a session on a server (not the manager\'s own)');
const AbsolutePath = z.string().min(1).max(1024).refine(isCleanAbsolutePath, 'must be an absolute path without control characters');
const ProjectDir = z.string().min(1).max(1024).refine(isProjectFolder, 'must be an absolute folder inside the server\'s projects folder');
const WritablePath = AbsolutePath.refine((path) => !referencesDeniedPath(path), 'is a protected path');
/** A server: any host id but the manager's own; the action service checks, when it is asked, that the fleet has it. */
const Server = HostIdSchema.refine((host) => !isSelfHost(host), 'must be a server, not the manager\'s own host');
/** A Claude sign-in host, or `codex` for the ChatGPT sign-in that makes images (open host ids). */
export const AccountTargetSchema = z.union([HostIdSchema, z.literal('codex')]);
export type AccountTarget = z.infer<typeof AccountTargetSchema>;

export const ACTION_PARAM_SCHEMAS = {
  'session.start': z.strictObject({
    server: Server,
    cwd: ProjectDir,
    prompt: z.string().max(20000).optional(),
    name: z.string().regex(NAME_RE).optional(),
    reason: Reason,
  }),
  'session.send': z.strictObject({ sessionId: SessionId, text: z.string().min(1).max(20000), reason: Reason }),
  'session.interrupt': z.strictObject({ sessionId: SessionId, reason: Reason }),
  'session.stop': z.strictObject({ sessionId: SessionId, force: z.boolean().default(false), reason: Reason }),
  'session.restart': z.strictObject({ sessionId: SessionId, reason: Reason }),
  'session.delete': z.strictObject({ sessionId: SessionId, reason: Reason }),
  'session.pause': z.strictObject({ sessionId: SessionId, reason: Reason }),
  'session.resume': z.strictObject({ sessionId: SessionId, reason: Reason }),
  'server.exec': z.strictObject({
    server: Server,
    command: z.string().min(1).max(4000),
    /** Absent: the host's own home (actions/execute.ts execFolder). */
    cwd: AbsolutePath.optional(),
    reason: Reason,
  }),
  'server.file_write': z.strictObject({ server: Server, path: WritablePath, content: z.string().max(500000), reason: Reason }),
  'server.claude_update': z.strictObject({ server: Server, reason: Reason }),
  'channel.unlink': z.strictObject({ reason: Reason }),
  'terminal.open': z.strictObject({ server: Server, target: z.string().regex(TARGET_RE).optional(), reason: Reason }),
  'account.login': z.strictObject({ target: AccountTargetSchema, reason: Reason }),
  'account.logout': z.strictObject({ target: AccountTargetSchema, reason: Reason }),
  'account.signed_in': z.strictObject({ target: AccountTargetSchema, reason: Reason }),
  // Each question's text to its answer (the question service checks they fit the question).
  'question.answer': z.strictObject({
    qid: z.string().regex(QID_RE),
    answers: z.record(z.string().max(5000), z.string().max(5000)).refine((answers) => Object.keys(answers).length <= ANSWERS_MAX, 'too many answers'),
    reason: Reason,
  }),
  // A record of the manager's knowledge-base write: the page it saved.
  'kb.write': z.strictObject({ page: z.string().min(1).max(160), reason: Reason }),
  // Records of the hosts flow: the host they changed.
  'host.add': z.strictObject({ host: HostIdSchema, reason: Reason }),
  'host.pin': z.strictObject({ host: HostIdSchema, reason: Reason }),
  'host.kit': z.strictObject({ host: HostIdSchema, reason: Reason }),
  'host.edit': z.strictObject({ host: HostIdSchema, reason: Reason }),
  'host.remove': z.strictObject({ host: HostIdSchema, reason: Reason }),
  'host.local': z.strictObject({ host: HostIdSchema, reason: Reason }),
} as const satisfies Record<ActionKind, z.ZodType>;

export const ACTION_KINDS = Object.keys(ACTION_PARAM_SCHEMAS) as ActionKind[];

export type ActionParams<K extends ActionKind> = z.infer<(typeof ACTION_PARAM_SCHEMAS)[K]>;
export type ParsedAction = { [K in ActionKind]: { readonly kind: K; readonly params: ActionParams<K> } }[ActionKind];

export function parseActionParams(kind: ActionKind, params: unknown): ParsedAction {
  const schema: z.ZodType | undefined = ACTION_PARAM_SCHEMAS[kind];
  if (schema === undefined) throw new ValidationError(`Unknown action kind ${String(kind)}`);
  const result = schema.safeParse(params);
  if (!result.success) throw new ValidationError(`Invalid parameters for ${kind}: ${z.prettifyError(result.error)}`);
  return { kind, params: result.data } as ParsedAction;
}
