import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import {
  boardColumns, boardSummary, checkConnect, dayText, fellBack, jiraErrorText, normaliseSite, officeOf, parseLabels, ticketCardTitle,
} from '../../../../src/features/agency/drawers/jira/jira-model.js';
import { roomLookup } from '../../../../src/features/rooms/room-lookup.js';
import { classicRoomDtos, roomDto } from '../../../room-fixtures.js';
import { board, issue } from './library-jira-fixtures.js';

describe('jira model', () => {
  it('orders the columns to-do, in progress, done and fills them from the keys', () => {
    const columns = boardColumns(board());
    expect(columns.map((column) => [column.name, column.issues.map((i) => i.key)])).toEqual([
      ['To Do', ['ORC-101']], ['In Progress', ['ORC-102']], ['Done', ['ORC-103']],
    ]);
  });

  it('places a ticket missing from the columns by its status, and skips keys without a ticket', () => {
    const columns = boardColumns(board({
      issues: [issue(), issue({ key: 'ORC-9', status: { name: 'In Review', category: 'doing' } }), issue({ key: 'ORC-8' })],
      columns: [{ name: 'To Do', category: 'todo', keys: ['ORC-101', 'ORC-404', 'ORC-101'] }],
    }));
    expect(columns.map((column) => [column.name, column.issues.map((i) => i.key)])).toEqual([['To Do', ['ORC-101', 'ORC-8']], ['In Review', ['ORC-9']]]);
  });

  it('summarises a board and sees the sprint fallback', () => {
    expect(boardSummary(board().issues)).toBe('3 tickets · 1 with news');
    expect(boardSummary([issue()])).toBe('1 ticket');
    expect(fellBack('sprint', { view: 'mine' })).toBe(true);
    expect(fellBack('mine', { view: 'mine' })).toBe(false);
  });

  it('normalises and checks the connect form', () => {
    expect(normaliseSite(' Orchard-Demo.atlassian.net/jira/your-work ')).toBe('https://orchard-demo.atlassian.net');
    expect(normaliseSite('http://orchard-demo.atlassian.net')).toBe('http://orchard-demo.atlassian.net');
    expect(checkConnect({ site: '', email: '', token: '' })).toEqual({
      ok: false,
      errors: { site: expect.stringContaining('Type your Jira address'), email: expect.any(String), token: 'Paste the API token.' },
    });
    expect(checkConnect({ site: 'https://evil.example.com', email: 'nope', token: 'short' })).toEqual({
      ok: false,
      errors: { site: expect.stringContaining('atlassian.net'), email: 'That does not look like an e-mail address.', token: expect.stringContaining('too short') },
    });
    expect(checkConnect({ site: 'orchard-demo.atlassian.net', email: ' o@example.com ', token: ' test-token-padded ' }))
      .toEqual({ ok: true, baseUrl: 'https://orchard-demo.atlassian.net', email: 'o@example.com', token: 'test-token-padded' });
  });

  it('words hub errors for the owner', () => {
    expect(jiraErrorText(new ApiError(409, 'jira_not_connected', 'x'))).toBe('Jira is not connected for this office.');
    expect(jiraErrorText(new ApiError(501, 'not_built_yet', 'x'))).toContain('next update');
    expect(jiraErrorText(new ApiError(400, 'jira_auth', 'Jira refused the sign-in. The token may have expired.'))).toBe('Jira refused the sign-in. The token may have expired.');
  });

  it('has the small helpers', () => {
    const lookup = roomLookup(classicRoomDtos());
    expect(officeOf('cedar', lookup)).toBe('cedar');
    expect(officeOf('hq', lookup)).toBe('birch');
    expect(officeOf('lot-7', roomLookup([roomDto({ id: 'mars', position: 4 })]))).toBe('mars');
    expect(officeOf('hq', roomLookup([]))).toBeNull();
    expect(ticketCardTitle(issue())).toBe('ORC-101 Checkout total is wrong');
    expect(ticketCardTitle(issue({ summary: 'x'.repeat(400) }))).toHaveLength(300);
    expect(dayText('2026-11-20')).toBe('Nov 20, 2026');
    expect(dayText('soon')).toBe('soon');
    expect(parseLabels('web, ios  web,api')).toEqual(['web', 'ios', 'api']);
  });
});
