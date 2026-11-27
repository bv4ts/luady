import { describe, expect, it } from 'vitest';
import { BUILTIN_CHANNELS, LIMITS, NOTICE_KINDS } from '@luady/shared';
import {
  fallbackWaitsForMorning, routeFor, settlesOnAnswer, sourceOfChannel, type RouteInput,
} from '../../src/notices/policy.js';

const FALLBACK = LIMITS.noticeFallbackMs;
const input = (over: Partial<RouteInput> = {}): RouteInput => ({ kind: 'result', source: 'hub', mode: 'here', forced: false, ...over });

describe('routeFor, row for row', () => {
  it('a reply to a chat message goes to the chat at once and is not stored', () => {
    expect(routeFor(input({ kind: 'reply', source: 'chat' }))).toEqual({ chatNow: true, fallbackMs: null, store: false });
  });

  it('the morning message always goes to the chat and is stored', () => {
    expect(routeFor(input({ kind: 'morning', source: 'web', mode: 'here' }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
  });

  it('time-critical (urgent) notices go to the chat at once and are stored, even with the website on', () => {
    expect(routeFor(input({ kind: 'meeting', source: 'hub', mode: 'here', urgent: true }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
    expect(routeFor(input({ kind: 'system', source: 'web', mode: 'here', urgent: true }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
  });

  it('"Updates: chat" sends at once', () => {
    expect(routeFor(input({ forced: true, mode: 'chat' }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
  });

  it('a reply to a website message stays on the website with the 10-minute fallback', () => {
    expect(routeFor(input({ kind: 'reply', source: 'web', mode: 'chat' }))).toEqual({ chatNow: false, fallbackMs: FALLBACK, store: true });
  });

  it('a Luady-started update while the website is on waits there first', () => {
    expect(routeFor(input({ kind: 'result', source: 'hub', mode: 'here' }))).toEqual({ chatNow: false, fallbackMs: FALLBACK, store: true });
  });

  it('a Luady-started update while the website is off goes to the chat at once', () => {
    expect(routeFor(input({ kind: 'alert', source: 'hub', mode: 'chat' }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
  });

  it('the first matching row wins', () => {
    expect(routeFor(input({ kind: 'morning', source: 'chat' }))).toEqual({ chatNow: true, fallbackMs: null, store: false });
    expect(routeFor(input({ kind: 'reply', source: 'web', forced: true }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
    expect(routeFor(input({ kind: 'question', source: 'hub', mode: 'chat' }))).toEqual({ chatNow: true, fallbackMs: null, store: true });
    expect(routeFor(input({ kind: 'question', source: 'hub', mode: 'here' }))).toEqual({ chatNow: false, fallbackMs: 600_000, store: true });
  });

  it('every kind, source, mode and force combination gives exactly one chat path: now or a fallback, never both', () => {
    for (const kind of NOTICE_KINDS) {
      for (const source of ['chat', 'web', 'hub'] as const) {
        for (const mode of ['here', 'chat'] as const) {
          for (const forced of [false, true]) {
            const route = routeFor({ kind, source, mode, forced });
            expect(route.chatNow !== (route.fallbackMs !== null)).toBe(true);
          }
        }
      }
    }
  });
});

describe('notice helpers', () => {
  it('sourceOfChannel maps a chat channel, the five built-in channels and null', () => {
    const channels = ['test-channel', ...BUILTIN_CHANNELS];
    expect(Object.fromEntries(channels.map((channel) => [channel, sourceOfChannel(channel)]))).toEqual({
      'test-channel': 'chat', phone: 'chat', web: 'web', event: 'hub', scheduled: 'hub', remote_control: 'hub',
    });
    expect(sourceOfChannel(null)).toBe('hub');
  });

  it('only questions and permissions settle on an answer and skip quiet hours', () => {
    expect(NOTICE_KINDS.filter(settlesOnAnswer)).toEqual(['question', 'permission']);
    expect(NOTICE_KINDS.filter((kind) => !fallbackWaitsForMorning(kind))).toEqual(['question', 'permission']);
  });
});
