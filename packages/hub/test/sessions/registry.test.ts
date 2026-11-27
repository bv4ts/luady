import { describe, expect, it } from 'vitest';
import { promptHash, type SpoolEvent } from '@luady/shared';
import { deriveSessionName, displayNameFor, projectFor, sessionIdForEvent, sessionLabel } from '../../src/sessions/naming.js';
import { reduceSession, type Reduction, type SessionRow } from '../../src/sessions/registry.js';
import {
  notification,
  permission,
  permissionResolved,
  prompt,
  question,
  questionResolved,
  sessionEnd,
  sessionStart,
  stop,
  stopFailure,
} from './spool-events.js';

const ID = 'cedar:cc-meadow-hr:0.0';
const Q = [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];

function must(reduction: Reduction | null): Reduction {
  if (reduction === null) throw new Error('expected a reduction');
  return reduction;
}

function run(events: SpoolEvent[]): SessionRow {
  let row: SessionRow | null = null;
  for (const event of events) row = must(reduceSession(row, 'cedar', event)).row;
  if (row === null) throw new Error('no events');
  return row;
}

describe('session naming', () => {
  it('derives display names and labels from tmux targets', () => {
    expect(displayNameFor('cc-meadow-hr:0.0')).toBe('meadow-hr');
    expect(displayNameFor('cc-meadow-hr:1.2')).toBe('meadow-hr#1.2');
    expect(displayNameFor('manager:0.0')).toBe('manager');
    expect(displayNameFor('main:0.1')).toBe('main#0.1');
    expect(sessionLabel('cedar', 'meadow-hr')).toBe('cedar · meadow-hr');
  });

  it('derives projects, session ids and safe session names', () => {
    expect(projectFor('/home/dev/projects/orchard/')).toBe('orchard');
    expect(projectFor(null)).toBeNull();
    expect(sessionIdForEvent('cedar', { tmux: 'cc-x:0.0' })).toBe('cedar:cc-x:0.0');
    expect(sessionIdForEvent('cedar', { tmux: null })).toBeNull();
    expect(sessionIdForEvent('cedar', { tmux: 'bad target' })).toBeNull();
    expect(deriveSessionName('/home/dev/projects/my app!')).toBe('my-app-');
    expect(deriveSessionName(`/home/dev/projects/${'x'.repeat(80)}`)).toHaveLength(61);
  });
});

