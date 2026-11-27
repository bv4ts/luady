import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMAND_SCAN_MAX, parseTranscriptChunk } from '../../src/transcripts/parser.js';
import { HOSTILE_INPUT_BUDGET_MS, elapsedMs } from '../helpers/timing.js';

const FIXTURE = readFileSync(new URL('./fixtures/session-2.1.jsonl', import.meta.url), 'utf8');

function lineStarts(content: string): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const line of content.split('\n')) {
    starts.push(at);
    at += Buffer.byteLength(line, 'utf8') + 1;
  }
  return starts;
}

describe('parseTranscriptChunk', () => {
  it('reads a slash command near the start of a line and handles a line full of open tags well under a second', () => {
    const line = (content: string): string => `${JSON.stringify({ type: 'user', uuid: 'u-1', message: { content } })}\n`;
    const named = parseTranscriptChunk(line('<command-name>/model</command-name><command-args>opus</command-args>'), 0);
    expect(named.items[0]?.item).toMatchObject({ role: 'user', text: '/model opus' });
    const hostile = line('<command-name>'.repeat(200_000));
    expect(elapsedMs(() => parseTranscriptChunk(hostile, 0))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    const late = parseTranscriptChunk(line(`${' '.repeat(COMMAND_SCAN_MAX)}<command-name>/x</command-name>`), 0);
    expect(late.items[0]?.item.role).toBe('user');
    expect(late.items[0]?.item.text.endsWith('</command-name>')).toBe(true);
  });

  it('renders the Claude Code 2.1 fixture as chat items', () => {
    const result = parseTranscriptChunk(FIXTURE, 0);
    expect(result.items.map(({ item }) => [item.role, item.text, item.toolName])).toEqual([
      ['user', '/model opus', null],
      ['system', 'Set model to opus (claude-opus-4-5)', null],
      ['user', 'add a /health endpoint and run the tests', null],
      ['assistant', "I'll add the route next to the existing API routes.", null],
      ['tool', '🔧 Bash: grep -n "Route::get" routes/api.php | head -5', 'Bash'],
      ['tool', "↳ 12:Route::get('/users', [UserController::class, 'index']);", 'Bash'],
      ['tool', '🔧 Edit: /home/dev/projects/meadow-hr/routes/api.php', 'Edit'],
      ['tool', '↳ ✖ File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.', 'Edit'],
      ['system', 'Conversation compacted', null],
      ['user', 'شغّل الاختبارات مرة أخرى 🙏', null],
      ['assistant', 'Done — /health returns {"ok":true} and all 42 tests pass.', null],
    ]);
    expect(result.unknown).toBe(2);
    expect(result.items[3]?.item).toMatchObject({ uuid: '0a1e0000-0000-4000-8000-000000000006', ts: '2026-10-09T19:40:05.000Z' });
  });

  it('skips meta, sidechain, snapshot, queue, summary and thinking records', () => {
    const data = `${[
      JSON.stringify({ type: 'user', uuid: 'm-1', isMeta: true, message: { content: 'caveat' } }),
      JSON.stringify({ type: 'assistant', uuid: 's-1', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
      JSON.stringify({ type: 'summary', summary: 'x', leafUuid: 'y' }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'later' }),
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'z', snapshot: {} }),
      JSON.stringify({ type: 'assistant', uuid: 't-1', message: { content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'record without a uuid' } }),
    ].join('\n')}\n`;
    const result = parseTranscriptChunk(data, 0);
    expect(result.items).toEqual([]);
    expect(result.unknown).toBe(1);
  });

  it('dedupes records by uuid', () => {
    const items = parseTranscriptChunk(FIXTURE, 0).items.filter(({ item }) => item.uuid === '0a1e0000-0000-4000-8000-000000000006');
    expect(items).toHaveLength(1);
  });

  it('reports the byte offset of each item line, including multi-byte lines', () => {
    const starts = lineStarts(FIXTURE);
    const result = parseTranscriptChunk(FIXTURE, 1000);
    expect(result.items[0]?.lineStart).toBe(1000 + (starts[2] ?? -1));
    expect(result.items[9]?.lineStart).toBe(1000 + (starts[14] ?? -1));
    expect(result.items[10]?.lineStart).toBe(1000 + (starts[15] ?? -1));
  });

  it('clips long tool input and pairs results with their tool names', () => {
    const data = `${[
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        timestamp: null,
        message: { content: [{ type: 'tool_use', id: 't-1', name: 'Bash', input: { command: `echo ${'x'.repeat(300)}` } }, { type: 'text', text: 'second block' }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'line one\nline two' }, { type: 'tool_result', tool_use_id: 'missing', content: [] }] },
      }),
    ].join('\n')}\n`;
    const { items } = parseTranscriptChunk(data, 0);
    expect(items.map(({ item }) => item.uuid)).toEqual(['a-1', 'a-1:1', 'u-1', 'u-1:1']);
    const toolText = items[0]?.item.text ?? '';
    expect(Array.from(toolText)).toHaveLength(128);
    expect(toolText.endsWith('…')).toBe(true);
    expect(items[0]?.item.ts).toBeNull();
    expect(items[2]?.item).toMatchObject({ role: 'tool', text: '↳ line one', toolName: 'Bash' });
    expect(items[3]?.item).toMatchObject({ text: '↳ (no output)', toolName: null });
  });
});
