import { API_ERROR_CODES } from '@luady/shared';
import { z } from 'zod';

/** The error body. `remaining` comes only with pin_invalid and `until` only with pin_locked; the SPA never parses `message`. */
const ErrorBodySchema = z.object({
  error: z.looseObject({
    code: z.string().min(1).max(64),
    message: z.string().max(2000),
    remaining: z.number().int().nonnegative().optional(),
    until: z.string().max(64).optional(),
  }),
});

export interface ApiErrorDetails {
  readonly remaining?: number;
  readonly until?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetails;

  constructor(status: number, code: string, message: string, details: ApiErrorDetails = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

export function errorFromResponse(status: number, body: unknown): ApiError {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return new ApiError(status, `http_${status}`, `Luady answered with HTTP ${status}.`);
  const { code, message, remaining, until } = parsed.data.error;
  const details: ApiErrorDetails = {
    ...(remaining === undefined ? {} : { remaining }),
    ...(until === undefined ? {} : { until }),
  };
  return new ApiError(status, code, message, details);
}

/** Refusal codes (`API_ERROR_CODES`) in the owner's words. */
const CODE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  [API_ERROR_CODES.sessionPaused]: 'This agent is paused. Resume it first.',
  [API_ERROR_CODES.kitTooOld]: 'This server needs the new kit before it can do that.',
});

export function userMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session ended. Sign in again.';
    const coded = Object.hasOwn(CODE_TEXT, err.code) ? CODE_TEXT[err.code] : undefined;
    if (coded !== undefined) return coded;
    // 403 forbidden = Access JWT, CSRF or Origin check failed; a reload lets Cloudflare Access re-authenticate.
    if (err.code === 'forbidden') return 'Your login could not be verified. Reload the page to sign in again.';
    if (err.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (err.code.startsWith('http_') && err.status >= 502 && err.status <= 504) {
      return 'Luady is unreachable right now (it may be restarting). Try again in a moment.';
    }
    if (err.status === 502) return `The server command failed: ${err.message}`;
    if (err.status >= 500) return 'The hub hit an unexpected error. Try again in a moment.';
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Try again.';
}
