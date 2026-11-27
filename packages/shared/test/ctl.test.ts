import { describe, expect, it } from 'vitest';
import {
  CTL_EXIT,
  CtlAuthCodeSchema,
  CtlAuthLoginSchema,
  CtlAuthLogoutSchema,
  CtlAuthStatusSchema,
  CtlCaptureSchema,
  CtlConfigSchema,
  CtlDeleteSchema,
  CtlErrorCodeSchema,
  CtlErrorSchema,
  CtlExecSchema,
  CtlFileReadSchema,
  CtlFileWriteSchema,
  CtlOkSchema,
  CtlPaneSchema,
  CtlPauseSchema,
  CtlPendingSchema,
  CtlProjectsSchema,
  CtlResumeSchema,
  CtlSessionsSchema,
  CtlStartSchema,
  CtlStopSchema,
  CtlSysinfoSchema,
  CtlTranscriptSchema,
  CtlUpdateSchema,
  CtlVersionSchema,
} from '../src/ctl.js';
import { NOT_HTTPS } from './helpers.js';

const SID = '0d9c3b2a-1111-4222-8333-944455556666';

const pane = {
  target: 'cc-meadow-hr:0.0',
  tmux_session: 'cc-meadow-hr',
  pane_pid: 4242,
  command: 'claude',
  cwd: '/home/dev/projects/meadow-hr',
  is_claude: true,
  session_id: SID,
  transcript_path: `/home/dev/.claude/projects/-home-dev-projects-meadow-hr/${SID}.jsonl`,
  registered: true,
  pending_qid: 'ABCDEFGH',
};

const unregisteredPane = {
  ...pane,
  target: 'cc-old:0.0',
  tmux_session: 'cc-old',
  registered: false,
  session_id: null,
  transcript_path: null,
  pending_qid: null,
};

const project = {
  path: '/home/dev/projects/meadow-hr',
  name: 'meadow-hr',
  remote: 'git@github.com:example-org/meadow-hr.git',
  branch: 'main',
  commits: [{ hash: 'abc1234', date: '2026-10-09T10:00:00+04:00', subject: 'fix: login' }],
  stack: ['php', 'laravel'],
};

describe('exit codes', () => {
  it('pins CTL_EXIT and the error code enum', () => {
    expect(CTL_EXIT).toEqual({ ok: 0, failed: 1, usage: 2, refused: 3, not_found: 4, timeout: 5 });
    expect(CtlErrorCodeSchema.options).toEqual(['failed', 'usage', 'refused', 'not_found', 'timeout']);
  });
});

describe('CtlErrorSchema', () => {
  it('accepts the error envelope', () => {
    const parsed = CtlErrorSchema.parse({ error: { code: 'refused', message: 'question pending for cc-x:0.0' } });
    expect(parsed.error.code).toBe('refused');
  });

  it('rejects unknown error codes', () => {
    expect(CtlErrorSchema.safeParse({ error: { code: 'boom', message: 'x' } }).success).toBe(false);
  });
});

