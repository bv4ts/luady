import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpoolEvent } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { createTranscriptWatcher, remember, type TranscriptWatcher } from '../../src/web/transcript-watcher.js';
import { silentLogger } from '../helpers/fakes.js';
import { fakeSessions, sampleItem, sampleSession, SESSION_ID } from './helpers.js';

const OPTIONS = { debounceMs: 500, pollMs: 10_000, pageSize: 50, maxRemembered: 500 };
let current: TranscriptWatcher | undefined;
let eventSeq = 0;

function page(...uuids: string[]) {
  return { items: uuids.map((uuid) => sampleItem(uuid)), nextCursor: null };
}

function stopEvent(tmux: string | null, claudeSessionId: string | null): SpoolEvent {
  eventSeq += 1;
  return {
    v: 1,
    id: `event-${String(eventSeq).padStart(8, '0')}`,
    ts: '2026-10-09T12:00:00Z',
    host: 'cedar',
    session_id: claudeSessionId,
    cwd: '/home/dev/projects/meadow-hr',
    transcript_path: null,
    tmux,
    permission_mode: 'bypassPermissions',
    event: 'stop',
    data: { last_assistant_message: 'done', truncated: false },
  };
}

function setup() {
  const bus = createBus();
  const sessions = fakeSessions();
  const transcript = vi.mocked(sessions.transcript);
  transcript.mockResolvedValue(page('u1', 'u2'));
  const deliver = vi.fn();
  const watcher = createTranscriptWatcher({ bus, sessions, log: silentLogger(), deliver }, OPTIONS);
  current = watcher;
  return { bus, transcript, deliver, watcher };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  current?.close();
  current = undefined;
  vi.useRealTimers();
});

describe('TranscriptWatcher', () => {
  it('takes a silent baseline of the newest page on the first subscribe', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    expect(t.transcript).toHaveBeenCalledTimes(1);
    expect(t.transcript).toHaveBeenCalledWith(SESSION_ID, null, 50);
    expect(t.deliver).not.toHaveBeenCalled();
  });

  it('debounces spool events for the session by 500 ms and delivers only new uuids', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    t.transcript.mockResolvedValue(page('u1', 'u2', 'u3'));
    t.bus.emit('spool.event', { host: 'cedar', event: stopEvent('cc-meadow-hr:0.0', 'claude-1'), replay: false });
    await vi.advanceTimersByTimeAsync(499);
    expect(t.transcript).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(t.transcript).toHaveBeenCalledTimes(2);
    expect(t.deliver).toHaveBeenCalledWith(SESSION_ID, [sampleItem('u3')]);
  });

  it('coalesces a burst of events into a single fetch', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    for (let i = 0; i < 5; i += 1) {
      t.bus.emit('session.updated', sampleSession());
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.transcript).toHaveBeenCalledTimes(2);
  });

  it('polls every 10 s while subscribed', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.transcript).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.transcript).toHaveBeenCalledTimes(3);
    expect(t.deliver).not.toHaveBeenCalled();
  });

  it('reacts to session.updated only for watched sessions', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    t.bus.emit('session.updated', sampleSession({ id: 'birch:cc-orchard:0.0' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(t.transcript).toHaveBeenCalledTimes(1);
    t.bus.emit('session.updated', sampleSession());
    await vi.advanceTimersByTimeAsync(500);
    expect(t.transcript).toHaveBeenCalledTimes(2);
  });

  it('matches spool events by claude session id when tmux is null', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    t.bus.emit('spool.event', { host: 'birch', event: stopEvent(null, 'claude-9'), replay: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(t.transcript).toHaveBeenCalledTimes(1);
    t.bus.emit('spool.event', { host: 'cedar', event: stopEvent(null, 'claude-1'), replay: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(t.transcript).toHaveBeenCalledTimes(2);
  });

  it('is ref-counted per session and stops polling after the last unsubscribe', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    t.watcher.subscribe(SESSION_ID);
    await flush();
    expect(t.transcript).toHaveBeenCalledTimes(1);
    t.watcher.unsubscribe(SESSION_ID);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.transcript).toHaveBeenCalledTimes(2);
    t.watcher.unsubscribe(SESSION_ID);
    expect(t.watcher.watched()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.transcript).toHaveBeenCalledTimes(2);
  });

  it('ingest delivers unseen items once and the poll does not repeat them', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    t.watcher.ingest(SESSION_ID, [sampleItem('u2'), sampleItem('u9')]);
    expect(t.deliver).toHaveBeenCalledWith(SESSION_ID, [sampleItem('u9')]);
    t.transcript.mockResolvedValue(page('u1', 'u2', 'u9'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it('after a failed baseline the next page is delivered in full (the client dedupes by uuid)', async () => {
    const t = setup();
    t.transcript.mockRejectedValueOnce(new Error('cedar is offline'));
    t.watcher.subscribe(SESSION_ID);
    await flush();
    expect(t.deliver).not.toHaveBeenCalled();
    t.transcript.mockResolvedValue(page('u1'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.deliver).toHaveBeenCalledWith(SESSION_ID, [sampleItem('u1')]);
  });

  it('stops reacting after close', async () => {
    const t = setup();
    t.watcher.subscribe(SESSION_ID);
    await flush();
    t.watcher.close();
    t.bus.emit('session.updated', sampleSession());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.transcript).toHaveBeenCalledTimes(1);
    expect(t.watcher.watched()).toEqual([]);
  });

  it('remember keeps only the most recent uuids', () => {
    expect([...remember(new Set(['a', 'b']), ['b', 'c', 'd'], 3)]).toEqual(['b', 'c', 'd']);
  });
});
