import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptHash } from '@luady/shared';
import type { Clock, CtlClient, Fleet } from '../../src/core/contracts.js';
import { CtlError, RefusedError, ValidationError } from '../../src/core/errors.js';
import { checkTypedText } from '../../src/fleet/ctl-args.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createLuadyInbox, formatInjection } from '../../src/luady/inbox.js';
import { readLuadyState } from '../../src/luady/launch.js';
import { createFakeCtl, silentLogger, classicHostLookups } from '../../test/helpers/fakes.js';

const T0 = '2026-10-09T12:00:00.000Z'; // Fri 16:00 in owner time
const clock: Clock = { now: () => new Date() };

function fakeFleet(ctl: CtlClient): Fleet {
  return {
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), client: () => ctl, servers: () => [],
    openShell: vi.fn(), ...classicHostLookups(), tailEvents: vi.fn(),
  };
}

function setup(ctl = createFakeCtl()) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
  const db = openMemoryDb();
  const inbox = createLuadyInbox({ db, clock, log: silentLogger(), fleet: fakeFleet(ctl) });
  const sent = (): unknown[] => ctl.calls.filter((c) => c.method === 'send').map((c) => c.args[1]);
  return { db, ctl, inbox, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createLuadyInbox', () => {
  it('injects with the source and time prefix, stores the injection hash and the owner channel', async () => {
    const t = setup();
    await t.inbox.inject('what is birch doing?', 'test-channel', new Date(T0));
    const formatted = '[Chat · Fri 16:00] what is birch doing?';
    expect(t.ctl.calls).toEqual([{ method: 'send', args: ['manager:0.0', formatted] }]);
    expect(t.db.prepare('SELECT session_id, text_sha256, channel FROM injections').all()).toEqual([
      { session_id: 'hq:manager:0.0', text_sha256: promptHash(formatted), channel: 'test-channel' },
    ]);
    expect(readLuadyState(t.db).last_input_channel).toBe('test-channel');
  });

  it('keeps the last owner channel when injecting events and scheduled tasks', async () => {
    const t = setup();
    await t.inbox.inject('hello', 'web', new Date(T0));
    await t.inbox.inject('Action A7 done', 'event', new Date(T0));
    await t.inbox.inject('Write the digest', 'scheduled', new Date(T0));
    expect(t.sent()).toEqual(['[Web · Fri 16:00] hello', '[Event · Fri 16:00] Action A7 done', '[Scheduled · Fri 16:00] Write the digest']);
    expect(readLuadyState(t.db).last_input_channel).toBe('web');
  });

  it('refuses channels that cannot inject', () => {
    expect(() => formatInjection('remote_control', new Date(T0), 'x')).toThrow(ValidationError);
  });

  it('flushes queued messages in order, 1 s apart, numbering back-to-back owner messages on one channel', async () => {
    const t = setup();
    t.inbox.enqueue('first', 'test-channel');
    vi.setSystemTime(new Date('2026-10-09T12:05:00.000Z'));
    t.inbox.enqueue('second', 'test-channel');
    t.inbox.enqueue('third', 'web');
    t.inbox.enqueue('a reminder', 'scheduled');
    t.inbox.enqueue('another', 'scheduled');
    expect(t.inbox.queued()).toBe(5);
    const done = t.inbox.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent()).toEqual(['[Chat · Fri 16:00] 2 messages, handle every one:\n1) first\n2) second']);
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(t.sent()).toEqual([
      '[Chat · Fri 16:00] 2 messages, handle every one:\n1) first\n2) second', '[Web · Fri 16:05] third',
      '[Scheduled · Fri 16:05] a reminder', '[Scheduled · Fri 16:05] another',
    ]);
    expect(t.inbox.queued()).toBe(0);
  });

  it('marks a control character, so a message holding one (U+001B from mail or pasted colours) is typed and the queue goes on', async () => {
    const typed: string[] = [];
    const t = setup(createFakeCtl({ send: async (_target, text) => { typed.push(checkTypedText(text, 20_000, 'text')); } }));
    t.inbox.enqueue('New mail: \u001b[31mURGENT\u001b[0m invoice', 'event');
    t.inbox.enqueue('are you there?', 'web');
    const done = t.inbox.flush();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(typed).toEqual(['[Event · Fri 16:00] New mail: <U+001B>[31mURGENT<U+001B>[0m invoice', '[Web · Fri 16:00] are you there?']);
    expect(t.inbox.queued()).toBe(0);
    expect(formatInjection('web', new Date(T0), 'tab\tand\nlines stay, bell\u0007 does not')).toBe('[Web · Fri 16:00] tab\tand\nlines stay, bell<U+0007> does not');
  });

  it('drops, with a note in the log, a message the kit refuses for its text, and sends the ones after it', async () => {
    const warn = vi.fn();
    const ctl = createFakeCtl({
      send: async (_target, text) => {
        if (text.includes('bad')) throw new CtlError('usage', 'text contains the control character U+001B', 2);
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
    const inbox = createLuadyInbox({ db: openMemoryDb(), clock, log: { ...silentLogger(), warn }, fleet: fakeFleet(ctl) });
    inbox.enqueue('a bad one', 'event');
    inbox.enqueue('the owner asks', 'web');
    const done = inbox.flush();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(ctl.calls.filter((c) => c.method === 'send').map((c) => c.args[1])).toEqual(['[Event · Fri 16:00] a bad one', '[Web · Fri 16:00] the owner asks']);
    expect(inbox.queued()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ ids: [1] }), 'luady: dropped a queued message the kit would not type');
  });

  it('keeps everything queued when a send fails', async () => {
    const t = setup(createFakeCtl({ send: async () => { throw new RefusedError('pane is not running claude'); } }));
    t.inbox.enqueue('first', 'test-channel');
    t.inbox.enqueue('second', 'test-channel');
    await t.inbox.flush();
    expect(t.inbox.queued()).toBe(2);
  });
});
