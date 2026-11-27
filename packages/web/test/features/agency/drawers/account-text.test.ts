import { describe, expect, it } from 'vitest';
import {
  accountTitle, hostLine, limitLine, limitsNote, whenText,
} from '../../../../src/features/agency/drawers/account-text.js';
import { account, accountHost } from '../../../fixtures.js';

/** Saturday 14 November 2026, 2:00 PM in owner time. */
const NOW = new Date('2026-11-14T10:00:00Z');

describe('account texts', () => {
  it('accountTitle: e-mail, else organisation, else not signed in', () => {
    expect(accountTitle(account())).toBe('owner@example.com');
    expect(accountTitle(account({ email: null }))).toBe('Personal');
    expect(accountTitle(account({ email: null, orgName: null }))).toBe('Not signed in');
  });

  it('whenText: a time today, a weekday this week, a date later', () => {
    expect(whenText('2026-11-14T11:20:00Z', NOW)).toBe('3:20 PM');
    expect(whenText('2026-11-15T05:00:00Z', NOW)).toBe('Sun 9:00 AM');
    expect(whenText('2026-12-01T05:00:00Z', NOW)).toBe('Dec 1');
    expect(whenText('nope', NOW)).toBe('');
  });

  it('hostLine for each sign-in state', () => {
    expect(hostLine(accountHost({ host: 'cedar', expiresAt: '2026-11-15T05:00:00Z' }), NOW)).toBe('cedar · signed in until Sun 9:00 AM');
    expect(hostLine(accountHost({ host: 'cedar', expiresAt: null }), NOW)).toBe('cedar · signed in');
    expect(hostLine(accountHost({ host: 'ash', loggedIn: false, expiresAt: null }), NOW)).toBe('ash · signed out');
    expect(hostLine(accountHost({ host: 'birch', loggedIn: null, checkedAt: null }), NOW)).toBe('birch · not checked yet');
    expect(hostLine(accountHost({ host: 'birch', loggedIn: null }), NOW)).toBe('birch · could not be checked');
    expect(hostLine(accountHost({ host: 'ash', loggedIn: false, loginPending: true }), NOW)).toBe('ash · signed out · sign-in waiting for its code');
  });

  it('limitLine: the use and the reset, "not reported" for a missing window, never 0% or NaN', () => {
    expect(limitLine('5-hour limit', { usedPct: 62, resetsAt: '2026-11-14T11:20:00Z' }, NOW)).toBe('5-hour limit 62% · resets 3:20 PM');
    expect(limitLine('Weekly limit', { usedPct: 41.4, resetsAt: '2026-11-15T05:00:00Z' }, NOW)).toBe('Weekly limit 41% · resets Sun 9:00 AM');
    expect(limitLine('Weekly limit', null, NOW)).toBe('Weekly limit not reported');
    expect(limitLine('5-hour limit', { usedPct: 90, resetsAt: '2026-11-14T09:00:00Z' }, NOW)).toBe('5-hour limit reset at 1:00 PM, no new reading yet');
    expect(limitLine('5-hour limit', { usedPct: Number.NaN, resetsAt: '2026-11-14T11:20:00Z' }, NOW)).toBe('5-hour limit not reported');
  });

  it('limitsNote says which of the three it is', () => {
    expect(limitsNote(account().limits)).toBeNull();
    expect(limitsNote({ reported: 'no', fiveHour: null, sevenDay: null, updatedAt: null })).toBe('This plan does not report limits.');
    expect(limitsNote({ reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null })).toBe('No reading yet.');
  });
});
