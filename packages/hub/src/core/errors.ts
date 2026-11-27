import { API_ERROR_CODES } from '@luady/shared';

export class HubError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotFoundError extends HubError { constructor(message: string) { super('not_found', message); } }
export class ValidationError extends HubError { constructor(message: string) { super('validation', message); } }
export class RefusedError extends HubError { constructor(message: string) { super('refused', message); } }
export class AuthError extends HubError { constructor(message: string) { super('auth', message); } }
export class QuestionClosedError extends HubError {
  constructor(public readonly state: string, message: string) { super('question_closed', message); }
}
export class QuestionPendingError extends HubError {
  constructor(public readonly qid: string, message: string) { super('question_pending', message); }
}
export class PinInvalidError extends HubError {
  constructor(public readonly remaining: number) { super('pin_invalid', 'Wrong PIN'); }
}
export class PinLockedError extends HubError {
  constructor(public readonly until: string) { super('pin_locked', `PIN locked until ${until}`); }
}
export class PinNotSetError extends HubError { constructor() { super('pin_not_set', 'PIN is not set'); } }
export class CtlError extends HubError {
  constructor(code: string, message: string, public readonly exitCode: number) { super(code, message); }
}
/** The owner paused the session: nothing may be typed into it until it is resumed. */
export class SessionPausedError extends HubError { constructor(message: string) { super(API_ERROR_CODES.sessionPaused, message); } }
/** The server's kit is older than the verb needs (kit 2 for pause, resume and sign-out). */
export class KitTooOldError extends HubError { constructor(message: string) { super(API_ERROR_CODES.kitTooOld, message); } }
/** A route or tool that has no implementation behind it. HTTP 501. */
export class NotBuiltYetError extends HubError {
  constructor(message = 'This part of Luady is not built yet.') { super('not_built_yet', message); }
}
/** The office has no Jira connection yet (the read routes answer 409). */
export class JiraNotConnectedError extends HubError {
  constructor(message = 'Jira is not connected for this office.') { super('jira_not_connected', message); }
}
