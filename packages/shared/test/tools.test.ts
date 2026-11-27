import { describe, expect, it } from 'vitest';
import { TOOL_DEFS, TOOL_NAMES, type ToolName } from '../src/tools.js';

describe('TOOL_DEFS', () => {
  it('lists the 52 tools in order', () => {
    expect(TOOL_NAMES).toEqual([
      'fleet_status',
      'session_read',
      'session_send',
      'session_start',
      'session_interrupt',
      'session_stop',
      'session_restart',
      'session_delete',
      'question_list',
      'question_answer',
      'question_release',
      'server_exec',
      'file_read',
      'file_write',
      'claude_update',
      'project_info',
      'graph_query',
      'memory_search',
      'notify_user',
      'send_file',
      'file_upload',
      'mission_update',
      'mission_done',
      'image_generate',
      'todo_add',
      'todo_list',
      'todo_done',
      'todo_remove',
      'email_search',
      'email_read',
      'calendar_events',
      'meeting_search',
      'meeting_get',
      'meeting_note',
      'call_user',
      'schedule',
      'schedule_list',
      'schedule_cancel',
      'account_limits',
      'session_pause',
      'session_resume',
      'owner_presence',
      'todo_get',
      'todo_update',
      'kb_search',
      'kb_read',
      'kb_write',
      'jira_search',
      'jira_get',
      'jira_comment',
      'jira_transition',
      'rooms_list',
    ]);
  });

  it('session_start takes any host\'s folder on the wire (the hub checks the host\'s projects folder), and jira tools a room id', () => {
    expect(TOOL_DEFS.session_start.input.safeParse({ server: 'computer', cwd: '/home/owner/projects/site' }).success).toBe(true);
    expect(TOOL_DEFS.jira_get.input.safeParse({ key: 'ORC-1', server: 'a-room-id-longer-than-a-host-id' }).success).toBe(true);
    expect(TOOL_DEFS.rooms_list.input.safeParse({ any: 1 }).success).toBe(false);
  });

  it('notify_user says the message follows the owner, not that it is a chat-app message', () => {
    const text = TOOL_DEFS.notify_user.description;
    expect(text).toContain('Send the owner a message now');
    expect(text).toContain('the website first while they are there, their chat channel otherwise or after 10 minutes unseen');
    expect(text).not.toMatch(/whatsapp/i);
  });

  it("session_resume and session_send say what the hub does with the owner's pause", () => {
    expect(TOOL_DEFS.session_resume.description).toContain('A pause the owner set only the owner can lift');
    expect(TOOL_DEFS.session_send.description).toContain('or is paused (the refusal says who paused it)');
  });

  it('says when a session start, a send or a command waits for the PIN, and that kb_write leaves the owner\'s pages alone', () => {
    for (const name of ['session_start', 'session_send'] as const) {
      expect(TOOL_DEFS[name].description).toContain('Needs the owner PIN (pending_confirmation) unless your running turn answers a message from the owner.');
    }
    expect(TOOL_DEFS.server_exec.description).toContain('every command on this computer, needs the owner PIN');
    expect(TOOL_DEFS.kb_write.description).toContain('unless the owner wrote or pinned that page');
  });

  it('gives every tool a description and a zod input schema', () => {
    for (const name of TOOL_NAMES) {
      const def = TOOL_DEFS[name];
      expect(def.description.length).toBeGreaterThan(10);
      expect(typeof def.input.safeParse).toBe('function');
    }
  });

  it.each([
    ['session_read', { session: 'meadow-hr' }, { session: 'meadow-hr', last_n: 20 }],
    [
      'server_exec',
      { server: 'cedar', command: 'df -h', reason: 'check disk' },
      // No folder by default: the hub runs it in the server's own home.
      { server: 'cedar', command: 'df -h', reason: 'check disk' },
    ],
    [
      'session_start',
      { server: 'birch', cwd: '/home/dev/projects/orchard' },
      { server: 'birch', cwd: '/home/dev/projects/orchard', prompt: '' },
    ],
    [
      'session_stop',
      { session: 'cedar:cc-x:0.0', reason: 'stuck loop' },
      { session: 'cedar:cc-x:0.0', force: false, reason: 'stuck loop' },
    ],
    ['file_read', { server: 'ash', path: '/home/dev/a.txt' }, { server: 'ash', path: '/home/dev/a.txt', max_bytes: 50000 }],
    ['memory_search', { query: 'meadow-hr deploy' }, { query: 'meadow-hr deploy', limit: 10 }],
    ['notify_user', { text: 'Build finished' }, { text: 'Build finished', urgent: false }],
    ['send_file', { server: 'ash', path: '/home/dev/shot.png' }, { server: 'ash', path: '/home/dev/shot.png', caption: '' }],
    ['todo_add', { text: 'Buy milk' }, { text: 'Buy milk', today: false, source: 'manager' }],
    ['todo_list', {}, { state: 'open' }],
    ['todo_done', { id: 4 }, { id: 4 }],
    ['kb_search', { query: 'deploy' }, { query: 'deploy', limit: 10 }],
    ['jira_search', {}, { limit: 20 }],
  ])('%s fills its defaults', (name, input, expected) => {
    expect(TOOL_DEFS[name as ToolName].input.parse(input)).toEqual(expected);
  });

  it.each([
    ['fleet_status', { verbose: true }],
    ['session_read', { session: 'x', last_n: 101 }],
    ['session_send', { session: 'x', text: '' }],
    // A folder outside the host's projects folder (`/root`) is the hub's to refuse: it knows each host's folder.
    ['session_start', { server: 'cedar', cwd: 'root' }],
    ['session_start', { server: 'cedar', cwd: '/home/dev/projects/../../etc' }],
    ['server_exec', { server: 'C:edar', command: 'ls', reason: 'look' }],
    ['server_exec', { server: 'cedar', command: 'ls', reason: 'ok' }],
    ['question_answer', { qid: 'abcdefgh', answers: {} }],
    ['schedule', { when: '1h', task: 'remind me' }],
    ['todo_add', { text: 'x', source: 'web' }],
    ['todo_add', { text: 'x', details: 'x'.repeat(8001) }],
    ['todo_list', { state: 'queued' }],
    ['todo_update', { id: 1, state: 'running' }],
    ['session_start', { server: 'birch', cwd: '/home/dev/projects/x', todos: Array.from({ length: 13 }, (_, i) => i + 1) }],
    ['session_send', { session: 'x', text: 'go', todos: [0] }],
    ['kb_write', { scope: 'office', title: 'x', body: '' }],
    ['kb_read', { id: 'overview' }],
    ['jira_get', { key: 'orc-1' }],
    ['jira_comment', { key: 'ORC-1', text: '' }],
    ['jira_transition', { key: 'ORC-1', to: '' }],
    ['jira_search', { view: 'all' }],
  ])('%s rejects %j', (name, input) => {
    expect(TOOL_DEFS[name as ToolName].input.safeParse(input).success).toBe(false);
  });

  it('accepts the inputs without card fields on the extended tools', () => {
    expect(TOOL_DEFS.todo_add.input.parse({ text: 'Call Sara', today: true })).toEqual({ text: 'Call Sara', today: true, source: 'manager' });
    expect(TOOL_DEFS.todo_list.input.parse({}).state).toBe('open');
    expect(TOOL_DEFS.todo_done.input.parse({ id: 3 })).toEqual({ id: 3 });
    expect(TOOL_DEFS.session_send.input.parse({ session: 'x', text: 'go' })).toEqual({ session: 'x', text: 'go' });
  });

  it('takes the card fields on the extended tools', () => {
    const add = {
      text: 'Fix login', today: false, details: 'From the stand-up', project: 'orchard', server: 'birch', source: 'meeting',
      source_ref: 'm:abc12345', session: 'birch:cc-orchard:0.0',
    };
    expect(TOOL_DEFS.todo_add.input.parse(add)).toEqual(add);
    expect(TOOL_DEFS.todo_done.input.parse({ id: 3, result: 'Shipped' })).toEqual({ id: 3, result: 'Shipped' });
    expect(TOOL_DEFS.session_send.input.parse({ session: 'x', text: 'go', todos: [12, 15] }).todos).toEqual([12, 15]);
    const start = TOOL_DEFS.session_start.input.parse({ server: 'birch', cwd: '/home/dev/projects/x', todos: [1] });
    expect(start).toEqual({ server: 'birch', cwd: '/home/dev/projects/x', prompt: '', todos: [1] });
  });

  it('takes the card, knowledge-base and Jira tools', () => {
    expect(TOOL_DEFS.todo_get.input.parse({ id: 5 })).toEqual({ id: 5 });
    const update = { id: 5, text: 'New title', state: 'review', note: 'Blocked on the API key' };
    expect(TOOL_DEFS.todo_update.input.parse(update)).toEqual(update);
    const page = { scope: 'project', server: 'birch', project: 'orchard', title: 'Lessons', body: '- run migrations first', tags: ['lesson'] };
    expect(TOOL_DEFS.kb_write.input.parse(page)).toEqual(page);
    expect(TOOL_DEFS.kb_read.input.parse({ id: 3 })).toEqual({ id: 3 });
    expect(TOOL_DEFS.jira_get.input.parse({ key: 'ORC-123' })).toEqual({ key: 'ORC-123' });
    expect(TOOL_DEFS.jira_transition.input.parse({ key: 'ORC-123', to: 'In Review', server: 'birch' })).toEqual({ key: 'ORC-123', to: 'In Review', server: 'birch' });
    expect(TOOL_DEFS.jira_search.input.parse({ view: 'attention', limit: 5 })).toEqual({ view: 'attention', limit: 5 });
  });

  it('says Luady never writes to Jira by himself', () => {
    expect(TOOL_DEFS.jira_comment.description).toContain('only when the owner');
    expect(TOOL_DEFS.jira_transition.description).toContain('only when the owner');
  });
});
