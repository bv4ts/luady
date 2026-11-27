import { describe, expect, it } from 'vitest';
import { ACK_AFTER_MS, createAckTracker } from '../../../../src/features/agency/model/ack-tracker.js';
import { noticeIcon, noticeStatus } from '../../../../src/features/agency/model/notice-text.js';
import { notice } from '../../../fixtures.js';

describe('createAckTracker', () => {
  it('a notice on screen with attention is due after three seconds, once', () => {
    const tracker = createAckTracker();
    tracker.attention(true, 0);
    tracker.shown('n1', 0);
    expect(ACK_AFTER_MS).toBe(3000);
    expect(tracker.due(2999)).toEqual([]);
    expect(tracker.due(3000)).toEqual(['n1']);
    expect(tracker.due(4000)).toEqual([]);
  });

  it('losing attention resets the clock', () => {
    const tracker = createAckTracker();
    tracker.attention(true, 0);
    tracker.shown('n1', 0);
    tracker.attention(false, 2000);
    expect(tracker.due(4000)).toEqual([]);
    tracker.attention(true, 5000);
    expect(tracker.due(7999)).toEqual([]);
    expect(tracker.due(8000)).toEqual(['n1']);
  });

  it('a notice that left the screen is never due', () => {
    const tracker = createAckTracker();
    tracker.attention(true, 0);
    tracker.shown('n1', 0);
    tracker.hidden('n1');
    expect(tracker.due(10_000)).toEqual([]);
  });

  it('without attention nothing is ever due', () => {
    const tracker = createAckTracker();
    tracker.shown('n1', 0);
    expect(tracker.due(60_000)).toEqual([]);
  });

  it('showing it again does not restart a running clock, and a done one stays done', () => {
    const tracker = createAckTracker();
    tracker.attention(true, 0);
    tracker.shown('n1', 0);
    tracker.shown('n1', 2000);
    expect(tracker.due(3000)).toEqual(['n1']);
    tracker.hidden('n1');
    tracker.shown('n1', 5000);
    expect(tracker.due(9000)).toEqual([]);
    expect(tracker.watching()).toBe(false);
  });

  it('done() marks an id as handled (a click)', () => {
    const tracker = createAckTracker();
    tracker.attention(true, 0);
    tracker.shown('n1', 0);
    tracker.done('n1');
    expect(tracker.due(5000)).toEqual([]);
  });
});

describe('notice texts', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  it('noticeStatus says where it went', () => {
    expect(noticeStatus(notice({ settledAt: '2026-11-14T10:00:00Z', settledVia: 'web' }), now)).toBe('Seen');
    expect(noticeStatus(notice({ settledAt: '2026-11-14T10:00:00Z', settledVia: 'answer' }), now)).toBe('Answered');
    expect(noticeStatus(notice({ chatSentAt: '2026-11-14T11:30:00Z', settledAt: '2026-11-14T11:30:00Z', settledVia: 'test-channel' }), now))
      .toBe('Sent to your chat channel 3:30 PM');
    // By design: the chat channel by its own name, never a fixed chat app.
    expect(noticeStatus(notice({ chatDueAt: '2026-11-14T11:30:00Z' }), now, 'Chat app')).toBe('Goes to Chat app at 3:30 PM');
    expect(noticeStatus(notice({ chatDueAt: null }), now)).toBe('Website only');
    expect(noticeStatus(notice({ settledAt: '2026-11-14T10:00:00Z', settledVia: 'expired' }), now)).toBe('');
  });

  it('noticeIcon has an icon for every kind', () => {
    for (const kind of ['reply', 'result', 'question', 'permission', 'alert', 'mail', 'meeting', 'morning', 'system'] as const) {
      expect(typeof noticeIcon(kind)).toBe('string');
    }
  });
});
