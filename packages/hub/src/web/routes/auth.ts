import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  PasskeyRegisterOptionsBodySchema,
  PasskeyVerifyBodySchema,
  PinBodySchema,
  SetPinBodySchema,
  isTimeZone,
  type MeDTO,
} from '@luady/shared';
import { authModeOf } from '../../config/defaults.js';
import { AuthError, NotFoundError, RefusedError } from '../../core/errors.js';
import { requireSessionOf } from '../auth/page-key.js';
import type { PasskeyRecord } from '../auth/passkeys.js';
import { clearSessionCookie, rotateSession, signedSessionSid, type AppSession } from '../auth/sessions.js';
import type { RouteModule, WebContext } from '../context.js';
import { EmptyBodySchema, PasskeyIdParamsSchema } from '../schemas.js';
import { parseBody, parseParams } from '../validate.js';

/** A passkey list item. Public keys and counters never leave the hub. */
export interface PasskeyView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function toPasskeyView(passkey: PasskeyRecord): PasskeyView {
  return { id: passkey.credId, label: passkey.label, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt };
}

/**
 * /api/auth/* is session-exempt in the chain; handlers that need a session enforce it here (401). The chain leaves the
 * session null when its page key is missing, so these routes need the key too.
 */
function requireSession(request: FastifyRequest, message?: string): AppSession {
  return requireSessionOf(request, message);
}

/**
 * `GET /api/me`: who is signed in and how. `owner` is the Access e-mail in `cloudflare-access` mode and the owner
 * label in `local` mode. The page key is never part of this answer. /api/me is session-exempt in the chain, so the 401
 * for "no session" (or no page key) is raised here.
 */
export function buildMe(request: FastifyRequest, ctx: WebContext): MeDTO {
  const session = requireSession(request);
  // The identity in front of the hub: the Access e-mail, or the owner label in local mode (web/auth/access.ts).
  const owner = request.accessIdentity?.email ?? null;
  if (owner === null) throw new AuthError('Login required');
  return { owner, authMode: authModeOf(ctx.deps.config), passkeys: ctx.passkeys.count(), pinSet: ctx.deps.pin.isSet(), csrf: session.csrf };
}

/**
 * Whether the install has an owner: the setup state when the hub has the setup module, else a passkey or a PIN on
 * file. Once it has one, a setup code alone adds no passkey.
 */
function installClaimed(ctx: WebContext): boolean {
  return ctx.deps.setup?.state().claimed ?? (ctx.passkeys.count() > 0 || ctx.deps.pin.isSet());
}

function registerOptions(request: FastifyRequest, ctx: WebContext): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const body = parseBody(PasskeyRegisterOptionsBodySchema, request.body);
  return ctx.webauthn.registrationOptions({
    setupCode: body.setupCode,
    pin: body.pin,
    hasSession: request.luadySession !== null,
    claimed: installClaimed(ctx),
  });
}

/** The first passkey (the claim) signs the browser in: the answer carries the new session's page key. */
async function registerVerify(request: FastifyRequest, reply: FastifyReply, ctx: WebContext): Promise<{ ok: true; pageKey?: string }> {
  const body = parseBody(PasskeyVerifyBodySchema, request.body);
  await ctx.webauthn.verifyRegistration({
    response: body.response,
    label: body.label,
    hasSession: request.luadySession !== null,
    claimed: installClaimed(ctx),
  });
  if (request.luadySession !== null) return { ok: true };
  const session = rotateSession(ctx.store, reply, null);
  ctx.deps.log.info({ via: 'passkey' }, 'auth: signed in');
  return { ok: true, pageKey: session.pageKey };
}

async function loginVerify(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: WebContext,
): Promise<{ ok: true; csrf: string; pageKey: string }> {
  const body = parseBody(PasskeyVerifyBodySchema, request.body);
  await ctx.webauthn.verifyAuthentication(body.response);
  const session = rotateSession(ctx.store, reply, request.luadySession);
  ctx.deps.log.info({ via: 'passkey' }, 'auth: signed in');
  return { ok: true, csrf: session.csrf, pageKey: session.pageKey };
}

