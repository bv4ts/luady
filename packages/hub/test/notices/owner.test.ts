import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Channel, type PresenceDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { ownerChannels } from '../../src/notices/owner.js';
import { createNoticeRouter } from '../../src/notices/router.js';
import { sampleQuestion } from '../web/helpers.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

const THREE_PM = '2026-11-14T11:00:00.000Z'; // 3:00 PM in owner time

function setup() {
  const clock = createFakeClock(THREE_PM);
  const chat = createFakeChat();
  const presence = {
    state: (): PresenceDTO => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }), forced: () => false, capable: () => true,
  };
  const router = createNoticeRouter({ state: { webTabHello: () => true, setWebTabHello: () => undefined },
    db: openMemoryDb(), bus: createBus(), clock, log: silentLogger(), chat, presence, settings: { get: () => DEFAULT_SETTINGS },
  });
  let turn: Channel | null = null;
  const toOwner = ownerChannels({ router, chat, questions: { get: (qid) => sampleQuestion({ qid }) }, turnSource: () => turn });
  return {
    clock, chat, router, toOwner,
    setTurn: (next: Channel | null) => {
      turn = next;
    },
  };
}

describe('time-critical notices are never held', () => {
  it('2:48 PM with a tab visible: the "In 12 min" reminder reaches the chat at once and shows on the website too', async () => {
    const t = setup();
    t.clock.set('2026-11-14T10:48:00.000Z');
    const reminders = t.toOwner({ kind: 'meeting', source: 'hub', urgent: true });
    await expect(reminders.send('📅 *In 12 min* · 3:00 PM · work\n*Client call*', null)).resolves.toBe('fake-wa-1');
    expect(t.router.list()[0]).toMatchObject({ kind: 'meeting', chatSentAt: '2026-11-14T10:48:00.000Z', settledVia: 'test-channel' });
  });

  it('1:00 AM in quiet hours with a tab visible: "Luady is signed out" goes at once, not at 8:00 AM', async () => {
    const t = setup();
    t.clock.set('2026-11-13T21:00:00.000Z'); // 1:00 AM in owner time
    const signIn = t.toOwner({ kind: 'system', source: 'hub', urgent: true });
    await expect(signIn.send('🔴 Luady is signed out of Claude. Send /login to sign in again.', null)).resolves.toBe('fake-wa-1');
    expect(t.chat.sent).toHaveLength(1);
  });

  it('anything the caller marks urgent (notify_user urgent) goes at once; the same channel without it waits', async () => {
    const t = setup();
    const tools = t.toOwner({ kind: 'result', source: 'hub' });
    await expect(tools.deliver?.('Server cedar is down!', null, { urgent: true })).resolves.toEqual({ msgId: 'fake-wa-1', held: false });
    await expect(tools.deliver?.('Build is green.', null)).resolves.toEqual({ msgId: null, held: true });
    expect(t.chat.sent.map((s) => s.text)).toEqual(['Server cedar is down!']);
  });
});

describe('what Luady triggers while answering a chat message goes to the chat at once', () => {
  it('3:00 PM "is it done? close it" on the chat with a tab visible: mission done and the PIN request leave at once', async () => {
    const t = setup();
    const results = t.toOwner({ kind: 'result', source: 'hub' });
    const notify = t.toOwner({ kind: 'alert', source: 'hub' });
    const status = t.toOwner({ kind: 'result', source: 'hub', awayOnly: true });
    t.setTurn('test-channel');
    t.clock.advance(30_000);
    await expect(results.send('✅ *Mission done · cedar · meadow-hr*', { kind: 'session', refId: 'cedar:cc-meadow-hr:0.0' })).resolves.toBe('fake-wa-1');
    await expect(notify.send('🔐 Confirm A7 with your PIN', { kind: 'action', refId: 'A7' })).resolves.toBe('fake-wa-2');
    await expect(status.send('📌 Mission · cedar · meadow-hr', { kind: 'session', refId: 'cedar:cc-meadow-hr:0.0' })).resolves.toBe('fake-wa-3');
    expect(t.chat.sent.map((s) => s.text)).toEqual([
      '✅ *Mission done · cedar · meadow-hr*', '🔐 Confirm A7 with your PIN', '📌 Mission · cedar · meadow-hr',
    ]);
  });

  it('a phone turn counts as the chat; a website turn, an Event turn and no turn keep the facade\'s own source', async () => {
    const t = setup();
    const results = t.toOwner({ kind: 'result', source: 'hub' });
    t.setTurn('phone');
    await results.send('done during a call', null);
    for (const turn of ['web', 'event', null] as const) {
      t.setTurn(turn);
      await results.send(`done during ${String(turn)}`, null);
    }
    expect(t.chat.sent.map((s) => s.text)).toEqual(['done during a call']);
    expect(t.router.list().map((n) => [n.text, n.chatSentAt])).toEqual([
      ['done during null', null], ['done during event', null], ['done during web', null],
    ]);
  });

  it("a facade that already follows the turn (Luady's tools) keeps a website turn's source", async () => {
    const t = setup();
    let source: 'web' | 'hub' = 'web';
    const tools = t.toOwner({ kind: 'result', source: () => source });
    t.setTurn('web');
    await tools.send('from the website turn', null);
    source = 'hub';
    t.setTurn('test-channel');
    await tools.send('from the chat turn', null);
    expect(t.chat.sent.map((s) => s.text)).toEqual(['from the chat turn']);
    expect(t.router.list()[0]).toMatchObject({ text: 'from the website turn', chatDueAt: '2026-11-14T11:10:00.000Z' });
  });
});
