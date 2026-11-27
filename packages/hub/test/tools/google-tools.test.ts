import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../src/core/errors.js';
import type { GoogleService } from '../../src/google/service.js';
import type { ImapService } from '../../src/mail/imap.js';
import { GOOGLE_TOOLS } from '../../src/tools/google-tools.js';
import { createFakeToolContext } from './fake-context.js';

function context(imapSearch: ImapService['search']) {
  const google = {
    accounts: () => [
      { email: 'me@gmail.com', label: 'personal', mail: true },
      { email: 'alex@harbor.example', label: 'harbor', mail: false },
    ],
    search: vi.fn(async (_q: string, account: string | undefined) => {
      if (account !== undefined && account !== 'personal') throw new NotFoundError('nope');
      return '- [personal] g1 · Fri · GitHub · PR merged';
    }),
  } as unknown as GoogleService;
  const imap = { label: 'harbor', user: 'alex@harbor.example', search: vi.fn(imapSearch) } as unknown as ImapService;
  return { ...createFakeToolContext(), google, imap };
}

describe('email_search', () => {
  it('lists every mailbox first and searches Gmail plus the IMAP mailbox', async () => {
    const ctx = context(async () => ['- [harbor] imap:9 · 2026-10-10 15:00 · Sam · Storage plan']);
    expect(await GOOGLE_TOOLS.email_search({ query: 'newer_than:7d' }, ctx)).toBe([
      'Mailboxes: personal (Gmail, me@gmail.com), harbor (alex@harbor.example, IMAP)',
      '- [personal] g1 · Fri · GitHub · PR merged',
      '- [harbor] imap:9 · 2026-10-10 15:00 · Sam · Storage plan',
    ].join('\n'));
  });

  it('routes the IMAP label, address or domain to the IMAP mailbox even when a Google account shares the label', async () => {
    const ctx = context(async () => []);
    for (const account of ['harbor', 'ALEX@harbor.example', 'harbor.example']) {
      expect(await GOOGLE_TOOLS.email_search({ query: 'quote', account }, ctx)).toContain('- [harbor] no match');
    }
    expect(ctx.google!.search).not.toHaveBeenCalled();
  });

  it('reports an unreachable IMAP mailbox instead of hiding it, and names the mailboxes on a wrong account', async () => {
    const ctx = context(async () => { throw new Error('connection timed out'); });
    expect(await GOOGLE_TOOLS.email_search({ query: 'quote' }, ctx)).toContain('- [harbor] could not be searched right now: connection timed out');
    await expect(GOOGLE_TOOLS.email_search({ query: 'quote', account: 'work' }, ctx)).rejects.toThrow(/No mailbox "work". Mailboxes: personal/);
  });
});
