/** Spool fixtures shared by spool.test.ts and activity.test.ts. */
export const SID = '0d9c3b2a-1111-4222-8333-944455556666';
export const HASH = '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4';

export const envelope = {
  v: 1,
  id: '3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c',
  ts: '2026-10-09T19:42:11Z',
  host: 'cedar',
  session_id: SID,
  cwd: '/home/dev/projects/meadow-hr',
  transcript_path: `/home/dev/.claude/projects/-home-dev-projects-meadow-hr/${SID}.jsonl`,
  tmux: 'cc-meadow-hr:0.0',
  permission_mode: 'bypassPermissions',
};

/** One valid `data` per existing spool kind (all eleven). */
export const VALID_DATA = {
  session_start: { source: 'startup', model: 'claude-opus-4-5' },
  prompt: { prompt_sha256: HASH, prompt_preview: 'fix the login bug' },
  stop: { last_assistant_message: 'Done. All 42 tests pass.', truncated: false },
  stop_failure: { error: 'rate_limit: usage limit reached' },
  notification: { notification_type: 'permission_prompt', message: 'Claude needs your permission', title: null },
  session_end: { reason: 'prompt_input_exit' },
  question: {
    qid: 'ABCDEFGH',
    tool_use_id: 'toolu_01',
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        multiSelect: false,
        options: [{ label: 'Postgres', description: 'managed' }, { label: 'SQLite' }],
      },
    ],
  },
  question_resolved: { qid: 'ABCDEFGH', outcome: 'answered' },
  permission: { qid: 'QRSTUVWX', tool_name: 'Bash', input_preview: 'rm -rf build' },
  permission_resolved: { qid: 'QRSTUVWX', outcome: 'denied' },
  report: { text: 'The staging deploy is live.' },
};

export type EventType = keyof typeof VALID_DATA;
export const EVENT_TYPES = Object.keys(VALID_DATA) as EventType[];

/** A whole spool line: the valid envelope, the event name, its data, then any envelope patch. */
export function line(event: string, data: unknown, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...envelope, ...patch, event, data };
}

/** A full structured permission preview (Edit on one file, "Allow always" offered). */
export const PREVIEW = {
  tool: 'Edit',
  kind: 'edit',
  command: null,
  path: '/home/dev/projects/meadow-hr/src/login.ts',
  cwd: '/home/dev/projects/meadow-hr',
  edits: [{ old: 'if (user) {', new: 'if (user && user.active) {' }],
  truncated: false,
  always: { label: 'Edit files in meadow-hr for this session' },
};

/** The four kinds of link a sign-in or connect field must never carry. */
export const NOT_HTTPS = [
  ['a javascript: URL', 'javascript:alert(1)'],
  ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
  ['an http: URL', 'http://claude.ai/oauth/authorize'],
  ['a protocol-relative string', '//evil.example/oauth/authorize'],
] as const;

/** One valid board card, shared by board.test.ts and step-c.test.ts. */
export const BOARD_ITEM = {
  id: 12,
  title: 'Fix the checkout total',
  details: 'The VAT line is added twice.',
  project: 'orchard',
  server: 'birch',
  source: 'web',
  sourceRef: null,
  state: 'open',
  today: false,
  priority: 0,
  auto: false,
  runId: null,
  sessionId: null,
  result: null,
  createdAt: '2026-11-15T09:00:00.000Z',
  updatedAt: '2026-11-15T09:00:00.000Z',
  doneAt: null,
  dueAt: null,
  snoozeUntil: null,
};