describe('reduceSession', () => {
  it('creates a registered idle row on session_start', () => {
    const result = must(reduceSession(null, 'cedar', sessionStart('startup')));
    expect(result.signals).toEqual([]);
    expect(result.row).toEqual({
      id: ID,
      host: 'cedar',
      tmuxTarget: 'cc-meadow-hr:0.0',
      claudeSessionId: 'claude-a',
      transcriptPath: '/home/dev/.claude/projects/-home-dev-projects-meadow-hr/claude-a.jsonl',
      cwd: '/home/dev/projects/meadow-hr',
      project: 'meadow-hr',
      displayName: 'meadow-hr',
      state: 'idle',
      origin: 'owner',
      registered: true,
      createdAt: '2026-10-09T12:00:00.000Z',
      lastEventAt: '2026-10-09T12:00:00.000Z',
      turnStartedAt: null,
      turnRemote: false,
      pendingQid: null,
      unexpectedEnd: false,
    });
  });

  it('session_start with source=clear rebinds claude id on same row', () => {
    const waiting = run([sessionStart('startup', { session_id: 'claude-a' }), question('QQQQ2345', Q)]);
    const cleared = must(reduceSession(waiting, 'cedar', sessionStart('clear', { session_id: 'claude-b', transcript_path: '/t/claude-b.jsonl' }))).row;
    expect(cleared.id).toBe(waiting.id);
    expect(cleared).toMatchObject({
      claudeSessionId: 'claude-b',
      transcriptPath: '/t/claude-b.jsonl',
      pendingQid: 'QQQQ2345',
      state: 'waiting_question',
    });
    const staleEnd = must(reduceSession(cleared, 'cedar', sessionEnd('clear', { session_id: 'claude-a' })));
    expect(staleEnd.row.state).toBe('waiting_question');
    expect(staleEnd.signals).toEqual([]);
    const idle = run([sessionStart('startup', { session_id: 'claude-a' }), sessionStart('clear', { session_id: 'claude-c' })]);
    expect(idle).toMatchObject({ id: ID, claudeSessionId: 'claude-c', state: 'idle', pendingQid: null });
  });

  it('compact keeps the running turn; startup and resume reset it', () => {
    const working = run([sessionStart('startup'), prompt('long task', { ts: '2026-10-09T12:01:00.000Z' })]);
    const compacted = must(reduceSession(working, 'cedar', sessionStart('compact', { session_id: 'claude-a2' }))).row;
    expect(compacted).toMatchObject({ state: 'working', turnStartedAt: '2026-10-09T12:01:00.000Z', claudeSessionId: 'claude-a2' });
    const resumed = must(reduceSession(working, 'cedar', sessionStart('resume', { session_id: 'claude-r' }))).row;
    expect(resumed).toMatchObject({ state: 'idle', turnStartedAt: null, pendingQid: null, claudeSessionId: 'claude-r' });
  });

  it('prompt starts a turn and stop finishes it with the turn data', () => {
    const started = must(reduceSession(run([sessionStart('startup')]), 'cedar', prompt('add tests', { ts: '2026-10-09T12:05:00.000Z' })));
    expect(started.row).toMatchObject({ state: 'working', turnStartedAt: '2026-10-09T12:05:00.000Z' });
    expect(started.signals).toEqual([{ kind: 'turn_started', promptSha256: promptHash('add tests'), preview: 'add tests' }]);
    const finished = must(reduceSession({ ...started.row, turnRemote: true }, 'cedar', stop('All green.', { ts: '2026-10-09T12:09:00.000Z' })));
    expect(finished.row).toMatchObject({ state: 'idle', turnStartedAt: null, turnRemote: false });
    expect(finished.signals).toEqual([
      { kind: 'turn_finished', startedAt: '2026-10-09T12:05:00.000Z', remote: true, lastMessage: 'All green.' },
    ]);
  });

  it('accumulates queued prompts until Stop: earliest ts and remote flag survive', () => {
    const first = must(reduceSession(run([sessionStart('startup')]), 'cedar', prompt('A', { ts: '2026-10-09T12:00:00.000Z' }))).row;
    const queued = must(reduceSession({ ...first, turnRemote: true }, 'cedar', prompt('B', { ts: '2026-10-09T12:00:30.000Z' }))).row;
    expect(queued).toMatchObject({ turnStartedAt: '2026-10-09T12:00:00.000Z', turnRemote: true });
  });

  it('stop_failure sets error until the next prompt', () => {
    const failed = must(reduceSession(run([sessionStart('startup'), prompt('x')]), 'cedar', stopFailure('rate_limit')));
    expect(failed.row.state).toBe('error');
    expect(failed.signals).toEqual([{ kind: 'failed', error: 'rate_limit' }]);
    expect(must(reduceSession(failed.row, 'cedar', prompt('again'))).row.state).toBe('working');
  });

  it('question and permission events set and clear the pending qid', () => {
    const asked = run([sessionStart('startup'), prompt('x'), question('QQQQ2345', Q)]);
    expect(asked).toMatchObject({ state: 'waiting_question', pendingQid: 'QQQQ2345' });
    expect(must(reduceSession(asked, 'cedar', questionResolved('ZZZZ2345', 'answered'))).row.pendingQid).toBe('QQQQ2345');
    expect(must(reduceSession(asked, 'cedar', questionResolved('QQQQ2345', 'answered'))).row).toMatchObject({ state: 'working', pendingQid: null });
    const perm = run([sessionStart('startup'), prompt('x'), permission('PPPP2345', 'Bash', 'rm -rf build')]);
    expect(perm).toMatchObject({ state: 'waiting_permission', pendingQid: 'PPPP2345' });
    expect(must(reduceSession(perm, 'cedar', permissionResolved('PPPP2345', 'allowed'))).row).toMatchObject({ state: 'working', pendingQid: null });
  });

  it('session_end ends the row once and ignores clear, resume and stale ids', () => {
    const live = run([sessionStart('startup', { session_id: 'claude-a' })]);
    const ended = must(reduceSession(live, 'cedar', sessionEnd('prompt_input_exit', { session_id: 'claude-a' })));
    expect(ended.row).toMatchObject({ state: 'ended', unexpectedEnd: false });
    expect(ended.signals).toEqual([{ kind: 'ended', reason: 'prompt_input_exit' }]);
    expect(must(reduceSession(ended.row, 'cedar', sessionEnd('other'))).signals).toEqual([]);
    for (const reason of ['clear', 'resume']) {
      expect(must(reduceSession(live, 'cedar', sessionEnd(reason))).row.state).toBe('idle');
    }
    expect(must(reduceSession(live, 'cedar', sessionEnd('logout', { session_id: 'claude-old' }))).row.state).toBe('idle');
  });

  it('notifications about quota or usage limits become usage signals', () => {
    const row = run([sessionStart('startup')]);
    expect(must(reduceSession(row, 'cedar', notification('quota_warning', 'Approaching limit'))).signals).toEqual([
      { kind: 'usage', message: 'Approaching limit' },
    ]);
    expect(must(reduceSession(row, 'cedar', notification('error', 'Claude usage limit reached. Resets 5pm'))).signals).toHaveLength(1);
    expect(must(reduceSession(row, 'cedar', notification('idle_prompt', 'Claude is waiting for your input'))).signals).toEqual([]);
  });

  it('ignores events without a valid pane and ends of unknown rows', () => {
    expect(reduceSession(null, 'cedar', prompt('x', { tmux: null }))).toBeNull();
    expect(reduceSession(null, 'cedar', prompt('x', { tmux: 'nope' }))).toBeNull();
    expect(reduceSession(null, 'cedar', sessionEnd('other'))).toBeNull();
    expect(must(reduceSession(null, 'cedar', prompt('first event after a hub restart'))).row).toMatchObject({
      state: 'working',
      registered: true,
      claudeSessionId: null,
    });
  });

  it('rows from the brain host are system rows', () => {
    expect(must(reduceSession(null, 'hq', sessionStart('startup', { tmux: 'manager:0.0' }))).row).toMatchObject({
      id: 'hq:manager:0.0',
      origin: 'system',
      displayName: 'manager',
    });
  });
});
