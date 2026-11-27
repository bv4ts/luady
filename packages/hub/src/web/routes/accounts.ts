import { z } from 'zod';
import {
  HostIdSchema, LoginCodeBodySchema, PinBodySchema, PinSchema, type AccountsDTO, type CodexLoginDTO, type HostId, type LoginResultDTO,
  type LoginStartDTO,
} from '@luady/shared';
import type { Fleet } from '../../core/contracts.js';
import { CtlError, NotFoundError, RefusedError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { PinRequiredError } from '../errors.js';
import { ownerAction } from '../owner-action.js';
import { hostLabel } from '../../claude-login/text.js';
import { EmptyBodySchema } from '../schemas.js';
import { parseBody } from '../validate.js';

const HostParamsSchema = z.strictObject({ host: HostIdSchema });
/** A sign-in start: the PIN is needed when the host is signed in (it could move to another account). */
const LoginStartBodySchema = z.strictObject({ pin: PinSchema.optional() });
export const LOGIN_FAILED_CODE = 'login_failed';
const NOT_STARTED = 'The sign-in did not start. Try again.';

/**
 * `:host` is any host id on the wire that the fleet has (a server, this computer or the manager's own);
 * anything else is 404 before any action is created.
 */
function hostOf(fleet: Pick<Fleet, 'hasHost'>, params: unknown): HostId {
  const parsed = HostParamsSchema.safeParse(params ?? {});
  if (!parsed.success || !fleet.hasHost(parsed.data.host)) throw new NotFoundError('Unknown host');
  return parsed.data.host;
}

/**
 * Accounts, limits, sign-in and sign-out. Starting a sign-in and signing out are audited actions (tier 0 and tier 1);
 * the code goes straight to the login service and is never part of an action, a log line or an answer.
 */
export const accountRoutes: RouteModule = (app, ctx) => {
  const { accounts, login, codexLogin, actions, fleet } = ctx.deps;
  const signedOut = (host: HostId): boolean => login.statuses().find((status) => status.host === host)?.loggedIn === false;
  app.get('/api/accounts', async (): Promise<AccountsDTO> => accounts.list());
  app.post('/api/accounts/codex/login', async (request): Promise<CodexLoginDTO> => {
    const { pin } = parseBody(LoginStartBodySchema, request.body);
    // A signed-in ChatGPT could be swapped for another: the PIN, whatever require_pin says.
    const swap = (await codexLogin.status()) === 'in';
    if (swap && pin === undefined) throw new PinRequiredError('PIN required: ChatGPT is signed in');
    // Audited like every sign-in start; the link and device code come from the running sign-in, never the audit row.
    const action = await ownerAction(actions, 'account.login', { target: 'codex' }, swap ? pin : undefined, { alwaysPin: swap });
    if (action.status !== 'done') throw new RefusedError(action.error ?? NOT_STARTED);
    return codexLogin.beginData();
  });
  app.post('/api/accounts/codex/logout', async (request) => {
    const { pin } = parseBody(PinBodySchema, request.body);
    return ownerAction(actions, 'account.logout', { target: 'codex' }, pin, { alwaysPin: true });
  });
  app.post('/api/accounts/:host/login', async (request): Promise<LoginStartDTO> => {
    const host = hostOf(fleet, request.params);
    const { pin } = parseBody(LoginStartBodySchema, request.body);
    const free = signedOut(host);
    // Checked before any action exists, so a missing PIN leaves no confirmation waiting. A signed-in host could be moved
    // to another account: the PIN, whatever require_pin says (it governs only Luady's own actions).
    if (!free && pin === undefined) throw new PinRequiredError(`PIN required: ${hostLabel(host)} is signed in`);
    const action = await ownerAction(actions, 'account.login', { target: host }, free ? undefined : pin, { alwaysPin: !free });
    if (action.status === 'pending_confirmation') throw new PinRequiredError(`PIN required: ${hostLabel(host)} is signed in`);
    if (action.status !== 'done') throw new CtlError(LOGIN_FAILED_CODE, action.error ?? NOT_STARTED, 0);
    const pending = login.pending(host);
    if (pending === null) throw new CtlError(LOGIN_FAILED_CODE, NOT_STARTED, 0);
    return pending;
  });
  app.post('/api/accounts/:host/code', async (request): Promise<LoginResultDTO> => {
    const host = hostOf(fleet, request.params);
    const { code } = parseBody(LoginCodeBodySchema, request.body);
    return login.submit(host, code, 'web');
  });
  app.post('/api/accounts/:host/logout', async (request) => {
    const host = hostOf(fleet, request.params);
    const { pin } = parseBody(PinBodySchema, request.body);
    return ownerAction(actions, 'account.logout', { target: host }, pin, { alwaysPin: true });
  });
  app.post('/api/accounts/:host/refresh', async (request): Promise<AccountsDTO> => {
    const host = hostOf(fleet, request.params);
    parseBody(EmptyBodySchema, request.body);
    await login.refresh(host);
    return accounts.list();
  });
};
