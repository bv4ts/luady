import type { FastifyInstance } from 'fastify';
import type { Logger } from '../core/contracts.js';
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
} from '../core/errors.js';

/** 428: an owner request needs a PIN it did not send (tier-1 exec, adding a passkey). */
export class PinRequiredError extends HubError {
  constructor(message = 'PIN required for this action') {
    super('pin_required', message);
  }
}

/** 429: thrown by the rate limiter's errorResponseBuilder. */
export class RateLimitedError extends HubError {
  constructor(retryAfter: string) {
    super('rate_limited', `Too many requests, retry in ${retryAfter}`);
  }
}

/** 403: the request lacks a credential this route needs on top of the session (a PIN or a grant, say), or it does not hold. */
export class ForbiddenError extends HubError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** 429 with the seconds to wait, sent as Retry-After (a route's own bucket; the global limiter answers by itself). */
export class TooManyRequestsError extends HubError {
  constructor(readonly retryAfterSec: number, message = `Too many requests, retry in ${retryAfterSec} seconds`) {
    super('rate_limited', message);
  }
}

/** Error body. `remaining` appears only for pin_invalid and `until` only for pin_locked; the SPA never parses `message`. */
export interface ErrorBody {
  error: { code: string; message: string; remaining?: number; until?: string };
}

export type ErrorDetails = Pick<ErrorBody['error'], 'remaining' | 'until'>;

export interface MappedError {
  status: number;
  body: ErrorBody;
  /** Headers the answer carries (Retry-After on a 429 with a wait). */
  headers?: Readonly<Record<string, string>>;
}

type HubErrorClass = new (...args: never[]) => HubError;

/** The HTTP mapping plus the two web-private errors. The classes do not overlap, so order is irrelevant. */
const STATUS_BY_CLASS: ReadonlyArray<readonly [HubErrorClass, number]> = [
  [NotFoundError, 404],
  [ValidationError, 400],
  [RefusedError, 409],
  [QuestionClosedError, 409],
  [QuestionPendingError, 409],
  [SessionPausedError, 409],
  [KitTooOldError, 409],
  [JiraNotConnectedError, 409],
  [NotBuiltYetError, 501],
  [PinInvalidError, 403],
  [PinLockedError, 423],
  [PinNotSetError, 428],
  [PinRequiredError, 428],
  [AuthError, 401],
  [CtlError, 502],
  [RateLimitedError, 429],
  [ForbiddenError, 403],
  [TooManyRequestsError, 429],
];

const FRAMEWORK_ERRORS: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: 'bad_request', message: 'Malformed request' },
  404: { code: 'not_found', message: 'Not found' },
  413: { code: 'payload_too_large', message: 'Request body too large' },
  415: { code: 'unsupported_media_type', message: 'Unsupported content type' },
  429: { code: 'rate_limited', message: 'Too many requests' },
};

export function errorBody(code: string, message: string, details: ErrorDetails = {}): ErrorBody {
  return { error: { code, message, ...details } };
}

export const INTERNAL_ERROR: MappedError = { status: 500, body: errorBody('internal', 'Internal error') };

/** Only the two PIN errors carry structured fields; every other body is exactly {code, message}. */
function detailsFor(err: HubError): ErrorDetails {
  if (err instanceof PinInvalidError) return { remaining: err.remaining };
  if (err instanceof PinLockedError) return { until: err.until };
  return {};
}

function mapHubError(err: HubError): MappedError {
  const hit = STATUS_BY_CLASS.find(([cls]) => err instanceof cls);
  if (hit === undefined) return INTERNAL_ERROR;
  const mapped = { status: hit[1], body: errorBody(err.code, err.message, detailsFor(err)) };
  return err instanceof TooManyRequestsError ? { ...mapped, headers: { 'retry-after': String(err.retryAfterSec) } } : mapped;
}

function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('statusCode' in err)) return null;
  const status = err.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof HubError) return mapHubError(err);
  const status = clientErrorStatus(err);
  if (status === null) return INTERNAL_ERROR;
  const known = FRAMEWORK_ERRORS[status] ?? { code: 'bad_request', message: 'Bad request' };
  return { status, body: errorBody(known.code, known.message) };
}

export function registerErrorHandler(app: FastifyInstance, log: Logger): void {
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      log.error({ err, method: request.method, route: request.routeOptions.url ?? null }, 'web request failed');
    }
    return reply.code(mapped.status).headers(mapped.headers ?? {}).send(mapped.body);
  });
}
