import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  CtlError,
  HubError,
  JiraNotConnectedError,
  KitTooOldError,
  NotBuiltYetError,
  NotFoundError,
  PinInvalidError,
  PinLockedError,
  PinNotSetError,
  QuestionClosedError,
  QuestionPendingError,
  RefusedError,
  SessionPausedError,
  ValidationError,
} from '../../src/core/errors.js';
import { ForbiddenError, TooManyRequestsError, mapError, PinRequiredError, RateLimitedError, registerErrorHandler } from '../../src/web/errors.js';
import { HostAccessError, HostRateError } from '../../src/hosts/errors.js';
import { silentLogger } from '../helpers/fakes.js';

describe('mapError (HTTP mapping)', () => {
  const cases: Array<[string, HubError, number, string]> = [
    ['NotFoundError', new NotFoundError('no such session'), 404, 'not_found'],
    ['ValidationError', new ValidationError('bad body'), 400, 'validation'],
    ['RefusedError', new RefusedError('busy'), 409, 'refused'],
    ['QuestionClosedError', new QuestionClosedError('answered', 'already answered'), 409, 'question_closed'],
    ['QuestionPendingError', new QuestionPendingError('ABCDEFGH', 'answer first'), 409, 'question_pending'],
    ['PinNotSetError', new PinNotSetError(), 428, 'pin_not_set'],
    ['PinRequiredError', new PinRequiredError(), 428, 'pin_required'],
    ['AuthError', new AuthError('login required'), 401, 'auth'],
    ['CtlError', new CtlError('refused', 'path is denied', 3), 502, 'refused'],
    ['RateLimitedError', new RateLimitedError('1 minute'), 429, 'rate_limited'],
    ['SessionPausedError', new SessionPausedError('x'), 409, 'session_paused'],
    ['KitTooOldError', new KitTooOldError('update the kit'), 409, 'kit_too_old'],
    ['JiraNotConnectedError', new JiraNotConnectedError(), 409, 'jira_not_connected'],
    ['NotBuiltYetError', new NotBuiltYetError(), 501, 'not_built_yet'],
  ];

  it.each(cases)('%s maps to its status with exactly {error:{code,message}}', (_name, err, status, code) => {
    expect(mapError(err)).toStrictEqual({ status, body: { error: { code, message: err.message } } });
  });

  it('PinInvalidError maps to 403 and carries remaining', () => {
    expect(mapError(new PinInvalidError(2))).toStrictEqual({
      status: 403,
      body: { error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 2 } },
    });
  });

  it('PinLockedError maps to 423 and carries until', () => {
    expect(mapError(new PinLockedError('2026-10-09T12:15:00.000Z'))).toStrictEqual({
      status: 423,
      body: {
        error: {
          code: 'pin_locked',
          message: 'PIN locked until 2026-10-09T12:15:00.000Z',
          until: '2026-10-09T12:15:00.000Z',
        },
      },
    });
  });

  it('unknown errors and unmapped HubErrors become a generic 500', () => {
    const generic = { status: 500, body: { error: { code: 'internal', message: 'Internal error' } } };
    expect(mapError(new Error('db password is hunter2'))).toEqual(generic);
    expect(mapError(new HubError('weird', 'internal detail'))).toEqual(generic);
    expect(mapError('a string')).toEqual(generic);
  });

  it('framework 4xx errors keep their status with a fixed message', () => {
    const withStatus = (statusCode: number) => Object.assign(new Error('raw framework text'), { statusCode });
    expect(mapError(withStatus(415))).toEqual({
      status: 415,
      body: { error: { code: 'unsupported_media_type', message: 'Unsupported content type' } },
    });
    expect(mapError(withStatus(413)).status).toBe(413);
    expect(mapError(withStatus(418))).toEqual({ status: 418, body: { error: { code: 'bad_request', message: 'Bad request' } } });
    expect(mapError(withStatus(503)).status).toBe(500);
  });
});

describe('registerErrorHandler', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function build() {
    const log = silentLogger();
    const errorSpy = vi.spyOn(log, 'error');
    const app = Fastify();
    apps.push(app);
    registerErrorHandler(app, log);
    app.get('/boom', async () => {
      throw new Error('secret detail');
    });
    app.get('/missing', async () => {
      throw new NotFoundError('no such thing');
    });
    app.get('/pin-invalid', async () => {
      throw new PinInvalidError(1);
    });
    app.get('/pin-locked', async () => {
      throw new PinLockedError('2026-10-09T12:15:00.000Z');
    });
    app.post('/echo', async (request) => request.body);
    await app.ready();
    return { app, errorSpy };
  }

  it('hides unknown error details from the client and logs them', async () => {
    const { app, errorSpy } = await build();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Internal error' } });
    expect(res.body).not.toContain('secret detail');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('maps HubErrors without logging them as failures', async () => {
    const { app, errorSpy } = await build();
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'no such thing' } });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('puts remaining and until on the wire for PIN errors', async () => {
    const { app } = await build();
    const invalid = await app.inject({ method: 'GET', url: '/pin-invalid' });
    expect(invalid.statusCode).toBe(403);
    expect(invalid.json()).toStrictEqual({ error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 1 } });
    const locked = await app.inject({ method: 'GET', url: '/pin-locked' });
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toStrictEqual({
      error: { code: 'pin_locked', message: 'PIN locked until 2026-10-09T12:15:00.000Z', until: '2026-10-09T12:15:00.000Z' },
    });
  });

  it('turns malformed JSON into 400 bad_request', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'bad_request', message: 'Malformed request' } });
  });
});

describe('403 and 429 for routes with their own checks', () => {
  it('maps ForbiddenError to 403 with its own code, and TooManyRequestsError to 429 with Retry-After', () => {
    expect(mapError(new ForbiddenError('grant_required', 'This step needs your grant'))).toEqual({
      status: 403, body: { error: { code: 'grant_required', message: 'This step needs your grant' } },
    });
    expect(mapError(new TooManyRequestsError(7))).toEqual({
      status: 429, body: { error: { code: 'rate_limited', message: 'Too many requests, retry in 7 seconds' } }, headers: { 'retry-after': '7' },
    });
  });

  it('the hosts errors are those classes, so the hosts routes need no wrapper of their own', () => {
    expect(new HostAccessError('pin_required', 'x')).toBeInstanceOf(ForbiddenError);
    expect(mapError(new HostRateError(3))).toMatchObject({ status: 429, headers: { 'retry-after': '3' } });
  });
});

describe('registerErrorHandler sends the mapped headers', () => {
  it('a 429 with a wait carries Retry-After', async () => {
    const app = Fastify();
    registerErrorHandler(app, silentLogger());
    app.get('/busy', async () => {
      throw new TooManyRequestsError(5);
    });
    const res = await app.inject({ url: '/busy' });
    await app.close();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
  });
});
