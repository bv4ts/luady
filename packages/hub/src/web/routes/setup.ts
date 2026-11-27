import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  PAGE_KEY_HEADER, SetupLoginBodySchema, SetupStepBodySchema, type PageKeyDTO, type SetupStateDTO,
} from '@luady/shared';
import type { SetupService } from '../../core/contracts.js';
import { passkeySkipRefusal, setupPending, type StepActor } from '../../setup/index.js';
import { loginLinkRefusal, type LoginLinkRefusal } from '../auth/login-link.js';
import { createSessionWithPageKey } from '../auth/sessions.js';
import type { RouteModule, WebContext } from '../context.js';
import { errorBody, PinRequiredError } from '../errors.js';
import { EmptyBodySchema } from '../schemas.js';
import { parseBody } from '../validate.js';

/** Why a login link is refused, in plain words, with what to do instead. */
export const LOGIN_REFUSALS: Readonly<Record<LoginLinkRefusal, string>> = {
  remote: 'Login links are off: this hub can be reached from other machines. Sign in with a passkey.',
  forwarded: 'Login links work only when Luady is opened directly on this computer, not through a proxy or a tunnel.',
  'not-loopback': 'Login links work only on the computer Luady runs on, opened at http://localhost.',
};

/** The five fields of the DTO and nothing else: no names, hosts, paths or versions. */
export function stateView(state: SetupStateDTO): SetupStateDTO {
  return { step: state.step, claimed: state.claimed, authMode: state.authMode, remote: state.remote, skipped: [...state.skipped] };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function forbidden(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(403).send(errorBody('forbidden', message));
}

/**
 * `POST /api/setup/login`: session-exempt, in the auth bucket. Refused for a remote install, behind any
 * forwarding header, or from a peer that is not loopback. Then the token is checked (not yet used up); once a PIN is set
 * it is required too: a missing one answers 428 (nothing counted), a wrong one counts toward the lockout. Only then is
 * the token used up and the browser signed in. The token is never logged; only the reason of a refusal is.
 */
async function login(request: FastifyRequest, reply: FastifyReply, ctx: WebContext, setup: SetupService): Promise<PageKeyDTO | FastifyReply> {
  const { config, log, pin, setupCodes } = ctx.deps;
  const refusal = loginLinkRefusal(config, request);
  if (refusal !== null) {
    log.warn({ reason: refusal }, 'setup: login link refused');
    return forbidden(reply, LOGIN_REFUSALS[refusal]);
  }
  const body = parseBody(SetupLoginBodySchema, request.body);
  setupCodes.check(body.token, 'owner_login');
  if (pin.isSet()) {
    // No PIN sent: the page did not know one is needed. That is not a wrong PIN, so nothing counts.
    if (body.pin === undefined) throw new PinRequiredError('Enter your PIN to sign in with this link');
    await pin.verify(body.pin, 'web');
  }
  setupCodes.consume(body.token, 'owner_login');
  const { pageKey } = createSessionWithPageKey(reply, 'link', log);
  setup.keepLinkSession(pageKey);
  setup.notify();
  return { pageKey };
}

/** `POST /api/setup/step` (session and page key): a step done or skipped; the passkey skip only for a link session. */
function step(request: FastifyRequest, reply: FastifyReply, ctx: WebContext, setup: SetupService): SetupStateDTO | FastifyReply {
  const body = parseBody(SetupStepBodySchema, request.body);
  const who: StepActor = {
    linkSession: setup.isLinkSession(header(request, PAGE_KEY_HEADER)),
    localRequest: loginLinkRefusal(ctx.deps.config, request) === null,
  };
  if (body.step === 'passkey' && body.action === 'skip') {
    const refusal = passkeySkipRefusal(who, ctx.deps.config);
    if (refusal !== null) return forbidden(reply, refusal);
  }
  return stateView(setup.advance(body.step, body.action, who));
}

/**
 * The first run. Registered only when the setup service is present. `GET /api/setup/state` is
 * session-exempt and in the api bucket.
 */
export const setupRoutes: RouteModule = (app, ctx) => {
  const { setup } = ctx.deps;
  if (setup === undefined) return;
  // The auth chain answers only sign-in and setup while this says so (web/auth/chain.ts).
  app.luadySetupPending = () => setupPending(setup.state());
  app.get('/api/setup/state', async (): Promise<SetupStateDTO> => {
    // A passkey made since the last change is told to the open pages here (its route is not the setup module's).
    setup.notify();
    return stateView(setup.state());
  });
  app.post('/api/setup/login', async (request, reply) => login(request, reply, ctx, setup));
  app.post('/api/setup/step', async (request, reply) => step(request, reply, ctx, setup));
  app.post('/api/setup/finish', async (request): Promise<SetupStateDTO> => {
    parseBody(EmptyBodySchema, request.body);
    return stateView(setup.finish());
  });
};
