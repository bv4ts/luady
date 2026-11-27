import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type NoticeDTO, type PresenceDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { noticeChannel, type ChannelDefaults } from '../../src/notices/channel.js';
import { createNoticeRouter } from '../../src/notices/router.js';
import { sampleQuestion } from '../web/helpers.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

const T0 = '2026-11-14T10:00:00.000Z';

function setup(defaults: ChannelDefaults, mode: PresenceDTO['mode'] = 'here') {
  const db = openMemoryDb();
  const bus = createBus();
  const chat = createFakeChat();
  const presence = {
    state: (): PresenceDTO => ({ mode, online: mode === 'here', clients: 1, forcedUntil: null }),
    forced: () => false,
    capable: () => true,
  };
  const router = createNoticeRouter({ state: { webTabHello: () => true, setWebTabHello: () => undefined },
    db, bus, clock: createFakeClock(T0), log: silentLogger(), chat, presence, settings: { get: () => DEFAULT_SETTINGS },
  });
  const post = vi.spyOn(router, 'post');
  const created: NoticeDTO[] = [];
  bus.on('notice.created', (n) => created.push(n));
  const permission = sampleQuestion({ qid: 'PERMQID1', kind: 'permission' });
  const questions = { get: (qid: string) => (qid === 'PERMQID1' ? permission : sampleQuestion({ qid })) };
  const channel = noticeChannel({ router, chat, questions }, defaults);
  return { chat, router, post, created, channel };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('noticeChannel', () => {
  it('a plain send while the website is on becomes a notice and returns null', async () => {
    const t = setup({ kind: 'mail', source: 'hub' });
    await expect(t.channel.send('📧 2 new emails', null)).resolves.toBeNull();
    expect(t.chat.sent).toEqual([]);
    expect(t.created).toEqual([expect.objectContaining({ kind: 'mail', text: '📧 2 new emails', ref: null })]);
  });

  it('while away it goes to the chat at once and returns the chat id', async () => {
    const t = setup({ kind: 'alert', source: 'hub' }, 'chat');
    await expect(t.channel.send('⚠️ usage limit', { kind: 'session', refId: 'cedar:cc-a:0.0' })).resolves.toBe('fake-wa-1');
    expect(t.chat.sent).toEqual([{ text: '⚠️ usage limit', link: { kind: 'session', refId: 'cedar:cc-a:0.0' }, quotedId: null }]);
  });

  it('a send that quotes a chat message is a reply on the chat, whatever the presence', async () => {
    const t = setup({ kind: 'result', source: 'hub' });
    await expect(t.channel.send('done', null, 'in-7')).resolves.toBe('fake-wa-1');
    expect(t.chat.sent).toEqual([{ text: 'done', link: null, quotedId: 'in-7' }]);
    expect(t.post).toHaveBeenCalledWith(expect.objectContaining({ source: 'chat', quotedId: 'in-7' }));
    expect(t.created).toEqual([]);
  });

  it('a question link takes its kind from the stored question; an action link is a permission', async () => {
    const t = setup({ kind: 'alert', source: 'hub' });
    await t.channel.send('🔴 Which DB?', { kind: 'question', refId: 'ABCDEFGH' });
    await t.channel.send('🔴 Allow Bash?', { kind: 'question', refId: 'PERMQID1' });
    await t.channel.send('Confirm A7', { kind: 'action', refId: 'A7' });
    expect(t.created.map((n) => [n.kind, n.ref])).toEqual([
      ['question', { kind: 'question', id: 'ABCDEFGH' }],
      ['permission', { kind: 'question', id: 'PERMQID1' }],
      ['permission', { kind: 'action', id: 'A7' }],
    ]);
  });

  it('a kind given as a function is read at send time (the morning brief turn)', async () => {
    let kind: 'result' | 'morning' = 'result';
    const t = setup({ kind: () => kind, source: 'hub' });
    await t.channel.send('a result', null);
    kind = 'morning';
    await t.channel.send('Good morning!', null);
    expect(t.post.mock.calls.map(([input]) => input.kind)).toEqual(['result', 'morning']);
    expect(t.chat.sent.map((s) => s.text)).toEqual(['Good morning!']);
  });

  it('a source given as a function is read at send time', async () => {
    let source: 'web' | 'chat' = 'web';
    const t = setup({ kind: 'result', source: () => source });
    await t.channel.send('from a website turn', null);
    source = 'chat';
    await t.channel.send('from a chat turn', null);
    expect(t.post.mock.calls.map(([input]) => input.source)).toEqual(['web', 'chat']);
    expect(t.chat.sent.map((s) => s.text)).toEqual(['from a chat turn']);
  });

  it('awayOnly: nothing at all while the website is on; a plain chat send (no notice) while away', async () => {
    const here = setup({ kind: 'result', source: 'hub', awayOnly: true });
    await expect(here.channel.send('📌 Mission status', { kind: 'session', refId: 'cedar:cc-a:0.0' })).resolves.toBeNull();
    expect(here.post).not.toHaveBeenCalled();
    expect(here.chat.sent).toEqual([]);
    expect(here.created).toEqual([]);
    const away = setup({ kind: 'result', source: 'hub', awayOnly: true }, 'chat');
    await expect(away.channel.send('📌 Mission status', { kind: 'session', refId: 'cedar:cc-a:0.0' })).resolves.toBe('fake-wa-1');
    expect(away.chat.sent).toEqual([{ text: '📌 Mission status', link: { kind: 'session', refId: 'cedar:cc-a:0.0' }, quotedId: null }]);
    expect(away.created).toEqual([]);
  });

  it('everything else passes straight to the raw channel', async () => {
    const t = setup({ kind: 'result', source: 'hub' });
    const sendMedia = vi.fn(async () => 'media-1');
    const raw = Object.assign(t.chat, { sendMedia });
    const channel = noticeChannel({ router: t.router, chat: raw, questions: { get: () => undefined } }, { kind: 'result', source: 'hub' });
    expect(channel.isUp()).toBe(true);
    await expect(channel.edit?.('m1', 'new text')).resolves.toBe(true);
    channel.pin?.('m1', true, 86_400);
    channel.revoke?.('m2');
    channel.typing?.(true);
    channel.markPlayed?.('in-1');
    await expect(channel.sendMedia?.({ kind: 'image', mime: 'image/png', fileName: 'a.png', caption: '', b64: 'AA==' })).resolves.toBe('media-1');
    expect(t.chat.edits).toEqual([{ msgId: 'm1', text: 'new text' }]);
    expect(t.chat.pins).toEqual([{ msgId: 'm1', on: true }]);
    expect(t.chat.revokes).toEqual(['m2']);
    expect(t.chat.typed).toEqual([true]);
    expect(t.chat.played).toEqual(['in-1']);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(channel.sendMediaPath).toBeUndefined();
  });
});
