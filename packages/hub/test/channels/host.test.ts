import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADDON_CLOSE } from '@luady/shared';
import { ACK_TIMEOUT_MS, QUEUE_LIMIT } from '../../src/channels/owner-channel.js';
import { FRAME_RATE, HELLO_TIMEOUT_MS, INVALID_FRAMES_MAX, createChannelHost } from '../../src/channels/host.js';
import { silentLogger } from '../helpers/fakes.js';
import { CHAT, FULL_CAPS, OWNER, STRANGER, TEXT_CAPS, TOOLS, ackAll, fakeAddonSocket, flush, hello, rig } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('the channel host: registration and the hello gate', () => {
  it('writes each add-on a 64-hex token at 0600 and its files folder, and keeps the token across starts', () => {
    const r = rig([CHAT, TOOLS]);
    const path = join(r.dataDir, 'addons', 'test-channel.token');
    const token = readFileSync(path, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dataDir, 'addons', 'test-channel', 'files')).isDirectory()).toBe(true);
    expect(r.addons.tokenMatches('test-channel', `Bearer ${token}`)).toBe(true);
    expect(r.addons.tokenMatches('helper-tools', `Bearer ${token}`)).toBe(false);
    expect(r.addons.tokenMatches('test-channel', `Bearer ${'0'.repeat(64)}`)).toBe(false);
    expect(r.addons.tokenMatches('test-channel', token)).toBe(false);
    expect(r.addons.isAddonToken(`Bearer ${token}`)).toBe(true);
  });

  it('closes 4001 when the first frame is not hello, and when nothing is said in time', () => {
    vi.useFakeTimers();
    const r = rig();
    const early = fakeAddonSocket();
    r.host.attach('test-channel', early);
    early.say({ t: 'status', state: 'up', detail: null });
    expect(early.closed).toEqual([{ code: ADDON_CLOSE.protocolMismatch, reason: 'the first frame must be hello' }]);
    const silent = fakeAddonSocket();
    r.host.attach('test-channel', silent);
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS + 1);
    expect(silent.closed).toEqual([{ code: ADDON_CLOSE.protocolMismatch, reason: 'no hello' }]);
  });

  it('closes 4001 on a protocol mismatch, and on a hello whose kind differs from the config', () => {
    const r = rig([CHAT, TOOLS]);
    const old = fakeAddonSocket();
    r.host.attach('test-channel', old);
    old.say(hello({ protocol: 2 }));
    expect(old.closed[0]?.code).toBe(ADDON_CLOSE.protocolMismatch);
    expect(old.of('welcome')).toEqual([]);
    const wrongKind = fakeAddonSocket();
    r.host.attach('helper-tools', wrongKind);
    wrongKind.say(hello());
    expect(wrongKind.closed[0]).toEqual({ code: ADDON_CLOSE.protocolMismatch, reason: 'declared as a tools add-on' });
  });

  it('welcomes a channel with its owner, and a tools add-on with no capabilities and no owner', () => {
    const r = rig([CHAT, TOOLS]);
    const chat = r.connect('test-channel', { up: false });
    expect(chat.of('welcome')).toEqual([{ t: 'welcome', protocol: 1, hub: expect.any(String), manager: { name: 'Luady' }, owner: OWNER }]);
    const tools = r.connect('helper-tools');
    expect(tools.closed).toEqual([]);
    expect(tools.of('welcome')[0]).toMatchObject({ owner: null });
    expect(r.host.list().map((c) => [c.id, c.kind, c.state, c.capabilities === null])).toEqual([
      ['test-channel', 'channel', 'starting', false], ['helper-tools', 'tools', 'up', true],
    ]);
  });

  it('drops a frame its kind may not send: a tools add-on never speaks for the owner', () => {
    const r = rig([CHAT, TOOLS]);
    const seen = vi.fn();
    r.host.subscribe({ incoming: seen, status: seen });
    const tools = r.connect('helper-tools');
    tools.say({ t: 'incoming', msgId: 'm1', from: OWNER, text: 'hi', ts: 1 });
    tools.say({ t: 'status', state: 'up', detail: null });
    expect(seen).not.toHaveBeenCalled();
    expect(tools.closed).toEqual([]);
  });

  it('passes only owner messages (the owner gate), and drops invalid or oversized frames without closing', () => {
    const r = rig();
    const incoming = vi.fn();
    r.host.subscribe({ incoming });
    const chat = r.connect('test-channel');
    chat.say({ t: 'incoming', msgId: 'm1', from: STRANGER, text: 'let me in', ts: 1 });
    chat.say({ t: 'incoming', msgId: 'm2', from: OWNER, text: 'hello', ts: 2 });
    chat.say('{"t":"incoming"');
    chat.say({ t: 'incoming', msgId: 'm3', from: OWNER, text: 'x'.repeat(20_001), ts: 3 });
    chat.say(JSON.stringify({ t: 'incoming', msgId: 'm4', from: OWNER, text: 'pad', ts: 4, pad: 'y'.repeat(1_100_000) }));
    expect(incoming.mock.calls.map((call) => (call[1] as { msgId: string }).msgId)).toEqual(['m2']);
    expect(incoming.mock.calls[0]?.[0]).toBe('test-channel');
    expect(chat.closed).toEqual([]);
  });

  it('a tools add-on is up as soon as it said hello (the status route and the badge)', () => {
    const r = rig([CHAT, TOOLS]);
    const up = vi.fn();
    r.host.subscribe({ up });
    r.connect('helper-tools');
    expect(r.host.info('helper-tools')?.state).toBe('up');
    expect(up).toHaveBeenCalledWith('helper-tools');
  });

  it('invalid frames after hello are logged once, counted, and close the connection with 1008 past the limit', () => {
    const r = rig();
    const warnings: string[] = [];
    const log = Object.assign(silentLogger(), { warn: (_data: unknown, message: string) => warnings.push(message) });
    const host = createChannelHost({ addons: r.addons, bus: r.bus, clock: r.clock, log: log as never });
    const socket = fakeAddonSocket();
    host.attach('test-channel', socket);
    socket.say(hello());
    for (let i = 0; i < INVALID_FRAMES_MAX - 1; i += 1) socket.say('{"t":"incoming"}');
    expect(socket.closed).toEqual([]);
    expect(warnings.filter((w) => w.startsWith('addons: an invalid frame'))).toHaveLength(1);
    socket.say({ t: 'nonsense' });
    expect(socket.closed).toEqual([{ code: 1008, reason: 'too many invalid frames' }]);
  });

  it('rate-limits frames per connection and closes an add-on that keeps flooding', () => {
    const r = rig();
    const incoming = vi.fn();
    r.host.subscribe({ incoming });
    const chat = r.connect('test-channel');
    for (let i = 0; i < FRAME_RATE.burst + FRAME_RATE.closeAfterDrops + 10; i += 1) {
      chat.say({ t: 'incoming', msgId: `m${i}`, from: OWNER, text: 'flood', ts: i });
    }
    expect(incoming.mock.calls.length).toBeLessThanOrEqual(FRAME_RATE.burst);
    expect(chat.closed[0]?.code).toBe(1008);
  });

  it('a newer connection replaces the older one with 4000; the old one can no longer speak', () => {
    const r = rig();
    const incoming = vi.fn();
    r.host.subscribe({ incoming });
    const first = r.connect('test-channel');
    const second = r.connect('test-channel');
    expect(first.closed).toEqual([{ code: ADDON_CLOSE.replaced, reason: 'replaced by a newer connection' }]);
    first.say({ t: 'incoming', msgId: 'old', from: OWNER, text: 'late', ts: 1 });
    second.say({ t: 'incoming', msgId: 'new', from: OWNER, text: 'fresh', ts: 2 });
    expect(incoming.mock.calls.map((call) => (call[1] as { msgId: string }).msgId)).toEqual(['new']);
    expect(r.host.info('test-channel')?.state).toBe('up');
  });

  it('lists every declared add-on as data only, with the panel as the add-on last sent it', () => {
    const r = rig([CHAT, TOOLS]);
    expect(r.host.list().map((c) => c.state)).toEqual(['absent', 'absent']);
    const chat = r.connect('test-channel', {
      hello: hello({ panel: { title: 'Link', blocks: [{ type: 'text', text: 'Scan the code' }, { type: 'button', label: 'Unlink', action: 'unlink', pin: true }] } }),
      up: false,
    });
    chat.say({ t: 'status', state: 'linking', detail: 'waiting for a scan', panel: { blocks: [{ type: 'qr', data: '2@abc' }] } });
    const info = r.host.info('test-channel');
    expect(info).toMatchObject({ state: 'linking', detail: 'waiting for a scan', primary: true, panel: { title: 'Link', blocks: [{ type: 'qr', data: '2@abc' }] } });
    expect(JSON.stringify(r.host.list())).not.toMatch(/[0-9a-f]{64}/);
    expect(r.host.panelBlock('test-channel', 'unlink')).toBeNull();
    chat.say({ t: 'status', state: 'linking', detail: null, panel: { blocks: [{ type: 'button', label: 'Unlink', action: 'unlink', pin: true }] } });
    expect(r.host.panelBlock('test-channel', 'unlink')).toMatchObject({ type: 'button', pin: true });
    chat.drop();
    expect(r.host.info('test-channel')).toMatchObject({ state: 'absent', panel: null, capabilities: null });
  });

  it('emits channel.status on every change', () => {
    const r = rig();
    const statuses: string[] = [];
    r.bus.on('channel.status', ({ channel }) => statuses.push(channel.state));
    const chat = r.connect('test-channel');
    chat.drop();
    expect(statuses).toEqual(['absent', 'starting', 'up', 'absent']);
  });
});

