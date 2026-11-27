import {
  PageKeyDTOSchema, SetupLoginBodySchema, SetupStateDTOSchema, SetupStepBodySchema,
  type PageKeyDTO, type SetupLoginBody, type SetupStateDTO, type SetupStepBody,
} from '@luady/shared';
import { createHttp, type FetchLike } from './http.js';
import { checked } from './verbs.js';

/**
 * The first run: one function per route. It goes through the same HTTP layer as every other call (page
 * key, same origin, no cache), with the signed-in client's CSRF token read at every change.
 */
export interface SetupApi {
  /** Session-exempt: the five fields an anonymous visitor may know. */
  state(): Promise<SetupStateDTO>;
  /** A login link's token (from the page's fragment), plus the PIN once one is set; signs this browser in. */
  login(body: SetupLoginBody): Promise<PageKeyDTO>;
  step(body: SetupStepBody): Promise<SetupStateDTO>;
  finish(): Promise<SetupStateDTO>;
}

export interface SetupApiOptions {
  /** The session's CSRF token, read at every call (the main client keeps it). */
  readonly csrf: () => string | null;
  readonly fetch?: FetchLike;
  readonly pageKey?: () => string | null;
}

export function createSetupApi(options: SetupApiOptions): SetupApi {
  const http = createHttp({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.pageKey === undefined ? {} : { pageKey: options.pageKey }),
  });
  const withCsrf = (): void => http.setCsrf(options.csrf());
  return {
    state: () => http.request('GET', '/api/setup/state', SetupStateDTOSchema),
    login: async (body) => {
      // Session-exempt: no CSRF token exists yet (the Origin rule still applies).
      withCsrf();
      return http.request('POST', '/api/setup/login', PageKeyDTOSchema, checked(SetupLoginBodySchema, body));
    },
    step: async (body) => {
      withCsrf();
      return http.request('POST', '/api/setup/step', SetupStateDTOSchema, checked(SetupStepBodySchema, body));
    },
    finish: async () => {
      withCsrf();
      return http.request('POST', '/api/setup/finish', SetupStateDTOSchema, {});
    },
  };
}
