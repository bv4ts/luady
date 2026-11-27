import { describe, expect, it } from 'vitest';
import {
  AccountDTOSchema,
  AccountHostDTOSchema,
  AccountLimitsDTOSchema,
  AccountsDTOSchema,
  CodexLoginDTOSchema,
  ConnectionDTOSchema,
  LoginCodeBodySchema,
  LoginResultDTOSchema,
  LoginStartDTOSchema,
} from '../src/accounts.js';
import { NOT_HTTPS } from './helpers.js';

const AT = '2026-11-14T10:00:00.000Z';
const hostRow = (host: string, loggedIn: boolean | null) => ({
  host,
  loggedIn,
  expiresAt: loggedIn ? '2026-12-14T10:00:00.000Z' : null,
  checkedAt: loggedIn === null ? null : AT,
  loginPending: false,
  canLogout: true,
});
const account = {
  id: 'claude:org_1',
  provider: 'claude',
  email: 'dev@example.com',
  orgName: 'Example',
  plan: 'max',
  hosts: [hostRow('cedar', true), hostRow('hq', null)],
  limits: { reported: 'yes', fiveHour: { usedPct: 12, resetsAt: AT }, sevenDay: null, updatedAt: AT },
  isManager: true,
};
const connection = { id: 'test-channel', label: 'Test chat', state: 'connected', detail: '+44 •• •• 0001', connectUrl: null };

describe('AccountDTOSchema', () => {
  it('parses a Claude account with two hosts', () => {
    expect(AccountDTOSchema.parse(account)).toEqual(account);
  });

  it('parses the Codex account with no hosts and unknown limits', () => {
    const codex = {
      ...account,
      id: 'codex',
      provider: 'codex',
      email: null,
      orgName: null,
      plan: null,
      hosts: [],
      limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null },
      isManager: false,
    };
    expect(AccountDTOSchema.parse(codex)).toEqual(codex);
  });

  it.each([
    ['provider gemini', { provider: 'gemini' }],
    ['limits.reported maybe', { limits: { ...account.limits, reported: 'maybe' } }],
    ['an id over 200 characters', { id: 'x'.repeat(201) }],
    ['a host that is not a host id', { hosts: [hostRow('A:WS', true)] }],
    ['a missing isManager flag', { isManager: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(AccountDTOSchema.safeParse({ ...account, ...patch }).success).toBe(false);
  });

  it('AccountHostDTOSchema requires loginPending and canLogout', () => {
    const { canLogout: _c, ...withoutCanLogout } = hostRow('birch', false);
    expect(AccountHostDTOSchema.safeParse(withoutCanLogout).success).toBe(false);
  });

  it('AccountLimitsDTOSchema pins the three reported values', () => {
    expect(AccountLimitsDTOSchema.shape.reported.options).toEqual(['yes', 'no', 'unknown']);
  });
});

describe('ConnectionDTOSchema and AccountsDTOSchema', () => {
  it('parses a connection, takes an add-on id, and rejects an id outside the grammar and an unknown state', () => {
    expect(ConnectionDTOSchema.parse(connection)).toEqual(connection);
    expect(ConnectionDTOSchema.safeParse({ ...connection, id: 'test-channel' }).success).toBe(true);
    expect(ConnectionDTOSchema.safeParse({ ...connection, id: 'Slack' }).success).toBe(false);
    expect(ConnectionDTOSchema.safeParse({ ...connection, id: 'manager' }).success).toBe(false);
    expect(ConnectionDTOSchema.safeParse({ ...connection, state: 'broken' }).success).toBe(false);
  });

  it('parses an empty page and a full one', () => {
    expect(AccountsDTOSchema.parse({ accounts: [], connections: [] })).toEqual({ accounts: [], connections: [] });
    const full = { accounts: [account], connections: [connection] };
    expect(AccountsDTOSchema.parse(full)).toEqual(full);
  });
});

describe('sign-in contracts', () => {
  it('LoginStartDTOSchema parses a sign-in link and rejects a non-URL', () => {
    const start = { host: 'cedar', url: 'https://claude.ai/oauth/authorize?code=true', expiresAt: AT };
    expect(LoginStartDTOSchema.parse(start)).toEqual(start);
    expect(LoginStartDTOSchema.safeParse({ ...start, url: 'not a url' }).success).toBe(false);
  });

  it('LoginCodeBodySchema trims surrounding whitespace before it checks the length', () => {
    expect(LoginCodeBodySchema.parse({ code: `  ${'x'.repeat(1100)}\n` })).toEqual({ code: 'x'.repeat(1100) });
    expect(LoginCodeBodySchema.safeParse({ code: `   ${'x'.repeat(7)}   ` }).success).toBe(false);
  });

  it('LoginCodeBodySchema accepts 8 and 1100 characters', () => {
    expect(LoginCodeBodySchema.parse({ code: 'x'.repeat(8) })).toEqual({ code: 'x'.repeat(8) });
    expect(LoginCodeBodySchema.safeParse({ code: 'x'.repeat(1100) }).success).toBe(true);
  });

  it.each([
    ['a 7-character code', { code: 'x'.repeat(7) }],
    ['a 1101-character code', { code: 'x'.repeat(1101) }],
    ['an extra key', { code: 'x'.repeat(20), host: 'cedar' }],
    ['no code', {}],
  ])('LoginCodeBodySchema rejects %s', (_label, body) => {
    expect(LoginCodeBodySchema.safeParse(body).success).toBe(false);
  });

  it('LoginResultDTOSchema parses a result that restarted the brain', () => {
    const result = { host: 'hq', ok: true, message: 'Signed in', loggedIn: true, expiresAt: AT, brainRestarted: true };
    expect(LoginResultDTOSchema.parse(result)).toEqual(result);
    expect(LoginResultDTOSchema.safeParse({ ...result, brainRestarted: undefined }).success).toBe(false);
  });

  it('CodexLoginDTOSchema parses a device code and rejects a 33-character one', () => {
    const codex = { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', expiresAt: AT };
    expect(CodexLoginDTOSchema.parse(codex)).toEqual(codex);
    expect(CodexLoginDTOSchema.safeParse({ ...codex, code: 'x'.repeat(33) }).success).toBe(false);
  });
});

describe('sign-in and connect links are https only', () => {
  const start = { host: 'cedar', url: 'https://claude.com/cai/oauth/authorize?code=true', expiresAt: AT };
  const codex = { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', expiresAt: AT };
  const connect = { ...connection, state: 'not_connected', connectUrl: 'https://luady.example/api/google/connect?t=abc' };

  it('accepts https links and a null connect link', () => {
    expect(LoginStartDTOSchema.parse(start)).toEqual(start);
    expect(CodexLoginDTOSchema.parse(codex)).toEqual(codex);
    expect(ConnectionDTOSchema.parse(connect)).toEqual(connect);
    expect(ConnectionDTOSchema.parse({ ...connect, connectUrl: null }).connectUrl).toBeNull();
  });

  it.each(NOT_HTTPS)('rejects %s in every link field', (_label, url) => {
    expect(LoginStartDTOSchema.safeParse({ ...start, url }).success).toBe(false);
    expect(CodexLoginDTOSchema.safeParse({ ...codex, url }).success).toBe(false);
    expect(ConnectionDTOSchema.safeParse({ ...connect, connectUrl: url }).success).toBe(false);
  });
});
