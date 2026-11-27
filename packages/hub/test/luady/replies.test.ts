import { describe, expect, it, vi } from 'vitest';
import { promptHash, type ChatMessageDTO } from '@luady/shared';
import type { Db, MemoryService } from '../../src/core/contracts.js';
import { createBus } from '../../src/core/bus.js';
import { newId } from '../../src/core/ids.js';
import { MORNING_BRIEF_PREFIX } from '../../src/daily/jobs.js';
import { openMemoryDb } from '../../src/db/open.js';
import {
  STALE_TURN_MS, createReplyRouter, isMorningBrief, isNoUpdate, strongerSource, type PromptEvent, type StopEvent,
} from '../../src/luady/replies.js';
import { createOwnerRequests, type OwnerRequests } from '../../src/luady/owner-requests.js';
import type { PostInput } from '../../src/notices/router.js';
import { createFakeClock, silentLogger } from '../../test/helpers/fakes.js';

const INJECTED = '[Chat · Fri 16:00] what is birch doing?';
const BRIEF = `[Scheduled · Sat 08:00] ${MORNING_BRIEF_PREFIX}2026-11-14: read brief/2026-11-14.md and send the owner a short good-morning brief`;
const EVENT = '[Event · Fri 16:00] Action A7 approved and done: stop cedar · meadow-hr';

