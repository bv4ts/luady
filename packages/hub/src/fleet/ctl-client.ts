import type { z } from 'zod';
import {
  CtlAuthCodeSchema,
  CtlAuthLoginSchema,
  CtlAuthLogoutSchema,
  CtlAuthStatusSchema,
  CtlCaptureSchema,
  CtlConfigSchema,
  CtlDeleteSchema,
  CtlErrorSchema,
  CtlExecSchema,
  CtlFileGetSchema,
  CtlFilePutSchema,
  CtlGraphQuerySchema,
  CtlGraphifyRunSchema,
  CtlFileReadSchema,
  CtlFileWriteSchema,
  CtlGitStatusSchema,
  CtlKbPutSchema,
  CtlOkSchema,
  CtlPauseSchema,
  CtlPendingSchema,
  CtlProjectsSchema,
  CtlResumeSchema,
  CtlSessionsSchema,
  CtlSkillsSchema,
  CtlStartSchema,
  CtlStopSchema,
  CtlSysinfoSchema,
  CtlTranscriptSchema,
  CtlUpdateSchema,
  CtlVersionSchema,
  LIMITS,
  PermissionAnswerFileSchema,
  QuestionAnswerFileSchema,
} from '@luady/shared';
import type { CtlClient, StartArgs } from '../core/contracts.js';
import { CtlError, ValidationError } from '../core/errors.js';
import {
  EXEC_TIMEOUT_MAX_SEC,
  FILE_CONTENT_MAX,
  FILE_GET_MAX,
  FILE_PUT_MAX,
  FILE_READ_MAX,
  FREE_TEXT_MAX,
  checkConfigKey,
  checkUploadName,
  checkConfigValue,
  checkInt,
  checkKey,
  checkName,
  checkPath,
  checkQid,
  checkTarget,
  checkText,
  checkTypedText,
  kbPutPayload,
  transcriptArgs,
} from './ctl-args.js';
import type { ExecOptions, ExecResult, Executor } from './executor.js';

export const CTL_TIMEOUT_MS = 60_000;
export const PROJECTS_TIMEOUT_MS = 120_000;
export const UPDATE_TIMEOUT_MS = 360_000;
export const EXEC_GRACE_MS = 30_000;
export const FILE_GET_TIMEOUT_MS = 300_000;
export const GRAPH_QUERY_TIMEOUT_MS = 150_000;
const GRAPHIFY_GRACE_MS = 60_000;
export const AUTH_LOGIN_TIMEOUT_MS = 45_000;
export const AUTH_CODE_TIMEOUT_MS = 75_000;
export const AUTH_LOGOUT_TIMEOUT_MS = 45_000;
/** Up to 2 MB of knowledge-base files over SSH. */
export const KB_PUT_TIMEOUT_MS = 120_000;
const AUTH_CODE_MAX = 1100;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'} ${issue.message}`)
    .join('; ');
}

/** Non-zero exit → CtlError from the `{"error":{code,message}}` reply, else `failed` with stderr detail. */
export function toCtlError(verb: string, result: ExecResult): CtlError {
  const exit = result.code ?? -1;
  const parsed = CtlErrorSchema.safeParse(parseJson(result.stdout));
  if (parsed.success) return new CtlError(parsed.data.error.code, parsed.data.error.message, exit);
  const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 300);
  return new CtlError('failed', `luady-ctl ${verb} exited with ${exit}: ${detail}`, exit);
}

export function parseCtlOutput<S extends z.ZodType>(schema: S, verb: string, result: ExecResult): z.output<S> {
  if (result.truncated) throw new CtlError('failed', `luady-ctl ${verb}: output exceeded the size cap`, result.code ?? -1);
  if (result.code !== 0) throw toCtlError(verb, result);
  const parsed = schema.safeParse(parseJson(result.stdout));
  if (!parsed.success) throw new CtlError('failed', `luady-ctl ${verb}: unexpected output (${issueSummary(parsed.error)})`, 0);
  return parsed.data;
}

function payloadJson<S extends z.ZodType>(schema: S, payload: unknown, what: string): string {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ValidationError(`invalid ${what}: ${issueSummary(parsed.error)}`);
  return JSON.stringify(parsed.data);
}

function startArgs(args: StartArgs): string[] {
  return [
    'start',
    '--name',
    checkName(args.name),
    '--cwd',
    checkPath(args.cwd),
    ...(args.model === undefined ? [] : ['--model', checkName(args.model, 'model')]),
    ...(args.resume === undefined ? [] : ['--resume', checkName(args.resume, 'resume session id')]),
  ];
}

