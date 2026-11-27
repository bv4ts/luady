import type { AccountDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { pickEnergy, pillText } from '../../../../src/features/agency/model/energy.js';
import { account, accountHost, presence } from '../../../fixtures.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const later = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function on(host: AccountDTO['hosts'][number]['host'], five: number | null, over: Partial<AccountDTO> = {}): AccountDTO {
  return account({
    id: `claude:${host}`, hosts: [accountHost({ host })],
    limits: {
      reported: 'yes', fiveHour: five === null ? null : { usedPct: five, resetsAt: later(2) },
      sevenDay: { usedPct: 30, resetsAt: later(48) }, updatedAt: later(0),
    },
    ...over,
  });
}

const silent = (host: AccountDTO['hosts'][number]['host']): AccountDTO =>
  on(host, null, { limits: { reported: 'no', fiveHour: null, sevenDay: null, updatedAt: later(0) } });

describe('pickEnergy', () => {
  it('is null with no accounts, or only accounts that do not report limits', () => {
    expect(pickEnergy([], null, NOW)).toBeNull();
    expect(pickEnergy([silent('birch'), silent('ash')], null, NOW)).toBeNull();
  });

  it('shows the fullest account', () => {
    expect(pickEnergy([on('cedar', 40), on('birch', 88), on('ash', 12)], null, NOW)).toMatchObject({ accountId: 'claude:birch', label: 'birch', usedPct: 88 });
  });

  it('a focused room shows its own account even when it is not the fullest', () => {
    expect(pickEnergy([on('cedar', 40), on('birch', 88)], 'cedar', NOW)).toMatchObject({ accountId: 'claude:cedar', label: 'cedar', usedPct: 40 });
  });

  it('a focused room whose account does not report falls back to the fullest', () => {
    expect(pickEnergy([silent('ash'), on('cedar', 40), on('birch', 88)], 'ash', NOW)?.accountId).toBe('claude:birch');
  });

  it('ignores a window that is missing or already reset, and Codex', () => {
    const reset = on('cedar', 99, { limits: { reported: 'yes', fiveHour: { usedPct: 99, resetsAt: later(-1) }, sevenDay: null, updatedAt: later(-2) } });
    const codex = on('hq', 100, { id: 'codex', provider: 'codex' });
    expect(pickEnergy([reset, codex, on('birch', null)], null, NOW)).toBeNull();
  });

  it('turns amber at 85 and red at 95', () => {
    const tone = (pct: number) => pickEnergy([on('cedar', pct)], null, NOW)?.tone;
    expect([tone(84), tone(85), tone(94), tone(95)]).toEqual(['ok', 'amber', 'amber', 'red']);
  });
});

describe('pillText', () => {
  const now = new Date(NOW);
  it('says where updates go, with the end of a forced hour in owner time', () => {
    expect(pillText(presence(), now)).toBe('Updates: here');
    // By design: the chat channel by its own name, never a fixed chat app.
    expect(pillText(presence({ mode: 'chat', online: false }), now)).toBe('Updates: your chat channel');
    expect(pillText(presence({ mode: 'chat', forcedUntil: '2026-11-14T12:10:00Z' }), now, 'Chat app')).toBe('Updates: Chat app until 4:10 PM');
    expect(pillText(null, now)).toBe('');
  });
});
