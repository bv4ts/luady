import { z } from 'zod';
import { LIMITS } from './limits.js';
import { QidSchema } from './spool.js';
import { HttpsUrlSchema } from './urls.js';

export const CTL_EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, not_found: 4, timeout: 5 } as const;
export const CtlErrorCodeSchema = z.enum(['failed', 'usage', 'refused', 'not_found', 'timeout']);
export type CtlErrorCode = z.infer<typeof CtlErrorCodeSchema>;
export const CtlErrorSchema = z.object({ error: z.object({ code: CtlErrorCodeSchema, message: z.string() }) });

export const CtlVersionSchema = z.object({ kit: z.string(), claude: z.string().nullable(), tmux: z.string().nullable(), python: z.string() });
export const CtlSysinfoSchema = z.object({
  load1: z.number(), load5: z.number(),
  mem_total_kb: z.number().int(), mem_avail_kb: z.number().int(),
  disk_free_kb: z.number().int(), uptime_s: z.number().int(),
  /** The size of the root disk. Kit 2.1.0 and newer; absent on an older kit. */
  disk_total_kb: z.number().int().optional(),
});
export const CtlPaneSchema = z.object({
  target: z.string(), tmux_session: z.string(), pane_pid: z.number().int(),
  command: z.string(), cwd: z.string(), is_claude: z.boolean(),
  session_id: z.string().nullable(), transcript_path: z.string().nullable(),
  registered: z.boolean(), pending_qid: QidSchema.nullable(),
  /** Kit 2+: a pause was requested for this session (it may not have hit yet). */
  paused: z.boolean().optional(),
});
export const CtlSessionsSchema = z.object({ sessions: z.array(CtlPaneSchema) });
export const CtlPendingItemSchema = z.object({
  qid: QidSchema, kind: z.enum(['question', 'permission']), created_at: z.string(),
  session_id: z.string().nullable(), tmux: z.string().nullable(),
});
export const CtlPendingSchema = z.object({ pending: z.array(CtlPendingItemSchema) });
export const CtlOkSchema = z.looseObject({ ok: z.literal(true) });
export const CtlStartSchema = z.object({ ok: z.literal(true), target: z.string() });
export const CtlStopSchema = z.object({ ok: z.literal(true), forced: z.boolean() });
export const CtlDeleteSchema = z.object({ ok: z.literal(true), trashed: z.string() });
export const CtlTranscriptSchema = z.object({ path: z.string(), size: z.number().int(), from: z.number().int(), to: z.number().int(), data: z.string() });
export const CtlCaptureSchema = z.object({ text: z.string() });
export const CtlUpdateSchema = z.object({ before: z.string().nullable(), after: z.string().nullable(), output: z.string() });
export const CtlCommitSchema = z.object({ hash: z.string(), date: z.string(), subject: z.string() });
export const CtlProjectSchema = z.object({
  path: z.string(), name: z.string(), remote: z.string().nullable(), branch: z.string().nullable(),
  commits: z.array(CtlCommitSchema), stack: z.array(z.string()),
});
export const CtlProjectsSchema = z.object({ projects: z.array(CtlProjectSchema) });
export const CtlExecSchema = z.object({ exit: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean(), timed_out: z.boolean() });
export const CtlFileReadSchema = z.object({ path: z.string(), size: z.number().int(), content: z.string(), truncated: z.boolean() });
export const CtlFileGetSchema = z.object({ path: z.string(), size: z.number().int(), b64: z.string() });
export const CtlFilePutSchema = z.object({ path: z.string(), size: z.number().int() });
export const CtlGraphifyRunSchema = z.object({ path: z.string(), seconds: z.number(), report: z.string(), tail: z.string() });
export const CtlGraphQuerySchema = z.object({ path: z.string(), built_at: z.string(), text: z.string() });
export const CtlFileWriteSchema = z.object({ ok: z.literal(true), bytes: z.number().int() });
export const CtlConfigSchema = z.object({ remote_answering: z.boolean(), hook_wait_seconds: z.number().int(), host_alias: z.string() });
export const CtlAuthStatusSchema = z.object({
  logged_in: z.boolean(), email: z.string().nullable(), expires_at: z.string().nullable(),
  /** Kit 2+ (from `claude auth status`): absent on kit 1, null when Claude Code did not report it. */
  org_id: z.string().nullable().optional(),
  org_name: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  plan_tier: z.string().nullable().optional(),
  auth_method: z.string().nullable().optional(),
});
export const CtlAuthLoginSchema = z.object({ url: HttpsUrlSchema });
export const CtlAuthCodeSchema = CtlAuthStatusSchema.extend({ ok: z.boolean(), message: z.string() });
export const CtlPauseSchema = z.object({ ok: z.literal(true), paused: z.literal(true) });
/** `was_hit`: the pause had really stopped the session; `sent`: the kit typed the resume text. */
export const CtlResumeSchema = z.object({ ok: z.literal(true), was_hit: z.boolean(), sent: z.boolean() });
export const CtlAuthLogoutSchema = CtlAuthStatusSchema.extend({ ok: z.boolean(), message: z.string() });

