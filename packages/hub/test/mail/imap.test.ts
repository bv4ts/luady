import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { createImapService, type ImapMessage, type ImapSession } from '../../src/mail/imap.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const ACCOUNT = { host: 'imap.mail.example', port: 993, user: 'me@shop.example', password: 'pw', label: 'workmail' };

function message(uid: number, over: Partial<ImapMessage> = {}): ImapMessage {
  return { uid, from: 'Sara K', subject: `Quote ${uid}`, date: '2026-10-10T08:00:00.000Z', bulk: false, ...over };
}

function setup(inbox: () => ImapMessage[]) {
  const outbound = createFakeOutbound();
  const closed = vi.fn(async () => undefined);
  const session: ImapSession = {
    unseen: async () => inbox(),
    search: async () => [message(7)],
    source: async (uid) => (uid === 7 ? Buffer.from('From: Sara <sara@x.example>\r\nSubject: Quote 7\r\n\r\nPlease send the quote.\r\n') : null),
    close: closed,
  };
  const settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' as const } };
  const imap = createImapService({
    db: openMemoryDb(), clock: createFakeClock('2026-10-10T08:00:00.000Z'), log: silentLogger(), outbound,
    settings: { get: () => settings, update: vi.fn() }, account: ACCOUNT, connect: async () => session,
  });
  return { imap, outbound, closed };
}

describe('imap mailbox', () => {
  it('primes silently, then alerts new personal mail but not newsletters, closing the connection each time', async () => {
    let inbox = [message(1)];
    const t = setup(() => inbox);
    await t.imap.tick();
    expect(t.outbound.sent).toEqual([]);
    inbox = [message(1), message(2), message(3, { bulk: true, from: 'Newsletter' })];
    await t.imap.tick();
    expect(t.outbound.sent.map((m) => m.text)).toEqual(['📧 *Sara K* · workmail\n*Quote 2*']);
    await t.imap.tick();
    expect(t.outbound.sent).toHaveLength(1);
    expect(t.closed).toHaveBeenCalledTimes(3);
  });

  it('searches and reads with imap: ids', async () => {
    const t = setup(() => []);
    expect(await t.imap.search('quote', 5)).toEqual(['- [workmail] imap:7 · 2026-10-10 08:00 · Sara K · Quote 7']);
    expect(await t.imap.read('imap:7')).toContain('Please send the quote.');
    await expect(t.imap.read('imap:8')).rejects.toThrow(/No email imap:8/);
  });

  it('searches with Gmail syntax, retries a phrase on its longest word, newest first', async () => {
    const calls: unknown[] = [];
    const session: ImapSession = {
      unseen: async () => [],
      search: async (query) => {
        calls.push(query);
        return query.text === 'pictures' ? [message(3), message(5)] : [];
      },
      source: async () => null,
      close: async () => undefined,
    };
    const imap = createImapService({
      db: openMemoryDb(), clock: createFakeClock('2026-10-10T08:00:00.000Z'), log: silentLogger(), outbound: createFakeOutbound(),
      settings: { get: () => DEFAULT_SETTINGS, update: vi.fn() }, account: ACCOUNT, connect: async () => session,
    });
    const lines = await imap.search('Team pictures newer_than:1d', 5);
    expect(lines.map((l) => l.split(' · ')[0])).toEqual(['- [workmail] imap:5', '- [workmail] imap:3']);
    expect(calls).toEqual([
      { text: 'Team pictures', since: new Date('2026-10-09T08:00:00.000Z') },
      { text: 'pictures', since: new Date('2026-10-09T08:00:00.000Z') },
    ]);
  });
});
