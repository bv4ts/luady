import { describe, expect, it } from 'vitest';
import type { HostId } from '@luady/shared';
import type { HostLimits } from '../../src/accounts/limits.js';
import { accountIdOf, groupAccounts, type GroupInput } from '../../src/accounts/group.js';
import type { LoginStatus } from '../../src/claude-login/status.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function status(host: HostId, over: Partial<LoginStatus> = {}): LoginStatus {
  return {
    host, loggedIn: true, email: 'owner@example.com', orgId: 'org_max', orgName: 'Personal', plan: 'max',
    expiresAt: '2026-12-01T00:00:00.000Z', checkedAt: at(30), ...over,
  };
}

function limits(host: HostId, minutesAgo: number, five: number, week: number): HostLimits {
  return {
    host, reported: 'yes', updatedAt: at(minutesAgo), fiveHourAt: at(minutesAgo), sevenDayAt: at(minutesAgo),
    fiveHour: { usedPct: five, resetsAt: '2026-11-14T12:00:00.000Z' }, sevenDay: { usedPct: week, resetsAt: '2026-11-17T05:00:00.000Z' },
  };
}

function input(over: Partial<GroupInput>): GroupInput {
  return { statuses: [], limits: [], pending: [], kitOk: () => true, now: NOW, ...over };
}

describe('accountIdOf', () => {
  it('uses the organisation, else the lower-cased e-mail, else the host', () => {
    expect(accountIdOf({ host: 'cedar', orgId: 'org_1', email: 'A@B.c' })).toBe('claude:org_1');
    expect(accountIdOf({ host: 'cedar', orgId: null, email: 'Owner@Example.COM' })).toBe('claude:owner@example.com');
    expect(accountIdOf({ host: 'cedar', orgId: null, email: null })).toBe('claude:host:cedar');
  });
});

describe('groupAccounts', () => {
  it('two hosts with the same organisation are one account with two host rows', () => {
    const accounts = groupAccounts(input({ statuses: [status('cedar'), status('local')] }));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'claude:org_max', provider: 'claude', email: 'owner@example.com', orgName: 'Personal', plan: 'max' });
    expect(accounts[0]?.hosts.map((h) => h.host)).toEqual(['cedar', 'local']);
  });

  it('hosts with different organisations are different accounts', () => {
    const accounts = groupAccounts(input({ statuses: [status('birch', { orgId: 'org_team_a' }), status('ash', { orgId: 'org_team_b' })] }));
    expect(accounts.map((a) => a.id)).toEqual(['claude:org_team_b', 'claude:org_team_a']);
  });

  it('a host with no organisation but an e-mail groups by the lower-cased e-mail', () => {
    const accounts = groupAccounts(input({ statuses: [status('cedar', { orgId: null, email: 'Owner@X.com' }), status('birch', { orgId: null, email: 'owner@x.COM' })] }));
    expect(accounts.map((a) => a.id)).toEqual(['claude:owner@x.com']);
    expect(accounts[0]?.hosts).toHaveLength(2);
  });

  it('a signed-out or never-checked host stands alone with its host id', () => {
    const accounts = groupAccounts(input({
      statuses: [
        status('cedar'),
        status('ash', { loggedIn: false, email: null, orgId: null, orgName: null, plan: null, expiresAt: null }),
        { host: 'local', loggedIn: null, email: null, orgId: null, orgName: null, plan: null, expiresAt: null, checkedAt: null },
      ],
    }));
    expect(accounts.map((a) => a.id)).toEqual(['claude:host:ash', 'claude:org_max', 'claude:host:local']);
    expect(accounts[0]?.hosts[0]).toEqual({ host: 'ash', loggedIn: false, expiresAt: null, checkedAt: at(30), loginPending: false, canLogout: true });
  });

  it('two hosts of one account in different states: one card, each host with its own state, limits from the newest reading', () => {
    const accounts = groupAccounts(input({
      statuses: [status('cedar'), status('birch', { loggedIn: false, expiresAt: '2026-11-13T00:00:00.000Z', checkedAt: at(5), email: 'other@example.com' })],
      limits: [limits('cedar', 20, 62, 41), limits('birch', 2, 70, 45)],
      pending: ['birch'],
    }));
    expect(accounts).toHaveLength(1);
    const [account] = accounts;
    expect(account?.email).toBe('other@example.com');
    expect(account?.hosts).toEqual([
      expect.objectContaining({ host: 'birch', loggedIn: false, loginPending: true }),
      expect.objectContaining({ host: 'cedar', loggedIn: true, loginPending: false }),
    ]);
    expect(account?.limits).toEqual({
      reported: 'yes', fiveHour: { usedPct: 70, resetsAt: '2026-11-14T12:00:00.000Z' }, sevenDay: { usedPct: 45, resetsAt: '2026-11-17T05:00:00.000Z' },
      updatedAt: at(2),
    });
  });

  it('merges window by window: a newer host that sent only the weekly window keeps the older 5-hour one', () => {
    const weeklyOnly: HostLimits = { ...limits('birch', 1, 0, 50), fiveHour: null, fiveHourAt: null };
    const [account] = groupAccounts(input({ statuses: [status('cedar'), status('birch')], limits: [limits('cedar', 20, 62, 41), weeklyOnly] }));
    expect(account?.limits.fiveHour?.usedPct).toBe(62);
    expect(account?.limits.sevenDay?.usedPct).toBe(50);
  });

  it('a window whose reset time has passed is null; no reading at all is unknown', () => {
    const past: HostLimits = { ...limits('cedar', 5, 99, 41), fiveHour: { usedPct: 99, resetsAt: at(1) } };
    const [withPast] = groupAccounts(input({ statuses: [status('cedar')], limits: [past] }));
    expect(withPast?.limits).toMatchObject({ reported: 'yes', fiveHour: null, sevenDay: { usedPct: 41 } });
    const [none] = groupAccounts(input({ statuses: [status('cedar')] }));
    expect(none?.limits).toEqual({ reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null });
  });

  it('a plan that does not report limits shows no, never a zero', () => {
    const no: HostLimits = { host: 'ash', reported: 'no', fiveHour: null, sevenDay: null, fiveHourAt: null, sevenDayAt: null, updatedAt: at(1) };
    const [account] = groupAccounts(input({ statuses: [status('ash')], limits: [no] }));
    expect(account?.limits).toEqual({ reported: 'no', fiveHour: null, sevenDay: null, updatedAt: at(1) });
  });

  it("isManager only for the account with the self host, which comes first; then by the lowest host name; canLogout false for a kit-1 server", () => {
    const accounts = groupAccounts(input({
      statuses: [status('cedar', { orgId: 'org_a' }), status('ash', { orgId: 'org_b' }), status('hq', { orgId: 'org_z' }), status('birch', { orgId: 'org_a' })],
      kitOk: (host) => host !== 'ash',
    }));
    expect(accounts.map((a) => [a.id, a.isManager])).toEqual([['claude:org_z', true], ['claude:org_b', false], ['claude:org_a', false]]);
    expect(accounts[1]?.hosts[0]?.canLogout).toBe(false);
    expect(accounts[2]?.hosts.map((h) => h.host)).toEqual(['birch', 'cedar']);
  });
});
