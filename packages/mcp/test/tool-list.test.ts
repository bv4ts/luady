import { Ajv2020 } from 'ajv/dist/2020.js';
import { TOOL_DEFS, TOOL_NAMES, type ToolName } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildToolList, describeTool, toInputJsonSchema } from '../src/tool-list.js';

const SAMPLES: Record<ToolName, Record<string, unknown>> = {
  fleet_status: {},
  session_read: { session: 'cedar:cc-meadow-hr:0.0' },
  session_send: { session: 'meadow-hr', text: 'run the tests', todos: [12, 15] },
  session_start: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: 'Fix the login bug.' },
  session_interrupt: { session: 'meadow-hr' },
  session_stop: { session: 'meadow-hr', reason: 'owner asked' },
  session_restart: { session: 'meadow-hr', reason: 'stuck turn' },
  session_delete: { session: 'meadow-hr', reason: 'old mission' },
  question_answer: { qid: 'ABCDEFGH', answers: { 'Which DB?': 'Postgres' } },
  question_list: {},
  question_release: { qid: 'ABCDEFGH' },
  server_exec: { server: 'birch', command: 'df -h', reason: 'disk check' },
  file_read: { server: 'ash', path: '/home/dev/projects/portfolio/README.md' },
  file_write: { server: 'ash', path: '/home/dev/projects/portfolio/NOTE.md', content: 'hi', reason: 'owner asked' },
  claude_update: { server: 'cedar', reason: 'new release' },
  project_info: { server: 'birch', project: 'orchard' },
  graph_query: { server: 'birch', project: 'Frontend', question: 'where is the login flow?' },
  memory_search: { query: 'orchard deploy' },
  notify_user: { text: 'Mission started on cedar.' },
  send_file: { server: 'ash', path: '/home/dev/luady-out/shot.png', caption: 'Superadmin' },
  file_upload: { server: 'ash', file: '/home/luady/brain/inbox/20261010-031500-3A11C202-logo.png', name: 'logo.png' },
  mission_update: { session: 'birch/orchard', note: 'Issues 1-3 fixed, testing sign-in now.' },
  mission_done: { session: 'birch/orchard', summary: 'All 5 issues fixed and tested.' },
  image_generate: { prompt: 'A minimalist square logo of a falcon, gold on black', references: [{ source: '/home/luady/brain/inbox/20261010-031500-3A11C202-logo.png', role: 'edit' }, { source: 'img-1a2b3c4d#2', role: 'style', note: 'the colours' }], transparent: true, deliver: 'owner' },
  todo_add: { text: 'call the bank', today: true, project: 'home', source: 'meeting', source_ref: 'm:19ad92a1' },
  todo_list: {},
  todo_done: { id: 1 },
  todo_remove: { id: 2 },
  email_search: { query: 'from:etisalat has:attachment', limit: 5 },
  email_read: { id: '18c2f0a1b2c3d4e5' },
  calendar_events: { days: 2, account: 'work' },
  meeting_search: { query: 'refunds', project: 'orchard', since: '2026-11-01', limit: 5 },
  meeting_get: { id: '00000000-0000-4000-8000-000000000001', transcript: true, start_char: 12000 },
  meeting_note: { id: '00000000-0000-4000-8000-000000000001', note: 'Client wants Arabic too' },
  call_user: { reason: 'question pending 10 min' },
  schedule: { when: '2026-10-10T09:00:00+04:00', task: 'Check the orchard mission.' },
  schedule_list: {},
  schedule_cancel: { id: 'S1' },
  account_limits: {},
  session_pause: { session: 'birch/app-backend' },
  session_resume: { session: 'birch/app-backend' },
  owner_presence: {},
  todo_get: { id: 12 },
  todo_update: { id: 12, state: 'review', note: 'No project given' },
  kb_search: { query: 'deploy', project: 'orchard', limit: 5 },
  kb_read: { id: 3 },
  kb_write: { scope: 'project', server: 'birch', project: 'orchard', title: 'Deploy lessons', body: '- run migrations first', tags: ['lesson'] },
  jira_search: { server: 'birch', view: 'sprint', limit: 10 },
  jira_get: { key: 'ORC-123' },
  jira_comment: { key: 'ORC-123', text: 'Fixed in the latest build.', server: 'birch' },
  jira_transition: { key: 'ORC-123', to: 'In Review' },
  rooms_list: {},
};

function newAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

describe('buildToolList', () => {
  it('lists every manager tool once, in TOOL_DEFS order, with its description', () => {
    const tools = buildToolList();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description).toBe(TOOL_DEFS[tool.name as ToolName].description);
    }
  });

  it('emits strict object schemas without a $schema key', () => {
    for (const tool of buildToolList()) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema).not.toHaveProperty('$schema');
    }
  });

  it('produces valid JSON Schema 2020-12 for every tool', () => {
    const ajv = newAjv();
    for (const tool of buildToolList()) {
      expect(ajv.validateSchema(tool.inputSchema), `${tool.name}: ${ajv.errorsText(ajv.errors)}`).toBe(true);
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('agrees with zod on a valid sample and rejects an extra key for every tool', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...TOOL_NAMES].sort());
    const ajv = newAjv();
    for (const tool of buildToolList()) {
      const name = tool.name as ToolName;
      const sample = SAMPLES[name];
      const extra = { ...sample, unexpected: 1 };
      const validate = ajv.compile(tool.inputSchema);
      expect(validate(sample), `${name} json schema accepts the sample`).toBe(true);
      expect(TOOL_DEFS[name].input.safeParse(sample).success, `${name} zod accepts the sample`).toBe(true);
      expect(validate(extra), `${name} json schema rejects an extra key`).toBe(false);
      expect(TOOL_DEFS[name].input.safeParse(extra).success, `${name} zod rejects an extra key`).toBe(false);
    }
  });

  it('keeps defaulted fields optional and documents their defaults', () => {
    const read = describeTool('session_read').inputSchema;
    expect(read.required).toEqual(['session']);
    expect(read.properties?.last_n).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
    expect(describeTool('session_start').inputSchema.required).toEqual(['server', 'cwd']);
    expect(describeTool('server_exec').inputSchema.required).toEqual(['server', 'command', 'reason']);
    expect(describeTool('fleet_status').inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('keeps descriptions and patterns but drops zod-only formats', () => {
    expect(JSON.stringify(toInputJsonSchema(TOOL_DEFS.session_read.input))).toContain('<server>:cc-<name>:0.0');
    const qid = describeTool('question_answer').inputSchema.properties?.qid;
    expect(qid).toMatchObject({ type: 'string', pattern: '^[A-Z2-7]{8}$' });
    const cwd = describeTool('session_start').inputSchema.properties?.cwd as Record<string, unknown> | undefined;
    expect(cwd).toMatchObject({ type: 'string', maxLength: 1024 });
    expect(cwd).not.toHaveProperty('format');
    // The shared schema enforces the projects root with a refine(), which JSON Schema cannot express; handleToolCall enforces it.
    expect(cwd).not.toHaveProperty('pattern');
    const prefixed = toInputJsonSchema(z.strictObject({ p: z.string().startsWith('/a/') })).properties as Record<string, object>;
    expect(prefixed.p).toHaveProperty('pattern');
    expect(prefixed.p).not.toHaveProperty('format');
    for (const tool of buildToolList()) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"format":"(starts_with|ends_with|includes|lowercase|uppercase)"/);
    }
  });
});
