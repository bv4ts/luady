import { describe, expect, it } from 'vitest';
import { orderByQuestionAge } from '../src/needs.js';
import { buildSnapshot } from '../src/snapshot.js';
import { CLASSIC_ROOMS } from './rooms-fixture.js';
import { ALL_SERVERS, MINUTE, NOW, ago, luadyStatus, question, session } from './fixtures.js';

describe('orderByQuestionAge', () => {
  it('puts the oldest question first and unknown ones last, ties by id', () => {
    const order = orderByQuestionAge(
      [{ id: 'c', qid: null }, { id: 'b', qid: 'BBBBBBBB' }, { id: 'a', qid: 'AAAAAAAA' }, { id: 'd', qid: 'DDDDDDDD' }],
      [question('AAAAAAAA', 'a', ago(2 * MINUTE)), question('BBBBBBBB', 'b', ago(5 * MINUTE))],
    );
    expect(order).toEqual(['b', 'a', 'c', 'd']);
  });

  it('treats an unreadable createdAt as missing', () => {
    const order = orderByQuestionAge(
      [{ id: 'a', qid: 'AAAAAAAA' }, { id: 'b', qid: 'BBBBBBBB' }],
      [question('AAAAAAAA', 'a', 'yesterday-ish'), question('BBBBBBBB', 'b', ago(MINUTE))],
    );
    expect(order).toEqual(['b', 'a']);
  });

  it('falls back to a readable pending question of the session when its own one is unreadable', () => {
    const order = orderByQuestionAge(
      [{ id: 'a', qid: 'AAAAAAAA' }, { id: 'b', qid: 'BBBBBBBB' }],
      [question('AAAAAAAA', 'a', 'garbage'), question('AAAAAAA2', 'a', ago(9 * MINUTE)), question('BBBBBBBB', 'b', ago(MINUTE))],
    );
    expect(order).toEqual(['a', 'b']);
  });

  it('lets the oldest of several pending questions decide', () => {
    const order = orderByQuestionAge(
      [{ id: 'a', qid: 'AAAAAAA2' }, { id: 'b', qid: 'BBBBBBBB' }],
      [
        question('AAAAAAA2', 'a', ago(1 * MINUTE)),
        question('BBBBBBBB', 'b', ago(10 * MINUTE)),
        question('AAAAAAA1', 'a', ago(20 * MINUTE)),
        question('AAAAAAA3', 'a', ago(30 * MINUTE), { state: 'answered' }),
      ],
    );
    expect(order).toEqual(['a', 'b']);
  });

  it('ignores answered questions of a session that has no matching pending one', () => {
    const order = orderByQuestionAge(
      [{ id: 'a', qid: null }, { id: 'b', qid: 'BBBBBBBB' }],
      [question('AAAAAAAA', 'a', ago(30 * MINUTE), { state: 'answered' }), question('BBBBBBBB', 'b', ago(MINUTE))],
    );
    expect(order).toEqual(['b', 'a']);
  });

  it('returns a frozen list', () => {
    expect(Object.isFrozen(orderByQuestionAge([], []))).toBe(true);
  });
});

describe('needs in the snapshot', () => {
  it('follows the oldest pending question of each waiting session', () => {
    const snap = buildSnapshot({
      servers: ALL_SERVERS, rooms: CLASSIC_ROOMS, luady: luadyStatus(), now: NOW, previousSeats: {},
      sessions: [
        session('birch:a', { state: 'waiting_question', pendingQid: 'AAAAAAA2' }),
        session('cedar:b', { state: 'waiting_permission', pendingQid: 'BBBBBBBB' }),
        session('ash:c', { state: 'waiting_question', pendingQid: 'CCCCCCCC' }),
      ],
      questions: [
        question('AAAAAAA2', 'birch:a', ago(MINUTE)), question('AAAAAAA1', 'birch:a', ago(20 * MINUTE)),
        question('BBBBBBBB', 'cedar:b', 'not a time'), question('CCCCCCCC', 'ash:c', ago(10 * MINUTE)),
      ],
    });
    expect(snap.needs).toEqual(['birch:a', 'ash:c', 'cedar:b']);
  });
});