function logout(request: FastifyRequest, reply: FastifyReply, ctx: WebContext): { ok: true } {
  parseBody(EmptyBodySchema, request.body);
  // By the signed cookie, with or without its page key: signing out always ends the session it names.
  const sid = request.luadySession?.sid ?? signedSessionSid(request);
  if (sid !== null) ctx.store.destroy(sid);
  clearSessionCookie(reply);
  return { ok: true };
}

/**
 * The first PIN set consumes the setup code inside pin.set. Every PIN set needs a signed-in session: both ways to
 * claim (the first passkey, a login link) sign the browser in first, so a code alone never sets a PIN.
 */
async function setPin(request: FastifyRequest, ctx: WebContext): Promise<{ ok: true }> {
  const body = parseBody(SetPinBodySchema, request.body);
  const claim = !ctx.deps.pin.isSet();
  requireSession(request, claim ? 'Sign in first: the first PIN is chosen once this browser is signed in' : 'Login required to change the PIN');
  await ctx.deps.pin.set(body.newPin, { currentPin: body.currentPin, setupCode: body.setupCode });
  if (claim && body.timeZone !== undefined) storeFirstZone(ctx, body.timeZone);
  return { ok: true };
}

/**
 * The claim: the browser's zone becomes the owner's when none is set yet (a zone already set is never changed). The
 * settings service checks it as Settings does; a zone it refuses is logged and left out, the PIN stays set.
 */
function storeFirstZone(ctx: WebContext, timeZone: string): void {
  const { settings, log } = ctx.deps;
  if (settings.get().owner_tz !== null) return;
  if (!isTimeZone(timeZone)) {
    log.warn('setup: the browser sent a time zone the hub does not know; none stored');
    return;
  }
  try {
    settings.update({ owner_tz: timeZone });
  } catch (err) {
    log.warn({ err }, 'setup: the browser time zone was not stored');
  }
}

/**
 * Session (401) → id format and PIN body (400) → pin.verify → unknown (404) / last passkey (409) → delete.
 * auth_sessions has no passkey column, so every app session except the caller's is revoked (a superset of the
 * sessions created with that passkey).
 */
async function deletePasskey(request: FastifyRequest, ctx: WebContext): Promise<{ ok: true }> {
  const session = requireSession(request);
  const { id } = parseParams(PasskeyIdParamsSchema, request.params);
  const { pin } = parseBody(PinBodySchema, request.body);
  await ctx.deps.pin.verify(pin, 'web');
  if (ctx.passkeys.get(id) === undefined) throw new NotFoundError(`Unknown passkey: ${id}`);
  if (ctx.passkeys.count() <= 1) throw new RefusedError('The last passkey cannot be deleted; add another one first');
  ctx.passkeys.remove(id);
  ctx.store.destroyAllExcept(session.sid);
  return { ok: true };
}

export const authRoutes: RouteModule = (app, ctx) => {
  app.get('/api/me', async (request) => buildMe(request, ctx));
  app.post('/api/auth/passkey/register/options', async (request) => registerOptions(request, ctx));
  app.post('/api/auth/passkey/register/verify', async (request, reply) => registerVerify(request, reply, ctx));
  app.post('/api/auth/passkey/login/options', async (request) => {
    parseBody(EmptyBodySchema, request.body);
    return ctx.webauthn.authenticationOptions();
  });
  app.post('/api/auth/passkey/login/verify', async (request, reply) => loginVerify(request, reply, ctx));
  app.post('/api/auth/logout', async (request, reply) => logout(request, reply, ctx));
  app.post('/api/auth/pin', async (request) => setPin(request, ctx));
  app.get('/api/auth/passkeys', async (request) => {
    requireSession(request);
    return { items: ctx.passkeys.list().map(toPasskeyView) };
  });
  app.post('/api/auth/passkeys/:id/delete', async (request) => deletePasskey(request, ctx));
};
