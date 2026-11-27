import { describe, expect, it } from 'vitest';
import type { AccountDTO, AccountHostDTO } from '@luady/shared';
import { limitsText } from '../../src/accounts/text.js';

// Saturday 2026-11-14, 1:00 PM in owner time.
const NOW = new Date('2026-11-14T09:00:00.000Z');
const RESET_5H = '2026-11-14T11:20:00.000Z'; // 3:20 PM owner time
const RESET_WEEK = '2026-11-16T05:00:00.000Z'; // Mon 9:00 AM owner time

function host(name: AccountHostDTO['host'], over: Partial<AccountHostDTO> = {}): AccountHostDTO {
  return { host: name, loggedIn: true, expiresAt: '2026-12-30T00:00:00.000Z', checkedAt: NOW.toISOString(), loginPending: false, canLogout: true, ...over };
}

function account(over: Partial<AccountDTO> = {}): AccountDTO {
  return {
    id: 'claude:org_max', provider: 'claude', email: 'o@x', orgName: 'Personal', plan: 'max', hosts: [host('cedar'), host('birch')],
    limits: { reported: 'yes', fiveHour: { usedPct: 62.4, resetsAt: RESET_5H }, sevenDay: { usedPct: 41, resetsAt: RESET_WEEK }, updatedAt: NOW.toISOString() },
    isManager: false, ...over,
  };
}

describe('limitsText', () => {
  it('one line per Claude account with both windows and their reset times in owner time', () => {
    expect(limitsText([account()], NOW)).toBe('Max (cedar, birch) · 5h 62% (resets 3:20 PM) · week 41% (resets Mon 9:00 AM)');
  });

  it('a plan that does not report limits', () => {
    const line = limitsText([account({ limits: { reported: 'no', fiveHour: null, sevenDay: null, updatedAt: null } })], NOW);
    expect(line).toBe('Max (cedar, birch) · this plan does not report limits');
  });

  it('no reading yet', () => {
    const line = limitsText([account({ plan: null, limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null } })], NOW);
    expect(line).toBe('Claude (cedar, birch) · no reading yet');
  });

  it('a missing window is unknown, never zero', () => {
    const line = limitsText([account({ limits: { reported: 'yes', fiveHour: null, sevenDay: { usedPct: 12, resetsAt: RESET_WEEK }, updatedAt: null } })], NOW);
    expect(line).toBe('Max (cedar, birch) · 5h unknown · week 12% (resets Mon 9:00 AM)');
  });

  it('a signed-out host, and a sign-in that ends within 48 hours', () => {
    const line = limitsText([account({ hosts: [host('cedar', { loggedIn: false }), host('birch', { expiresAt: '2026-11-15T06:00:00.000Z' })] })], NOW);
    expect(line).toBe('Max (cedar, birch) · 5h 62% (resets 3:20 PM) · week 41% (resets Mon 9:00 AM) · cedar is signed out · birch\'s sign-in ends tomorrow 10:00 AM');
  });

  it("names Luady's own host Luady, leaves the Codex account out, and says when nothing is known", () => {
    const luady = account({ id: 'claude:org_luady', hosts: [host('hq', { loggedIn: false })], isManager: true });
    const codex = account({ id: 'codex', provider: 'codex', plan: 'ChatGPT' });
    expect(limitsText([luady, codex], NOW)).toBe('Max (Luady) · 5h 62% (resets 3:20 PM) · week 41% (resets Mon 9:00 AM) · Luady is signed out');
    expect(limitsText([codex], NOW)).toBe('No Claude account has been checked yet.');
  });
});