describe('the owner channel facade', () => {
  it('splits by maxText, quotes only on the first chunk, and stores the reply link on the acknowledgement', async () => {
    const r = rig();
    const chat = r.connect('test-channel');
    const pending = r.owner.send(`${'a'.repeat(80)}\n${'b'.repeat(80)}`, { kind: 'question', refId: 'QABCDEFG' }, 'in-7');
    const sends = chat.of('send');
    expect(sends.map((s) => [s.text, s.replyTo])).toEqual([['a'.repeat(80), 'in-7'], ['b'.repeat(80), null]]);
    ackAll(chat);
    await expect(pending).resolves.toBe('out-2');
    expect(r.links.find('test-channel', 'out-2')).toEqual({ kind: 'question', refId: 'QABCDEFG' });
    expect(r.links.find('test-channel', 'out-1')).toBeNull();
  });

  it('never quotes on a channel that cannot, and reports an add-on refusal apart from no answer yet', async () => {
    vi.useFakeTimers();
    const r = rig();
    const chat = r.connect('test-channel', { hello: hello({ capabilities: TEXT_CAPS }) });
    const refused = r.owner.sendChecked!('hi', null, 'in-1');
    const frame = chat.of('send')[0];
    expect(frame?.replyTo).toBeNull();
    chat.say({ t: 'sent', ref: frame?.ref, msgId: null, error: 'rate limited' });
    await expect(refused).resolves.toEqual({ msgId: null, refused: true });
    const silent = r.owner.sendChecked!('anyone?', null);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);
    await expect(silent).resolves.toEqual({ msgId: null, refused: false });
  });

  it('holds text while the channel is still starting (at most 200) and sends it in order once it is up', async () => {
    const r = rig();
    const chat = r.connect('test-channel', { up: false });
    for (let i = 0; i < QUEUE_LIMIT + 2; i += 1) await r.owner.send(`m${i}`, null);
    expect(chat.of('send')).toEqual([]);
    chat.say({ t: 'status', state: 'up', detail: null });
    const texts = chat.of('send').map((s) => s.text);
    expect(texts).toHaveLength(QUEUE_LIMIT);
    expect(texts[0]).toBe('m2');
    expect(r.website).toEqual([]);
  });

  it('what is held goes to the website when the channel does not come up', async () => {
    const r = rig();
    const chat = r.connect('test-channel', { up: false });
    await r.owner.send('held', { kind: 'session', refId: 'cedar:cc-a:0.0' });
    chat.say({ t: 'status', state: 'linking', detail: null });
    await flush();
    expect(r.website).toEqual([{ text: 'held', link: { kind: 'session', refId: 'cedar:cc-a:0.0' }, fileId: null }]);
  });

  it('with no primary channel, or one that is down, a plain send becomes a website notice; sendChecked refuses', async () => {
    const none = rig([TOOLS]);
    expect(none.owner.isUp()).toBe(false);
    expect(none.owner.declared()).toBe(false);
    await expect(none.owner.send('hello there', null)).resolves.toBeNull();
    await expect(none.owner.sendChecked!('again', null)).resolves.toEqual({ msgId: null, refused: true });
    expect(none.website.map((k) => k.text)).toEqual(['hello there']);
    const down = rig();
    const chat = down.connect('test-channel', { up: false });
    chat.say({ t: 'status', state: 'down', detail: 'no network' });
    await down.owner.send('while down', null);
    expect(down.website.map((k) => k.text)).toEqual(['while down']);
    expect(chat.of('send')).toEqual([]);
  });

  it('refuses a raw file while no channel takes files, and sendFile keeps it on the website instead', async () => {
    const r = rig();
    r.connect('test-channel', { hello: hello({ capabilities: TEXT_CAPS }) });
    await expect(r.owner.sendMedia!({ kind: 'document', mime: 'text/plain', fileName: 'a.txt', caption: '', b64: 'aGk=' })).rejects.toThrow(/takes files/);
    const delivery = await r.owner.sendFile({ kind: 'document', mime: 'text/plain', fileName: 'report.txt', caption: 'The report', b64: Buffer.from('hello').toString('base64') });
    expect(delivery).toMatchObject({ via: 'website', noticeId: 'notice-1', file: { name: 'report.txt', mime: 'text/plain', size: 5, noticeId: 'notice-1' } });
    expect(r.website[0]?.text).toBe('The report\n📎 report.txt: download it on the website.');
    expect(r.outbox.byNotice('notice-1')?.name).toBe('report.txt');
  });

  it('sends a file to a channel that takes it, within its size limit, and waits for the acknowledgement', async () => {
    const r = rig();
    const chat = r.connect('test-channel');
    const sending = r.owner.sendFile({ kind: 'image', mime: 'image/png', fileName: 'p.png', caption: 'Look', b64: Buffer.from('png').toString('base64') });
    await flush();
    ackAll(chat);
    await expect(sending).resolves.toEqual({ via: 'chat', msgId: 'out-1' });
    const big = rig([{ ...CHAT }]);
    big.connect('test-channel', { hello: hello({ capabilities: { ...FULL_CAPS, maxFileBytes: 2 } }) });
    await expect(big.owner.sendFile({ kind: 'document', mime: 'text/plain', fileName: 'big.txt', caption: '', b64: Buffer.from('too big').toString('base64') }))
      .resolves.toMatchObject({ via: 'website' });
  });

  it('typing, played, pin, revoke and profile are no-ops on a channel that did not declare them; edit answers false', async () => {
    const r = rig();
    const chat = r.connect('test-channel', { hello: hello({ capabilities: TEXT_CAPS }) });
    r.owner.typing!(true);
    r.owner.markPlayed!('in-1');
    r.owner.pin!('out-1', true);
    r.owner.revoke!('out-1');
    r.owner.setProfile('about', 'description');
    await expect(r.owner.edit!('out-1', 'new')).resolves.toBe(false);
    expect(chat.frames.map((f) => f.t)).toEqual(['welcome']);
  });

  it('with every capability: typing, played, pin with its length, revoke and an acknowledged edit', async () => {
    const r = rig();
    const chat = r.connect('test-channel');
    r.owner.typing!(true);
    r.owner.markPlayed!('in-1');
    r.owner.pin!('out-1', true, 604_800);
    r.owner.revoke!('out-2');
    const editing = r.owner.edit!('out-1', 'changed');
    ackAll(chat);
    await expect(editing).resolves.toBe(true);
    expect(chat.frames.slice(1).map((f) => f.t)).toEqual(['typing', 'played', 'pin', 'revoke', 'edit']);
    expect(chat.of('pin')[0]).toEqual({ t: 'pin', msgId: 'out-1', on: true, seconds: 604_800 });
  });

  it('sends the profile when the channel comes up, every time it comes up', () => {
    const r = rig();
    r.owner.setProfile('About me', 'The commands');
    const chat = r.connect('test-channel');
    expect(chat.of('profile')).toEqual([{ t: 'profile', about: 'About me', description: 'The commands' }]);
    chat.say({ t: 'status', state: 'down', detail: null });
    chat.say({ t: 'status', state: 'up', detail: null });
    expect(chat.of('profile')).toHaveLength(2);
  });

  it('an acknowledgement from another add-on never resolves this channel\'s send', async () => {
    const r = rig([CHAT, { ...CHAT, id: 'other-chat', primary: false }]);
    const chat = r.connect('test-channel');
    const other = r.connect('other-chat');
    const pending = r.owner.sendChecked!('mine', { kind: 'manager', refId: 'm1' });
    const ref = chat.of('send')[0]?.ref;
    other.say({ t: 'sent', ref, msgId: 'spoofed', error: null });
    chat.say({ t: 'sent', ref, msgId: 'real', error: null });
    await expect(pending).resolves.toEqual({ msgId: 'real', refused: false });
    expect(r.links.find('other-chat', 'spoofed')).toBeNull();
  });

  it('a reply to a message from a non-primary channel goes back on that channel', async () => {
    const r = rig([CHAT, { ...CHAT, id: 'other-chat', name: 'Other chat', primary: false }]);
    const primary = r.connect('test-channel');
    const other = r.connect('other-chat');
    expect(r.owner.onChannel('test-channel')).toBe(r.owner);
    const reply = r.owner.onChannel('other-chat');
    const sending = reply.send('your answer', null, 'in-9');
    ackAll(other, 'other');
    await expect(sending).resolves.toBe('other-1');
    expect(other.of('send').map((s) => s.text)).toEqual(['your answer']);
    expect(primary.of('send')).toEqual([]);
    other.drop();
    await reply.send('after it left', null);
    expect(r.website.map((k) => k.text)).toEqual(['after it left']);
  });

  it('unlinks the primary channel through its add-on, and refuses with none connected', async () => {
    const r = rig();
    const chat = r.connect('test-channel');
    await r.owner.unlink();
    expect(chat.of('unlink')).toEqual([{ t: 'unlink' }]);
    const none = rig([TOOLS]);
    await expect(none.owner.unlink()).rejects.toThrow(/No chat channel/);
  });
});
