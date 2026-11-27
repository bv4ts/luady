import { describe, expect, it } from 'vitest';
import {
  AskQuestionSchema,
  PermissionAnswerFileSchema,
  PermissionPreviewSchema,
  QidSchema,
  QuestionAnswerFileSchema,
  SPOOL_FILE_RE,
  SpoolEventSchema,
  TailLineSchema,
} from '../src/spool.js';
import { EVENT_TYPES, HASH, PREVIEW, VALID_DATA, line, type EventType } from './helpers.js';

const INVALID_DATA: Record<EventType, unknown> = {
  session_start: { source: 'startup' },
  prompt: { prompt_sha256: HASH.toUpperCase(), prompt_preview: 'x' },
  stop: { last_assistant_message: 'Done', truncated: 'no' },
  stop_failure: { error: 42 },
  notification: { notification_type: 'idle_prompt', message: 'waiting' },
  session_end: {},
  question: { qid: 'ABCDEFGH', tool_use_id: null, questions: [] },
  question_resolved: { qid: 'ABCDEFGH', outcome: 'approved' },
  permission: { qid: 'abc', tool_name: 'Bash', input_preview: '' },
  permission_resolved: { qid: 'QRSTUVWX', outcome: 'answered' },
  report: { text: '' },
};

describe('SpoolEventSchema', () => {
  it('keeps exactly its eleven kinds', () => {
    expect(EVENT_TYPES).toHaveLength(11);
    expect([...SpoolEventSchema.options.map((option) => option.shape.event.value)].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)('accepts a valid %s event', (event) => {
    const parsed = SpoolEventSchema.parse(line(event, VALID_DATA[event]));
    expect(parsed.event).toBe(event);
    expect(parsed.data).toEqual(VALID_DATA[event]);
  });

  it.each(EVENT_TYPES)('rejects an invalid %s payload', (event) => {
    expect(SpoolEventSchema.safeParse(line(event, INVALID_DATA[event])).success).toBe(false);
  });

  it('accepts null envelope fields (hook ran outside tmux or without a session)', () => {
    const nulls = { session_id: null, cwd: null, transcript_path: null, tmux: null, permission_mode: null };
    expect(SpoolEventSchema.safeParse(line('session_end', { reason: 'other' }, nulls)).success).toBe(true);
  });

  it('accepts an extended-format offset timestamp', () => {
    const parsed = SpoolEventSchema.parse(line('stop', VALID_DATA.stop, { ts: '2026-10-09T23:42:11+04:00' }));
    expect(parsed.ts).toBe('2026-10-09T23:42:11+04:00');
  });

  it.each([
    ['version 2', { v: 2 }],
    ['a short id', { id: 'abc' }],
    ['a timestamp without zone', { ts: '2026-10-09T19:42:11' }],
    ['a basic-format offset', { ts: '2026-10-09T23:42:11+0400' }],
    ['a minute-precision timestamp', { ts: '2026-10-09T19:42Z' }],
    ['an empty host', { host: '' }],
    ['a missing session_id', { session_id: undefined }],
  ])('rejects an envelope with %s', (_label, patch) => {
    expect(SpoolEventSchema.safeParse(line('stop', VALID_DATA.stop, patch)).success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(SpoolEventSchema.safeParse(line('pre_compact', {})).success).toBe(false);
  });

  it('drops unknown top-level keys so newer kits stay readable', () => {
    const parsed = SpoolEventSchema.parse(line('stop', VALID_DATA.stop, { extra: 'from kit v2' }));
    expect(parsed).not.toHaveProperty('extra');
  });
});

describe('AskQuestionSchema', () => {
  it('defaults options to an empty list', () => {
    expect(AskQuestionSchema.parse({ question: 'Anything else?' })).toEqual({ question: 'Anything else?', options: [] });
  });

  it('keeps unknown keys on questions and options', () => {
    const input = { question: 'Pick one', future: 1, options: [{ label: 'A', preview: 'diff' }] };
    expect(AskQuestionSchema.parse(input)).toEqual(input);
  });

  it('requires question text and option labels', () => {
    expect(AskQuestionSchema.safeParse({ options: [] }).success).toBe(false);
    expect(AskQuestionSchema.safeParse({ question: 'Q', options: [{ description: 'no label' }] }).success).toBe(false);
  });
});

describe('QidSchema', () => {
  it('accepts base32 qids only', () => {
    expect(QidSchema.safeParse('ABCDEFGH').success).toBe(true);
    expect(QidSchema.safeParse('abcdefgh').success).toBe(false);
  });
});

describe('TailLineSchema', () => {
  it('accepts an event line with its file and byte offset', () => {
    const tail = { file: 'events-20261009.jsonl', offset: 512, event: { anything: true } };
    expect(TailLineSchema.parse(tail)).toEqual(tail);
  });

  it('accepts a heartbeat line', () => {
    expect(TailLineSchema.parse({ heartbeat: '2026-10-09T19:42:41Z' })).toEqual({ heartbeat: '2026-10-09T19:42:41Z' });
  });

  it.each([
    ['a bad date in the file name', { file: 'events-2026109.jsonl', offset: 0, event: {} }],
    ['the wrong extension', { file: 'events-20261009.json', offset: 0, event: {} }],
    ['a path in the file name', { file: '../events-20261009.jsonl', offset: 0, event: {} }],
    ['a negative offset', { file: 'events-20261009.jsonl', offset: -1, event: {} }],
    ['a fractional offset', { file: 'events-20261009.jsonl', offset: 1.5, event: {} }],
    ['an unknown key', { file: 'events-20261009.jsonl', offset: 0, event: {}, extra: 1 }],
    ['a heartbeat with an extra key', { heartbeat: 'x', offset: 0 }],
    ['an empty object', {}],
  ])('rejects %s', (_label, tail) => {
    expect(TailLineSchema.safeParse(tail).success).toBe(false);
  });

  it('SPOOL_FILE_RE matches daily spool names only', () => {
    expect(SPOOL_FILE_RE.test('events-20261009.jsonl')).toBe(true);
    expect(SPOOL_FILE_RE.test('events-20261009.jsonl.tmp')).toBe(false);
    expect(SPOOL_FILE_RE.test('old-events-20261009.jsonl')).toBe(false);
  });
});

describe('QuestionAnswerFileSchema', () => {
  it.each([
    [{ answers: { 'Which database?': 'Postgres' } }],
    [{ answers: { 'Which features?': 'Auth, Billing', 'Anything else?': 'ship after 18:00' } }],
    [{ release: true }],
  ])('accepts %j', (file) => {
    expect(QuestionAnswerFileSchema.parse(file)).toEqual(file);
  });

  it.each([[{ release: false }], [{ answers: { q: 'a' }, release: true }], [{ answers: { q: 1 } }], [{}]])(
    'rejects %j',
    (file) => {
      expect(QuestionAnswerFileSchema.safeParse(file).success).toBe(false);
    },
  );
});

describe('PermissionAnswerFileSchema', () => {
  it.each([[{ behavior: 'allow' }], [{ behavior: 'deny', message: 'not on prod' }], [{ release: true }]])(
    'accepts %j',
    (file) => {
      expect(PermissionAnswerFileSchema.parse(file)).toEqual(file);
    },
  );

  it.each([[{ behavior: 'ask' }], [{ behavior: 'allow', extra: 1 }], [{ release: true, behavior: 'allow' }]])(
    'rejects %j',
    (file) => {
      expect(PermissionAnswerFileSchema.safeParse(file).success).toBe(false);
    },
  );
});

describe('permission event with a structured preview', () => {
  const permission = (data: Record<string, unknown>) => line('permission', { ...VALID_DATA.permission, ...data });

  it('still parses a kit-1 permission line and adds no preview key', () => {
    const parsed = SpoolEventSchema.parse(line('permission', VALID_DATA.permission));
    expect(parsed.data).toEqual(VALID_DATA.permission);
    expect(Object.keys(parsed.data)).not.toContain('preview');
  });

  it('round-trips a kit-2 line with a preview', () => {
    const input = permission({ preview: PREVIEW });
    expect(SpoolEventSchema.parse(input)).toEqual(input);
  });

  it('round-trips a Bash preview without edits and without "Allow always"', () => {
    const bash = { ...PREVIEW, tool: 'Bash', kind: 'command', command: 'git push --force', path: null, edits: [], always: null };
    expect(PermissionPreviewSchema.parse(bash)).toEqual(bash);
  });

  it('keeps the kit\'s "allow" verdict, and a preview without one still parses', () => {
    const bash = { ...PREVIEW, tool: 'Bash', kind: 'command', command: 'cat [redacted]', path: null, edits: [], always: null, allow: false };
    expect(PermissionPreviewSchema.parse(bash)).toEqual(bash);
    expect(SpoolEventSchema.parse(permission({ preview: bash }))).toEqual(permission({ preview: bash }));
    expect(PermissionPreviewSchema.parse(PREVIEW)).not.toHaveProperty('allow');
    expect(PermissionPreviewSchema.safeParse({ ...bash, allow: 'no' }).success).toBe(false);
  });

  it('accepts a 100-character MCP tool name', () => {
    const tool = `mcp__${'s'.repeat(40)}__${'t'.repeat(53)}`;
    expect(SpoolEventSchema.safeParse(permission({ preview: { ...PREVIEW, tool, kind: 'other' } })).success).toBe(true);
  });

  it('accepts every string field at its maximum', () => {
    const full = {
      ...PREVIEW,
      tool: 'x'.repeat(128),
      command: 'c'.repeat(8192),
      path: 'p'.repeat(1024),
      cwd: 'd'.repeat(1024),
      edits: [{ old: 'o'.repeat(8192), new: 'n'.repeat(8192) }],
      always: { label: 'l'.repeat(200) },
    };
    expect(PermissionPreviewSchema.parse(full)).toEqual(full);
  });

  it.each([
    ['tool', { tool: 'x'.repeat(129) }],
    ['command', { command: 'c'.repeat(8193) }],
    ['path', { path: 'p'.repeat(1025) }],
    ['cwd', { cwd: 'd'.repeat(1025) }],
    ['edit old text', { edits: [{ old: 'o'.repeat(8193), new: 'n' }] }],
    ['edit new text', { edits: [{ old: 'o', new: 'n'.repeat(8193) }] }],
    ['always label', { always: { label: 'l'.repeat(201) } }],
  ])('rejects an oversized %s instead of truncating it', (_label, patch) => {
    expect(PermissionPreviewSchema.safeParse({ ...PREVIEW, ...patch }).success).toBe(false);
    expect(SpoolEventSchema.safeParse(permission({ preview: { ...PREVIEW, ...patch } })).success).toBe(false);
  });

  it('accepts 20 edits and rejects 21', () => {
    const edits = (n: number) => Array.from({ length: n }, (_v, i) => ({ old: `a${i}`, new: `b${i}` }));
    expect(SpoolEventSchema.safeParse(permission({ preview: { ...PREVIEW, edits: edits(20) } })).success).toBe(true);
    expect(SpoolEventSchema.safeParse(permission({ preview: { ...PREVIEW, edits: edits(21) } })).success).toBe(false);
  });

  it.each([
    ['an "Allow always" label over 200 characters', { always: { label: 'x'.repeat(201) } }],
    ['an unknown kind', { kind: 'delete' }],
    ['a 129-character tool name', { tool: 'x'.repeat(129) }],
    ['a missing truncated flag', { truncated: undefined }],
    ['an edit without new text', { edits: [{ old: 'a' }] }],
  ])('rejects a preview with %s', (_label, patch) => {
    expect(PermissionPreviewSchema.safeParse({ ...PREVIEW, ...patch }).success).toBe(false);
    expect(SpoolEventSchema.safeParse(permission({ preview: { ...PREVIEW, ...patch } })).success).toBe(false);
  });
});

describe('PermissionAnswerFileSchema with "Allow always"', () => {
  it.each([[{ behavior: 'allow', always: true }], [{ behavior: 'deny', message: 'no' }], [{ release: true }]])(
    'accepts %j',
    (file) => {
      expect(PermissionAnswerFileSchema.parse(file)).toEqual(file);
    },
  );

  it.each([[{ behavior: 'allow', always: false }], [{ behavior: 'allow', extra: 1 }], [{ release: true, always: true }]])(
    'rejects %j',
    (file) => {
      expect(PermissionAnswerFileSchema.safeParse(file).success).toBe(false);
    },
  );
});

describe('PermissionAnswerFileSchema: "always" belongs to allow only', () => {
  it.each([[{ behavior: 'deny', message: 'no' }], [{ behavior: 'allow' }], [{ behavior: 'allow', always: true }]])('accepts %j', (file) => {
    expect(PermissionAnswerFileSchema.parse(file)).toEqual(file);
  });

  it('rejects deny with always', () => {
    expect(PermissionAnswerFileSchema.safeParse({ behavior: 'deny', always: true }).success).toBe(false);
  });
});
