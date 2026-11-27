import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@luady/shared';
import { ValidationError } from '../../src/core/errors.js';
import { createToolHandlers } from '../../src/tools/handlers.js';
import { createFakeToolContext } from './fake-context.js';

const SERVER_TARGETING = {
  server_exec: { command: 'uptime', reason: 'check' },
  file_read: { path: '/etc/hosts' },
  file_write: { path: '/home/dev/projects/x/a', content: '', reason: 'test' },
  claude_update: { reason: 'update' },
  project_info: { project: 'x' },
  session_start: { cwd: '/home/dev/projects/x' },
} as const;

const SERVER_TOOL_CASES = (Object.keys(SERVER_TARGETING) as Array<keyof typeof SERVER_TARGETING>).map((name) => ({ name }));

describe('createToolHandlers', () => {
  it('provides exactly one handler per TOOL_DEFS entry', () => {
    expect(Object.keys(createToolHandlers()).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('returns a fresh registry on every call', () => {
    expect(createToolHandlers()).not.toBe(createToolHandlers());
  });

  it.for(TOOL_NAMES.map((name) => ({ name })))('$name rejects unknown input keys', async ({ name }) => {
    const handlers = createToolHandlers();
    await expect(handlers[name]({ unexpected: true }, createFakeToolContext())).rejects.toBeInstanceOf(ValidationError);
  });

  it.for(SERVER_TOOL_CASES)('$name refuses the self host as a server', async ({ name }) => {
    const handlers = createToolHandlers();
    const input = { server: 'hq', ...SERVER_TARGETING[name] };
    await expect(handlers[name](input, createFakeToolContext())).rejects.toBeInstanceOf(ValidationError);
  });
});
