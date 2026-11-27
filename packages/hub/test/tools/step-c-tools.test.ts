import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { NOT_AVAILABLE_YET } from '../../src/tools/common.js';
import { createToolHandlers } from '../../src/tools/handlers.js';
import { createFakeToolContext } from './fake-context.js';

describe('the knowledge base and Jira tools answer "Not available yet." after checking their input', () => {
  it.each([
    ['kb_search', { query: 'deploy' }],
    ['kb_read', { id: 1 }],
    ['kb_write', { scope: 'global', title: 'Rules', body: 'Be kind' }],
    ['jira_search', { view: 'sprint' }],
    ['jira_get', { key: 'ORC-123' }],
    ['jira_comment', { key: 'ORC-123', text: 'On it' }],
    ['jira_transition', { key: 'ORC-123', to: 'Done' }],
  ] as const)('%s', async (name, input) => {
    await expect(createToolHandlers()[name](input, createFakeToolContext())).resolves.toBe(NOT_AVAILABLE_YET);
  });

  it('still refuses bad input', async () => {
    const handlers = createToolHandlers();
    await expect(handlers.jira_get({ key: 'orc-1' }, createFakeToolContext())).rejects.toBeInstanceOf(ValidationError);
    await expect(handlers.kb_write({ scope: 'project', title: 'x', body: '' }, createFakeToolContext())).rejects.toBeInstanceOf(ValidationError);
  });
});

