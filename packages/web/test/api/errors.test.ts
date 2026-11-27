import { API_ERROR_CODES } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, errorFromResponse, userMessage } from '../../src/api/errors.js';

describe('userMessage', () => {
  it('says a paused agent must be resumed first, by code and never by message', () => {
    const err = new ApiError(409, API_ERROR_CODES.sessionPaused, 'cedar · app is paused. Resume it first.');
    expect(userMessage(err)).toBe('This agent is paused. Resume it first.');
  });

  it('says the server needs the new kit', () => {
    const err = errorFromResponse(409, { error: { code: 'kit_too_old', message: 'whatever the hub wrote' } });
    expect(userMessage(err)).toBe('This server needs the new kit before it can do that.');
  });

  it('gives the usual wording for other codes', () => {
    expect(userMessage(new ApiError(401, 'auth', 'x'))).toBe('Your session ended. Sign in again.');
    expect(userMessage(new ApiError(409, 'question_closed', 'Already answered'))).toBe('Already answered');
    expect(userMessage(new Error('boom'))).toBe('boom');
    expect(userMessage(42)).toBe('Something went wrong. Try again.');
  });
});
