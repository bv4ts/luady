import { NotFoundError, RefusedError } from '../core/errors.js';

/** Why a Jira call failed, in the owner's words. None of these ever carries a response body, the token or a header. */
export const JIRA_MESSAGES = {
  auth: 'Jira refused the sign-in. The token may have expired.',
  forbidden: 'Jira refused this: the account may not have permission.',
  notFound: 'Jira could not find that ticket, or this account cannot see it.',
  busy: 'Jira is busy right now. Try again in a minute.',
  timeout: 'Jira did not answer in time.',
  unreachable: 'Could not reach Jira.',
  server: 'Jira is having trouble right now.',
  unreadable: 'Jira sent an answer the hub could not read.',
  site: 'The Jira site address must look like https://name.atlassian.net.',
  bad: 'Jira did not accept that change.',
} as const;

export type JiraFailure = Exclude<keyof typeof JIRA_MESSAGES, 'notFound'>;

/**
 * A Jira call that failed (HTTP 409). `code` is `jira_auth` when the sign-in was refused (the website then offers to
 * connect again) and `jira_failed` otherwise.
 */
export class JiraError extends RefusedError {
  override readonly code: string;
  constructor(public readonly kind: JiraFailure, message: string = JIRA_MESSAGES[kind]) {
    super(message);
    this.code = kind === 'auth' ? 'jira_auth' : 'jira_failed';
  }
}

/** Jira answered 404 for a ticket. */
export class JiraNotFoundError extends NotFoundError {
  constructor(message: string = JIRA_MESSAGES.notFound) {
    super(message);
  }
}

/** Removes every secret from a text before it can reach a message or a log line (defence in depth). */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets.filter((secret) => secret.length >= 4).reduce((out, secret) => out.split(secret).join('[hidden]'), text);
}

const DETAIL_MAX = 200;

/** Jira's own error messages for a refused change (`errorMessages` and `errors`), one line, cut short, secrets removed. */
export function jiraDetail(body: unknown, secrets: readonly string[]): string {
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Record<string, unknown>;
  const list = Array.isArray(record.errorMessages) ? record.errorMessages.filter((m): m is string => typeof m === 'string') : [];
  const fields = typeof record.errors === 'object' && record.errors !== null
    ? Object.values(record.errors as Record<string, unknown>).filter((m): m is string => typeof m === 'string')
    : [];
  const text = [...list, ...fields].join(' ').replace(/\s+/g, ' ').trim();
  const cut = text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
  return scrub(cut, secrets);
}
