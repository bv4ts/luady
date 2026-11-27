import { toolKind } from '@luady/office';
import { toolKindOf } from '@luady/shared';
import { describe, expect, it } from 'vitest';

/** The known tool names, plus an MCP tool and an empty name. */
const NAMES = [
  'Read', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell',
  'Grep', 'Glob', 'LS', 'ToolSearch', 'WebFetch', 'WebSearch', 'Skill', 'Agent', 'Task',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'ExitPlanMode', 'mcp__x__y', '',
];

describe('tool kinds', () => {
  it.each(NAMES)('the shared and office tables agree on %j', (name) => {
    expect(toolKindOf(name)).toBe(toolKind(name));
  });
});
