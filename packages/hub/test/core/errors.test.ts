import { describe, expect, it } from 'vitest';
import {
  AuthError,
  CtlError,
  HubError,
  NotFoundError,
  PinInvalidError,
  PinLockedError,
  PinNotSetError,
  QuestionClosedError,
  QuestionPendingError,
  RefusedError,
  ValidationError,
} from '../../src/core/errors.js';

const UNTIL = '2026-10-09T12:15:00.000Z';

describe('HubError family', () => {
  it.each([
    ['NotFoundError', new NotFoundError('no such session'), 'not_found', 'no such session'],
    ['ValidationError', new ValidationError('bad input'), 'validation', 'bad input'],
    ['RefusedError', new RefusedError('pane is busy'), 'refused', 'pane is busy'],
    ['AuthError', new AuthError('setup code expired'), 'auth', 'setup code expired'],
    [
      'QuestionClosedError',
      new QuestionClosedError('answered', '#ABCDEFGH was already answered'),
      'question_closed',
      '#ABCDEFGH was already answered',
    ],
    [
      'QuestionPendingError',
      new QuestionPendingError('ABCDEFGH', 'answer #ABCDEFGH first'),
      'question_pending',
      'answer #ABCDEFGH first',
    ],
    ['PinInvalidError', new PinInvalidError(2), 'pin_invalid', 'Wrong PIN'],
    ['PinLockedError', new PinLockedError(UNTIL), 'pin_locked', `PIN locked until ${UNTIL}`],
    ['PinNotSetError', new PinNotSetError(), 'pin_not_set', 'PIN is not set'],
    ['CtlError', new CtlError('refused', 'pane is not claude', 3), 'refused', 'pane is not claude'],
  ])('%s carries its name, code and message', (name, err, code, message) => {
    expect(err).toBeInstanceOf(HubError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
  });

  it('keeps each subclass field', () => {
    expect(new QuestionClosedError('timeout', 'x').state).toBe('timeout');
    expect(new QuestionPendingError('ABCDEFGH', 'x').qid).toBe('ABCDEFGH');
    expect(new PinInvalidError(1).remaining).toBe(1);
    expect(new PinLockedError(UNTIL).until).toBe(UNTIL);
    expect(new CtlError('timeout', 'slow', 5).exitCode).toBe(5);
  });
});
