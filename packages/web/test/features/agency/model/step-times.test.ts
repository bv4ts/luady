import { describe, expect, it } from 'vitest';
import { stepTimesOf } from '../../../../src/features/agency/model/step-times.js';
import { activityItem } from '../../../fixtures.js';

describe('stepTimesOf', () => {
  it('maps each session with a step time to epoch ms, and leaves out the rest', () => {
    const times = stepTimesOf({
      a: activityItem({ sessionId: 'a', lastStepAt: '2026-10-09T12:00:00.000Z' }),
      b: activityItem({ sessionId: 'b', lastStepAt: null }),
      c: activityItem({ sessionId: 'c', lastStepAt: 'not a time' }),
    });
    expect(times).toEqual({ a: Date.parse('2026-10-09T12:00:00.000Z') });
  });

  it('is empty for an older hub', () => {
    expect(stepTimesOf({})).toEqual({});
  });
});