function fakeMemory(db: Db): MemoryService {
  return {
    record: (msg) => {
      const dto: ChatMessageDTO = {
        id: newId(), thread: msg.thread, role: msg.role, channel: msg.channel, text: msg.text, ts: '2026-10-09T12:00:05.000Z',
      };
      db.prepare('INSERT INTO messages (id, thread, role, channel, text, ts, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(dto.id, dto.thread, dto.role, dto.channel, dto.text, dto.ts, msg.extId ?? null);
      return dto;
    },
    search: () => [],
  };
}

function base(id: string, ts: string) {
  return {
    v: 1 as const, id, ts, host: 'hq', session_id: 'c-1', cwd: '/home/luady/brain', transcript_path: null,
    tmux: 'manager:0.0', permission_mode: 'dontAsk',
  };
}

function prompt(text: string, ts: string): PromptEvent {
  return { ...base(`prompt-${ts}`, ts), event: 'prompt', data: { prompt_sha256: promptHash(text), prompt_preview: text } };
}

function stop(id: string, message: string): StopEvent {
  return { ...base(id, '2026-10-09T12:00:05Z'), event: 'stop', data: { last_assistant_message: message, truncated: false } };
}

function setup(lastChannel: string | null = 'test-channel', opts: { capable?: boolean; call?: boolean; ownerRequests?: OwnerRequests } = {}) {
  const db = openMemoryDb();
  db.prepare('UPDATE manager_state SET last_input_channel = ? WHERE id = 1').run(lastChannel);
  const bus = createBus();
  const emitted: ChatMessageDTO[] = [];
  bus.on('manager.message', (message) => {
    emitted.push(message);
  });
  const posts: PostInput[] = [];
  const notices = {
    post: vi.fn(async (input: PostInput) => {
      posts.push(input);
      return { notice: null, msgId: null };
    }),
    capable: () => opts.capable ?? true,
  };
  const spoken: string[] = [];
  const phone = {
    say: (text: string): boolean => {
      if (opts.call !== true) return false;
      spoken.push(text);
      return true;
    },
  };
  const router = createReplyRouter({
    db, bus, clock: createFakeClock('2026-10-09T12:00:05.000Z'), log: silentLogger(), memory: fakeMemory(db), notices, phone,
    ...(opts.ownerRequests === undefined ? {} : { ownerRequests: opts.ownerRequests }),
  });
  const inject = (text: string, at: string, channel = 'test-channel'): void => {
    db.prepare('INSERT INTO injections (session_id, text_sha256, channel, created_at) VALUES (?, ?, ?, ?)')
      .run('hq:manager:0.0', promptHash(text), channel, at);
  };
  const rows = () => db.prepare("SELECT role, channel, text, ext_id FROM messages WHERE thread = 'manager'").all();
  const routed = (): string[][] => posts.map((p) => [p.kind, p.source, p.text]);
  /** One whole turn: the injection, its prompt, and the stop with `reply`. */
  const turn = async (text: string, channel: string, stopId: string, reply: string): Promise<void> => {
    inject(text, '2026-10-09T12:00:00.000Z', channel);
    router.onPrompt(prompt(text, '2026-10-09T12:00:01Z'));
    await router.onStop(stop(stopId, reply), false);
  };
  return { db, posts, routed, router, emitted, inject, rows, spoken, turn };
}

describe('createReplyRouter', () => {
  it('posts the reply to a chat turn as a chat reply and records it', async () => {
    const t = setup();
    await t.turn(INJECTED, 'test-channel', 'stop-0001', ' Hi Alex, birch is idle. ');
    expect(t.rows()).toEqual([{ role: 'manager', channel: 'test-channel', text: 'Hi Alex, birch is idle.', ext_id: 'stop-0001' }]);
    expect(t.emitted).toHaveLength(1);
    expect(t.posts).toEqual([{ kind: 'reply', source: 'chat', text: 'Hi Alex, birch is idle.', ref: { kind: 'manager', id: t.emitted[0]?.id } }]);
  });

  it('matches an injection within 15 s even when the hash differs', async () => {
    const t = setup();
    t.inject('[Chat · Fri 16:00] a pasted multi-line message', '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt('[Pasted text #1 +3 lines]', '2026-10-09T12:00:10Z'));
    await t.router.onStop(stop('stop-0002', 'Done.'), false);
    expect(t.routed()).toEqual([['reply', 'chat', 'Done.']]);
  });

  it('keeps Remote Control turns on the website only', async () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T11:00:00.000Z');
    t.router.onPrompt(prompt('typed in the Claude app', '2026-10-09T12:00:01Z'));
    await t.router.onStop(stop('stop-0003', 'Sure.'), false);
    expect(t.posts).toEqual([]);
    expect(t.emitted.map((m) => m.channel)).toEqual(['remote_control']);
  });

  it('a website turn is a website reply even when the last input channel says the chat', async () => {
    const t = setup('test-channel');
    await t.turn('[Web · Fri 16:00] what is birch doing?', 'web', 'stop-0004', 'Answered on the web.');
    expect(t.routed()).toEqual([['reply', 'web', 'Answered on the web.']]);
    expect(t.emitted.map((m) => m.channel)).toEqual(['web']);
  });

  it('sends one message per turn: a tool that already told the owner keeps the closing reply on the website', async () => {
    const t = setup();
    t.router.markOwnerTold(); // outside a turn: ignored
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    t.router.markOwnerTold();
    await t.router.onStop(stop('stop-0020', "I've told the owner birch is idle."), false);
    expect(t.posts).toEqual([]);
    expect(t.rows()).toEqual([{ role: 'manager', channel: 'test-channel', text: "I've told the owner birch is idle.", ext_id: 'stop-0020' }]);
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:02Z'));
    await t.router.onStop(stop('stop-0021', 'birch is idle.'), false);
    expect(t.routed()).toEqual([['reply', 'chat', 'birch is idle.']]);
  });

  it('posts the reply to a Scheduled turn as a result, but not NO_UPDATE; both are recorded as scheduled', async () => {
    const t = setup();
    const task = '[Scheduled · Fri 16:00] Follow up on the Orchard bug batch';
    await t.turn(task, 'scheduled', 'stop-0010', 'Orchard: issues 1–3 fixed, 4–5 in progress.');
    t.router.onPrompt(prompt(task, '2026-10-09T12:00:02Z'));
    await t.router.onStop(stop('stop-0011', 'NO_UPDATE'), false);
    expect(t.routed()).toEqual([['result', 'hub', 'Orchard: issues 1–3 fixed, 4–5 in progress.']]);
    expect(t.emitted.map((m) => m.channel)).toEqual(['scheduled', 'scheduled']);
  });

  it('recognises NO_UPDATE with light formatting only', () => {
    expect(['NO_UPDATE', ' NO_UPDATE. ', '**NO_UPDATE**'].every(isNoUpdate)).toBe(true);
    expect(['NO_UPDATE but issue 2 failed', 'no update'].some(isNoUpdate)).toBe(false);
  });

  it('posts the reply to an Event turn as a result, but not NO_UPDATE', async () => {
    const t = setup();
    const event = '[Event · Fri 16:00] Your mission ash · harbor-new-home finished a turn after 596s. Its reply: a@x.com / pw';
    await t.turn(event, 'event', 'stop-0009', 'Your fresh Harbor account: a@x.com / pw');
    t.router.onPrompt(prompt(event, '2026-10-09T12:00:02Z'));
    await t.router.onStop(stop('stop-0019', 'NO_UPDATE'), false);
    expect(t.routed()).toEqual([['result', 'hub', 'Your fresh Harbor account: a@x.com / pw']]);
    expect(t.emitted.map((m) => m.channel)).toEqual(['event', 'event']);
  });

  it("before any new website client said hello, an Event reply follows the owner's last channel", async () => {
    const web = setup('web', { capable: false });
    await web.turn(EVENT, 'event', 'stop-0030', 'Stopped meadow-hr.');
    expect(web.routed()).toEqual([['result', 'web', 'Stopped meadow-hr.']]);
    const chat = setup('test-channel', { capable: false });
    await chat.turn(EVENT, 'event', 'stop-0031', 'Stopped meadow-hr.');
    expect(chat.routed()).toEqual([['result', 'hub', 'Stopped meadow-hr.']]);
    const call = setup('phone', { capable: false, call: true });
    await call.turn(EVENT, 'event', 'stop-0032', 'Stopped meadow-hr.');
    expect(call.spoken).toEqual(['Stopped meadow-hr.']);
    expect(call.posts).toEqual([]);
  });

  it('the morning brief is a morning notice, alone (even before any hello) or in the middle of a website turn', async () => {
    const alone = setup('web', { capable: false });
    await alone.turn(BRIEF, 'scheduled', 'stop-0040', 'Good morning! 2 meetings today.');
    expect(alone.routed()).toEqual([['morning', 'hub', 'Good morning! 2 meetings today.']]);
    const mixed = setup('web');
    const web = '[Web · Sat 07:59] what is on today?';
    mixed.inject(web, '2026-10-09T12:00:00.000Z', 'web');
    mixed.router.onPrompt(prompt(web, '2026-10-09T12:00:01Z'));
    mixed.inject(BRIEF, '2026-10-09T12:00:02.000Z', 'scheduled');
    mixed.router.onPrompt(prompt(BRIEF, '2026-10-09T12:00:03Z'));
    await mixed.router.onStop(stop('stop-0041', 'Good morning! Today: 2 meetings.'), false);
    expect(mixed.routed()).toEqual([['morning', 'web', 'Good morning! Today: 2 meetings.']]);
    expect(mixed.emitted.map((m) => m.channel)).toEqual(['web']);
    mixed.router.onPrompt(prompt(web, '2026-10-09T12:00:04Z'));
    await mixed.router.onStop(stop('stop-0042', 'Next turn.'), false);
    expect(mixed.routed().at(-1)).toEqual(['reply', 'web', 'Next turn.']);
  });

  it('7:58 AM notify_user in a chat turn, 8:00 AM the brief joins it: the closing reply is the morning message, not dropped', async () => {
    const t = setup('test-channel');
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    t.router.markOwnerTold(); // "checking the server" went out before the brief arrived
    t.inject(BRIEF, '2026-10-09T12:00:02.000Z', 'scheduled');
    t.router.onPrompt(prompt(BRIEF, '2026-10-09T12:00:03Z'));
    await t.router.onStop(stop('stop-0060', 'Good morning! birch is fine. 2 meetings today.'), false);
    expect(t.routed()).toEqual([['morning', 'chat', 'Good morning! birch is fine. 2 meetings today.']]);
  });

  it('when Luady already sent the brief with a tool during the morning turn, the closing reply stays on the website', async () => {
    const t = setup('web');
    t.inject(BRIEF, '2026-10-09T12:00:00.000Z', 'scheduled');
    t.router.onPrompt(prompt(BRIEF, '2026-10-09T12:00:01Z'));
    t.router.markOwnerTold(); // notify_user during the morning turn is the morning message (kind morning)
    await t.router.onStop(stop('stop-0061', 'Brief sent.'), false);
    expect(t.posts).toEqual([]);
  });

  it('morningTurn is true only while the morning brief turn runs', async () => {
    const t = setup('web');
    expect(t.router.morningTurn()).toBe(false);
    t.inject(BRIEF, '2026-10-09T12:00:00.000Z', 'scheduled');
    t.router.onPrompt(prompt(BRIEF, '2026-10-09T12:00:01Z'));
    expect(t.router.morningTurn()).toBe(true);
    await t.router.onStop(stop('stop-0050', 'Good morning!'), false);
    expect(t.router.morningTurn()).toBe(false);
    t.router.onPrompt(prompt('[Scheduled · Sat 09:00] Check the build', '2026-10-09T12:01:01Z'));
    expect(t.router.morningTurn()).toBe(false);
  });

  it('a phone turn is spoken on a live call and not posted; without a call it goes back as a chat reply', async () => {
    const phoneTurn = '[Phone · Fri 16:00] status?';
    const live = setup('phone', { call: true });
    await live.turn(phoneTurn, 'phone', 'stop-0050', 'All quiet.');
    expect(live.spoken).toEqual(['All quiet.']);
    expect(live.posts).toEqual([]);
    const ended = setup('phone');
    await ended.turn(phoneTurn, 'phone', 'stop-0051', 'All quiet.');
    expect(ended.routed()).toEqual([['reply', 'chat', 'All quiet.']]);
    expect(ended.emitted.map((m) => m.channel)).toEqual(['phone']);
  });

  it("an owner's own message, or an Event the owner's website request marked, makes the turn the owner's until it ends", async () => {
    const marks = createOwnerRequests(createFakeClock('2026-10-09T12:00:00.000Z'));
    const t = setup('test-channel', { ownerRequests: marks });
    const run = '[Event · Fri 16:00] Run from the board (run r_1): the owner sent 1 card to work.';
    expect(t.router.ownerTurn()).toBe(false);
    t.inject(run, '2026-10-09T12:00:00.000Z', 'event');
    t.router.onPrompt(prompt(run, '2026-10-09T12:00:01Z'));
    expect(t.router.ownerTurn()).toBe(false);
    await t.router.onStop(stop('stop-0101', 'NO_UPDATE'), false);
    marks.mark(promptHash(run));
    t.router.onPrompt(prompt(run, '2026-10-09T12:00:02Z'));
    expect(t.router.turnSource()).toBe('event');
    expect(t.router.ownerTurn()).toBe(true);
    await t.router.onStop(stop('stop-0102', 'NO_UPDATE'), false);
    expect(t.routed()).toEqual([]);
    expect(t.router.ownerTurn()).toBe(false);
    t.router.onPrompt(prompt(run, '2026-10-09T12:00:03Z'));
    expect(t.router.ownerTurn()).toBe(false);
    await t.router.onStop(stop('stop-0103', 'NO_UPDATE'), false);
    t.inject(INJECTED, '2026-10-09T12:00:04.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:05Z'));
    expect(t.router.ownerTurn()).toBe(true);
    t.router.onTurnFailed();
    expect(t.router.ownerTurn()).toBe(false);
  });

  it('a turn rebuilt from replayed history (the hub restarted mid-turn) is never the owner\'s, and no live prompt joins it', () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'), true);
    expect(t.router.turnSource()).toBe('test-channel');
    expect(t.router.ownerTurn()).toBe(false);
    t.inject(EVENT, '2026-10-09T12:05:00.000Z', 'event');
    t.router.onPrompt(prompt(EVENT, '2026-10-09T12:05:01Z'));
    expect(t.router.turnSource()).toBe('event');
    expect(t.router.ownerTurn()).toBe(false);
  });

  it('a prompt joining a turn silent for more than STALE_TURN_MS (one the owner may have interrupted) gets no standing from it', () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    expect(t.router.ownerTurn()).toBe(true);
    const later = new Date(Date.parse('2026-10-09T12:00:01Z') + STALE_TURN_MS + 1_000).toISOString();
    t.inject(EVENT, later, 'event');
    t.router.onPrompt(prompt(EVENT, later));
    expect(t.router.ownerTurn()).toBe(false);
    // The reply still goes where the owner's message asked it to.
    expect(t.router.turnSource()).toBe('test-channel');
    // A message of the owner's own then makes the turn theirs again.
    const again = new Date(Date.parse(later) + 2_000).toISOString();
    t.inject(INJECTED, again);
    t.router.onPrompt(prompt(INJECTED, again));
    expect(t.router.ownerTurn()).toBe(true);
  });

  it('a prompt joining a turn that is still fresh keeps its standing, as before', () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    t.inject(EVENT, '2026-10-09T12:01:00.000Z', 'event');
    t.router.onPrompt(prompt(EVENT, '2026-10-09T12:01:01Z'));
    expect(t.router.ownerTurn()).toBe(true);
  });

  it('a scheduled or server Event, a Remote Control prompt and no turn at all are never the owner\'s', () => {
    const t = setup('test-channel', { ownerRequests: createOwnerRequests(createFakeClock('2026-10-09T12:00:00.000Z')) });
    t.inject(EVENT, '2026-10-09T12:00:00.000Z', 'event');
    t.router.onPrompt(prompt(EVENT, '2026-10-09T12:00:01Z'));
    expect(t.router.ownerTurn()).toBe(false);
    t.router.onTurnFailed();
    t.inject(BRIEF, '2026-10-09T12:00:02.000Z', 'scheduled');
    t.router.onPrompt(prompt(BRIEF, '2026-10-09T12:00:03Z'));
    expect(t.router.ownerTurn()).toBe(false);
    t.router.onTurnFailed();
    t.router.onPrompt(prompt('typed in the Claude app', '2026-10-09T12:10:00Z'));
    expect(t.router.ownerTurn()).toBe(false);
  });

  it('shows typing only for owner turns, since Event and Scheduled turns often end in NO_UPDATE', () => {
    const t = setup();
    expect(t.router.turnSource()).toBeNull();
    t.inject(EVENT, '2026-10-09T12:00:00.000Z', 'event');
    t.router.onPrompt(prompt(EVENT, '2026-10-09T12:00:01Z'));
    expect(t.router.currentChannel()).toBe('event');
    t.inject(INJECTED, '2026-10-09T12:00:02.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:03Z'));
    expect(t.router.currentChannel()).toBe('test-channel');
    expect(t.router.turnSource()).toBe('test-channel');
  });

  it('records replayed replies without posting them', async () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    await t.router.onStop(stop('stop-0005', 'Old reply'), true);
    expect(t.posts).toEqual([]);
    expect(t.rows()).toHaveLength(1);
  });

  it('ignores empty replies and duplicate stop events', async () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    await t.router.onStop(stop('stop-0006', '   '), false);
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:02Z'));
    await t.router.onStop(stop('stop-0007', 'Once'), false);
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:03Z'));
    await t.router.onStop(stop('stop-0007', 'Once'), false);
    expect(t.rows()).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  it('reports busy between a prompt and its stop or failure', async () => {
    const t = setup();
    expect(t.router.busy()).toBe(false);
    t.router.onPrompt(prompt('x', '2026-10-09T12:00:01Z'));
    expect(t.router.busy()).toBe(true);
    await t.router.onStop(stop('stop-0008', 'y'), false);
    expect(t.router.busy()).toBe(false);
    t.router.onPrompt(prompt('z', '2026-10-09T12:00:02Z'));
    t.router.onTurnFailed();
    expect(t.router.busy()).toBe(false);
    expect(t.router.turnSource()).toBeNull();
  });

  it('keeps the owner as the reply target when an Event is queued into the same turn', async () => {
    const t = setup();
    t.inject(INJECTED, '2026-10-09T12:00:00.000Z');
    t.router.onPrompt(prompt(INJECTED, '2026-10-09T12:00:01Z'));
    const event = '[Event · Fri 16:00] Action A31 approved and done: run on ash';
    t.inject(event, '2026-10-09T12:00:02.000Z', 'event');
    t.router.onPrompt(prompt(event, '2026-10-09T12:00:03Z'));
    await t.router.onStop(stop('stop-0020', 'ash cleanup plan: 14 GB of old temp files.'), false);
    expect(t.routed()).toEqual([['reply', 'chat', 'ash cleanup plan: 14 GB of old temp files.']]);
    expect(strongerSource('event', 'test-channel', true)).toBe('test-channel');
    expect(strongerSource('test-channel', 'event', false)).toBe('event');
  });

  it('recognises the morning brief prompt only', () => {
    expect(isMorningBrief(BRIEF)).toBe(true);
    expect(isMorningBrief('[Scheduled · Sat 03:30] Nightly digest for 2026-11-14: read digest/2026-11-14.md')).toBe(false);
    expect(isMorningBrief(`[Web · Sat 08:00] ${MORNING_BRIEF_PREFIX}today please`)).toBe(false);
  });
});
