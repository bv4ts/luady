import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import { ValidationError } from './core/errors.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const REDACT_CENSOR = '[redacted]';

/** Keys that may carry a PIN, token, grant, cookie, JWT, page key or secrets.env value: top level and one level down (`*.x`). */
export const REDACT_PATHS: readonly string[] = [
  'pin', '*.pin', 'newPin', '*.newPin', 'currentPin', '*.currentPin',
  'token', '*.token', 'ticket', '*.ticket', 'setupCode', '*.setupCode',
  'cookie', '*.cookie', 'authorization', '*.authorization',
  'headers["cf-access-jwt-assertion"]',
  'req.headers.cookie', 'req.headers.authorization', 'req.headers["cf-access-jwt-assertion"]',
  // A host's grant and the page key, as a body field or a request header.
  'grant', '*.grant', 'req.headers["x-hub-grant"]', 'req.headers["x-hub-key"]',
  'secret', '*.secret', 'secrets', '*.secrets', 'password', '*.password',
  'sessionSecret', '*.sessionSecret', 'hubSocketToken', '*.hubSocketToken', 'cfAccessAud', '*.cfAccessAud',
];

export function loggerOptions(level: string): LoggerOptions {
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new ValidationError(`unknown log level: ${level}`);
  }
  return {
    level,
    base: { svc: 'luady-hub' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  };
}

/** pino JSON logger for journald. `opts.level` wins, then LOG_LEVEL, then `info`. */
export function createLogger(opts: { level?: string } = {}): Logger {
  return pino(loggerOptions(opts.level ?? process.env['LOG_LEVEL'] ?? 'info'));
}
