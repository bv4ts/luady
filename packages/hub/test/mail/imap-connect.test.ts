import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { connectImap } from '../../src/mail/imap.js';
import { silentLogger } from '../helpers/fakes.js';

const clients = vi.hoisted(() => [] as EventEmitter[]);

vi.mock('imapflow', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeImapFlow extends Emitter {
    constructor() {
      super();
      clients.push(this);
    }
    async connect(): Promise<void> {}
    async getMailboxLock(): Promise<{ release(): void }> {
      return { release: () => undefined };
    }
    async logout(): Promise<void> {}
  }
  return { ImapFlow: FakeImapFlow };
});

const ACCOUNT = { host: 'imap.mail.example', port: 993, user: 'me@shop.example', password: 'pw', label: 'workmail' };

describe('connectImap', () => {
  it('logs a connection the server drops instead of crashing the hub', async () => {
    const log = silentLogger();
    const warn = vi.spyOn(log, 'warn');
    const session = await connectImap(ACCOUNT, log);
    const client = clients.at(-1);
    expect(() => client?.emit('error', new Error('read ECONNRESET'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith({ err: 'read ECONNRESET', mailbox: 'workmail' }, 'imap: connection error');
    await session.close();
  });
});