/** Typed verbs over an Executor. Arguments are validated here; free text only ever travels on stdin. */
export function createCtlClient(executor: Executor): CtlClient {
  async function call<S extends z.ZodType>(schema: S, args: string[], opts: ExecOptions = {}): Promise<z.output<S>> {
    const result = await executor.exec(args, { timeoutMs: CTL_TIMEOUT_MS, ...opts });
    return parseCtlOutput(schema, args[0] ?? 'luady-ctl', result);
  }

  async function ok(args: string[], opts?: ExecOptions): Promise<void> {
    await call(CtlOkSchema, args, opts);
  }

  return {
    version: async () => call(CtlVersionSchema, ['version']),
    sysinfo: async () => call(CtlSysinfoSchema, ['sysinfo']),
    sessions: async () => call(CtlSessionsSchema, ['sessions']),
    pending: async () => call(CtlPendingSchema, ['pending']),
    answer: async (qid, payload) =>
      ok(['answer', '--qid', checkQid(qid)], { stdin: payloadJson(QuestionAnswerFileSchema, payload, 'answer payload') }),
    permission: async (qid, payload) =>
      ok(['permission', '--qid', checkQid(qid)], { stdin: payloadJson(PermissionAnswerFileSchema, payload, 'permission payload') }),
    send: async (target, text) => ok(['send', '--target', checkTarget(target)], { stdin: checkTypedText(text, FREE_TEXT_MAX, 'text') }),
    keys: async (target, key) => ok(['keys', '--target', checkTarget(target), '--key', checkKey(key)]),
    start: async (args) => call(CtlStartSchema, startArgs(args), { stdin: checkTypedText(args.prompt ?? '', FREE_TEXT_MAX, 'prompt', true) }),
    stop: async (target, force) => call(CtlStopSchema, ['stop', '--target', checkTarget(target), ...(force ? ['--force'] : [])]),
    restart: async (target) => ok(['restart', '--target', checkTarget(target)]),
    remove: async (sessionId) => call(CtlDeleteSchema, ['delete', '--session', checkName(sessionId, 'session id')]),
    transcript: async (sessionId, window) =>
      call(CtlTranscriptSchema, ['transcript', '--session', checkName(sessionId, 'session id'), ...transcriptArgs(window)]),
    capture: async (target, lines) =>
      (await call(CtlCaptureSchema, ['capture', '--target', checkTarget(target), '--lines', checkInt(lines, 1, LIMITS.captureLinesMax, 'lines')])).text,
    updateClaude: async () => call(CtlUpdateSchema, ['update-claude'], { timeoutMs: UPDATE_TIMEOUT_MS }),
    projects: async () => call(CtlProjectsSchema, ['projects'], { timeoutMs: PROJECTS_TIMEOUT_MS }),
    exec: async (command, cwd, timeoutSec) =>
      call(CtlExecSchema, ['exec', '--cwd', checkPath(cwd), '--timeout', checkInt(timeoutSec, 1, EXEC_TIMEOUT_MAX_SEC, 'timeout')], {
        stdin: checkText(command, FREE_TEXT_MAX, 'command'),
        timeoutMs: timeoutSec * 1000 + EXEC_GRACE_MS,
      }),
    fileRead: async (path, maxBytes) =>
      call(CtlFileReadSchema, ['file-read', '--path', checkPath(path), '--max', checkInt(maxBytes, 1, FILE_READ_MAX, 'max')]),
    fileGet: async (path, maxBytes) =>
      call(CtlFileGetSchema, ['file-get', '--path', checkPath(path), '--max', checkInt(maxBytes, 1, FILE_GET_MAX, 'max')], {
        timeoutMs: FILE_GET_TIMEOUT_MS,
        maxOutputBytes: Math.ceil(maxBytes / 3) * 4 + 64 * 1024,
      }),
    filePut: async (name, b64) => {
      if (b64.length === 0 || b64.length > Math.ceil(FILE_PUT_MAX / 3) * 4) throw new ValidationError('upload must be 1 byte to 50 MiB');
      return call(CtlFilePutSchema, ['file-put', '--name', checkUploadName(name)], { stdin: b64, timeoutMs: FILE_GET_TIMEOUT_MS });
    },
    graphifyRun: async (path, timeoutSec) =>
      call(CtlGraphifyRunSchema, ['graphify-run', '--path', checkPath(path), '--timeout', checkInt(timeoutSec, 60, 3600, 'timeout')], {
        timeoutMs: timeoutSec * 1000 + GRAPHIFY_GRACE_MS,
      }),
    graphQuery: async (path, question, budget) =>
      call(CtlGraphQuerySchema, ['graph-query', '--path', checkPath(path), '--budget', checkInt(budget, 200, 8000, 'budget')], {
        stdin: checkText(question, 2000, 'question'),
        timeoutMs: GRAPH_QUERY_TIMEOUT_MS,
      }),
    fileWrite: async (path, content) =>
      call(CtlFileWriteSchema, ['file-write', '--path', checkPath(path)], { stdin: checkText(content, FILE_CONTENT_MAX, 'content', true) }),
    getConfig: async () => call(CtlConfigSchema, ['config', '--get']),
    setConfig: async (key, value) => call(CtlConfigSchema, ['config', '--set', `${checkConfigKey(key)}=${checkConfigValue(value)}`]),
    authStatus: async () => call(CtlAuthStatusSchema, ['auth-status']),
    authLogin: async () => call(CtlAuthLoginSchema, ['auth-login'], { timeoutMs: AUTH_LOGIN_TIMEOUT_MS }),
    authCode: async (code) =>
      call(CtlAuthCodeSchema, ['auth-code'], { stdin: checkText(code, AUTH_CODE_MAX, 'sign-in code'), timeoutMs: AUTH_CODE_TIMEOUT_MS }),
    authLogout: async () => call(CtlAuthLogoutSchema, ['auth-logout'], { timeoutMs: AUTH_LOGOUT_TIMEOUT_MS }),
    pause: async (target) => call(CtlPauseSchema, ['pause', '--target', checkTarget(target)]),
    resume: async (target) => call(CtlResumeSchema, ['resume', '--target', checkTarget(target)]),
    skills: async () => call(CtlSkillsSchema, ['skills']),
    kbPut: async (files, prune) => call(CtlKbPutSchema, ['kb-put'], { stdin: kbPutPayload(files, prune), timeoutMs: KB_PUT_TIMEOUT_MS }),
    gitStatus: async () => call(CtlGitStatusSchema, ['git-status'], { timeoutMs: PROJECTS_TIMEOUT_MS }),
  };
}