describe('verb results', () => {
  it.each([
    ['version', CtlVersionSchema, { kit: '1.0.0', claude: null, tmux: '3.4', python: '3.12.3' }],
    [
      'sysinfo',
      CtlSysinfoSchema,
      { load1: 0.5, load5: 0.25, mem_total_kb: 8000000, mem_avail_kb: 3900000, disk_free_kb: 5700000, uptime_s: 86400 },
    ],
    ['sessions', CtlSessionsSchema, { sessions: [pane, unregisteredPane] }],
    [
      'pending',
      CtlPendingSchema,
      {
        pending: [
          { qid: 'ABCDEFGH', kind: 'question', created_at: '2026-10-09T19:42:11Z', session_id: SID, tmux: 'cc-meadow-hr:0.0' },
        ],
      },
    ],
    ['ok', CtlOkSchema, { ok: true }],
    ['start', CtlStartSchema, { ok: true, target: 'cc-demo:0.0' }],
    ['stop', CtlStopSchema, { ok: true, forced: false }],
    ['delete', CtlDeleteSchema, { ok: true, trashed: `/home/dev/.luady/trash/20261009T194211Z-${SID}.jsonl` }],
    [
      'transcript',
      CtlTranscriptSchema,
      { path: `/home/dev/.claude/projects/x/${SID}.jsonl`, size: 2048, from: 1024, to: 2048, data: '{"type":"user"}\n' },
    ],
    ['capture', CtlCaptureSchema, { text: '> hello\n' }],
    ['update-claude', CtlUpdateSchema, { before: '2.1.295', after: '2.1.301', output: 'Updated' }],
    ['projects', CtlProjectsSchema, { projects: [project] }],
    ['exec', CtlExecSchema, { exit: 0, stdout: 'ok\n', stderr: '', truncated: false, timed_out: false }],
    ['file-read', CtlFileReadSchema, { path: '/home/dev/a.txt', size: 3, content: 'abc', truncated: false }],
    ['file-write', CtlFileWriteSchema, { ok: true, bytes: 3 }],
    ['config', CtlConfigSchema, { remote_answering: true, hook_wait_seconds: 14400, host_alias: 'cedar' }],
  ])('accepts a %s result', (_verb, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each([
    [
      'sysinfo with fractional kB',
      CtlSysinfoSchema,
      { load1: 0.5, load5: 0.25, mem_total_kb: 1.5, mem_avail_kb: 1, disk_free_kb: 1, uptime_s: 1 },
    ],
    ['a pane with a lowercase qid', CtlPaneSchema, { ...pane, pending_qid: 'abcdefgh' }],
    [
      'a pending item of unknown kind',
      CtlPendingSchema,
      { pending: [{ qid: 'ABCDEFGH', kind: 'tool', created_at: 'x', session_id: null, tmux: null }] },
    ],
    ['ok false', CtlOkSchema, { ok: false }],
    ['stop without forced', CtlStopSchema, { ok: true }],
    ['exec with a string exit code', CtlExecSchema, { exit: '0', stdout: '', stderr: '', truncated: false, timed_out: false }],
    [
      'config with a string hook wait',
      CtlConfigSchema,
      { remote_answering: true, hook_wait_seconds: '14400', host_alias: 'cedar' },
    ],
  ])('rejects %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('keeps extra keys on {ok:true} (loose) and strips them on typed results', () => {
    expect(CtlOkSchema.parse({ ok: true, note: 'already stopped' })).toEqual({ ok: true, note: 'already stopped' });
    expect(CtlStopSchema.parse({ ok: true, forced: true, note: 'x' })).toEqual({ ok: true, forced: true });
  });
});

describe('optional fields on the auth status, auth code and pane results', () => {
  const status = { logged_in: true, email: null, expires_at: null };

  it('parses a kit-1 auth status unchanged (no new keys appear)', () => {
    const parsed = CtlAuthStatusSchema.parse(status);
    expect(parsed).toEqual(status);
    expect(Object.keys(parsed).sort()).toEqual(['email', 'expires_at', 'logged_in']);
  });

  it('keeps the organisation fields a kit-2 auth status reports', () => {
    const full = {
      ...status,
      email: 'dev@example.com',
      org_id: 'org_1',
      org_name: 'Example',
      plan: 'max',
      plan_tier: 'default_claude_max_5x',
      auth_method: 'claude.ai',
    };
    expect(CtlAuthStatusSchema.parse(full)).toEqual(full);
    expect(CtlAuthStatusSchema.parse({ ...status, org_id: 'org_1', plan: 'max' })).toEqual({ ...status, org_id: 'org_1', plan: 'max' });
    expect(CtlAuthStatusSchema.parse({ ...status, org_id: null, org_name: null })).toEqual({ ...status, org_id: null, org_name: null });
  });

  it('gives the auth code result the same optional fields', () => {
    const code = { ...status, ok: true, message: 'Signed in', org_name: 'Example' };
    expect(CtlAuthCodeSchema.parse(code)).toEqual(code);
    expect(CtlAuthCodeSchema.safeParse({ ...code, plan: 7 }).success).toBe(false);
  });

  it('keeps paused on a pane and parses a pane without it', () => {
    expect(CtlPaneSchema.parse({ ...pane, paused: true })).toEqual({ ...pane, paused: true });
    const parsed = CtlPaneSchema.parse(pane);
    expect(parsed).toEqual(pane);
    expect(Object.keys(parsed)).not.toContain('paused');
    expect(CtlPaneSchema.safeParse({ ...pane, paused: 'yes' }).success).toBe(false);
  });
});

describe('pause, resume and sign-out verb results', () => {
  it.each([
    ['pause', CtlPauseSchema, { ok: true, paused: true }],
    ['resume', CtlResumeSchema, { ok: true, was_hit: false, sent: false }],
    ['resume after a hit', CtlResumeSchema, { ok: true, was_hit: true, sent: true }],
    ['auth-logout', CtlAuthLogoutSchema, { ok: true, message: 'Signed out', logged_in: false, email: null, expires_at: null }],
  ])('accepts a %s result', (_verb, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each([
    ['pause with paused false', CtlPauseSchema, { ok: true, paused: false }],
    ['pause with ok false', CtlPauseSchema, { ok: false, paused: true }],
    ['resume without sent', CtlResumeSchema, { ok: true, was_hit: true }],
    ['auth-logout without a message', CtlAuthLogoutSchema, { ok: true, logged_in: false, email: null, expires_at: null }],
  ])('rejects %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('CtlAuthLoginSchema is https only', () => {
  it('accepts the https sign-in link', () => {
    const login = { url: 'https://claude.com/cai/oauth/authorize?code=true&state=s1' };
    expect(CtlAuthLoginSchema.parse(login)).toEqual(login);
  });

  it.each(NOT_HTTPS)('rejects %s', (_label, url) => {
    expect(CtlAuthLoginSchema.safeParse({ url }).success).toBe(false);
  });
});