// ── Kit 2.1.0 verbs ──

/** `skills`: `~/.claude/skills/<name>/SKILL.md`, each project's `.claude/skills/<name>/SKILL.md` and installed plug-ins' skills. */
export const CtlSkillSchema = z.object({
  name: z.string(),
  description: z.string().max(LIMITS.skillDescriptionMax),
  source: z.enum(['user', 'project', 'plugin']),
  path: z.string(),
});
export const CtlSkillsSchema = z.object({ skills: z.array(CtlSkillSchema).max(LIMITS.skillsMax) });

const KB_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KB_PATH_MAX = 200;

/**
 * A `kb-put` path: relative to `~/luady-kb/`, `.md` only, plain segments (no `.`, `..`, hidden names, empty segments,
 * backslashes or NULs). The kit checks the same and also refuses symlinks out of the folder.
 */
export function isKbPath(path: string): boolean {
  if (path.length === 0 || path.length > KB_PATH_MAX || !path.endsWith('.md')) return false;
  return path.split('/').every((segment) => KB_SEGMENT_RE.test(segment) && segment !== '..');
}

/** UTF-8 length of a string without Buffer or TextEncoder (both runtimes of this package). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** JSON on stdin of `kb-put`. `prune`: remove files of the folder that are not in `files`. At most 2 MB as sent. */
export const CtlKbPutInputSchema = z
  .strictObject({
    files: z.array(z.strictObject({ path: z.string().refine(isKbPath, { message: 'not a knowledge-base path' }), content: z.string() })),
    prune: z.boolean(),
  })
  .refine((payload) => utf8Length(JSON.stringify(payload)) <= LIMITS.kbSyncMaxBytes, { message: 'kb-put payload is over 2 MB' });
/** How many files `kb-put` wrote and removed. */
export const CtlKbPutSchema = z.object({ written: z.number().int().min(0), removed: z.number().int().min(0) });

/** `git-status`: per project, `ahead`/`behind` null without an upstream. */
export const CtlGitProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  ahead: z.number().int().min(0).nullable(),
  behind: z.number().int().min(0).nullable(),
  lastCommitAt: z.string().nullable(),
});
export const CtlGitStatusSchema = z.object({ projects: z.array(CtlGitProjectSchema) });

export type CtlVersion = z.infer<typeof CtlVersionSchema>;
export type CtlSysinfo = z.infer<typeof CtlSysinfoSchema>;
export type CtlPane = z.infer<typeof CtlPaneSchema>;
export type CtlSessions = z.infer<typeof CtlSessionsSchema>;
export type CtlPending = z.infer<typeof CtlPendingSchema>;
export type CtlStart = z.infer<typeof CtlStartSchema>;
export type CtlStop = z.infer<typeof CtlStopSchema>;
export type CtlDelete = z.infer<typeof CtlDeleteSchema>;
export type CtlTranscript = z.infer<typeof CtlTranscriptSchema>;
export type CtlUpdate = z.infer<typeof CtlUpdateSchema>;
export type CtlCommit = z.infer<typeof CtlCommitSchema>;
export type CtlProject = z.infer<typeof CtlProjectSchema>;
export type CtlProjects = z.infer<typeof CtlProjectsSchema>;
export type CtlExec = z.infer<typeof CtlExecSchema>;
export type CtlFileRead = z.infer<typeof CtlFileReadSchema>;
export type CtlFileGet = z.infer<typeof CtlFileGetSchema>;
export type CtlFilePut = z.infer<typeof CtlFilePutSchema>;
export type CtlGraphifyRun = z.infer<typeof CtlGraphifyRunSchema>;
export type CtlGraphQuery = z.infer<typeof CtlGraphQuerySchema>;
export type CtlFileWrite = z.infer<typeof CtlFileWriteSchema>;
export type CtlConfig = z.infer<typeof CtlConfigSchema>;
export type CtlAuthStatus = z.infer<typeof CtlAuthStatusSchema>;
export type CtlAuthLogin = z.infer<typeof CtlAuthLoginSchema>;
export type CtlAuthCode = z.infer<typeof CtlAuthCodeSchema>;
export type CtlPause = z.infer<typeof CtlPauseSchema>;
export type CtlResume = z.infer<typeof CtlResumeSchema>;
export type CtlAuthLogout = z.infer<typeof CtlAuthLogoutSchema>;
export type CtlSkill = z.infer<typeof CtlSkillSchema>;
export type CtlSkills = z.infer<typeof CtlSkillsSchema>;
export type CtlKbPutInput = z.infer<typeof CtlKbPutInputSchema>;
export type CtlKbFile = CtlKbPutInput['files'][number];
export type CtlKbPut = z.infer<typeof CtlKbPutSchema>;
export type CtlGitProject = z.infer<typeof CtlGitProjectSchema>;
export type CtlGitStatus = z.infer<typeof CtlGitStatusSchema>;
