import type { Clock, Logger } from '../core/contracts.js';
import { NotFoundError, RefusedError } from '../core/errors.js';
import { sha256Hex } from '../core/ids.js';
import type { MeetingsService } from '../meetings/service.js';
import type { GoogleService } from './service.js';

/** The accounts the website connects. */
export const CONNECT_SERVICES = ['google', 'wispr'] as const;
export type ConnectKind = (typeof CONNECT_SERVICES)[number];
/** A website connect state lives 10 minutes and is used once. */
export const CONNECT_STATE_TTL_MS = 10 * 60_000;
/** Used and expired states are remembered this long, so neither can come back as a chat link. */
const REMEMBER_MS = 60 * 60_000;
const BINDINGS_MAX = 200;

/** What the provider's redirect should do with a state. */
export type CallbackPlan = 'page' | 'chat' | 'expired';

declare module '../core/contracts.js' {
  interface ConnectService {
    available(service: ConnectKind): boolean;
    /** `POST /api/connect/:service`: the provider link, its state bound to this session (10 minutes, single use). */
    start(service: ConnectKind, sid: string, label: string | null): Promise<{ url: string }>;
    /**
     * The provider sent the browser back. `page`: a website state, finished by the return page with the session;
     * `chat`: a link the chat command made (no session to bind), finished now; `expired`: used or too old.
     */
    callback(service: ConnectKind, state: string): CallbackPlan;
    /** `POST /api/connect/:service/finish`: only the session the state was bound to, once, within 10 minutes. */
    finish(service: ConnectKind, sid: string, state: string, code: string): Promise<string>;
    /** A chat link's callback. */
    finishChat(service: ConnectKind, state: string, code: string): Promise<string>;
    /** The chat `/google` link: its single-use code turned into the provider link (null when unknown or used). */
    chatGoogleUrl(code: string): string | null;
    /** The chat `/wispr` command (the same builder as the website). */
    wisprCommand(arg: string | null): Promise<string>;
  }
}

interface Binding {
  readonly service: ConnectKind;
  readonly sidHash: string;
  readonly expiresAt: number;
  readonly madeAt: number;
  used: boolean;
}

export interface ConnectFlowDeps {
  google: Pick<GoogleService, 'connectUrl' | 'finish' | 'accounts' | 'issueLink' | 'consumeLink'> | null;
  meetings: Pick<MeetingsService, 'signInUrl' | 'finish' | 'command'> | null;
  clock: Clock;
  log: Logger;
  publicOrigin: string;
}

const stateOf = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('state');
  } catch {
    return null;
  }
};

/**
 * Connecting Google and Wispr. Both the website and the chat commands make their links here.
 * A website link's state is bound to the session's sid hash: the provider's redirect cannot carry the strict cookie,
 * so the callback only serves the return page, whose own script finishes with the cookie, the page key and CSRF.
 */
export function createConnectFlow(deps: ConnectFlowDeps) {
  const bindings = new Map<string, Binding>();
  const nowMs = (): number => deps.clock.now().getTime();

  function prune(): void {
    const at = nowMs();
    for (const [state, binding] of bindings) if (at - binding.madeAt > REMEMBER_MS) bindings.delete(state);
  }

  function available(service: ConnectKind): boolean {
    return service === 'google' ? deps.google !== null : deps.meetings !== null;
  }

  async function providerUrl(service: ConnectKind, label: string | null): Promise<{ url: string; state: string }> {
    if (service === 'google') {
      if (deps.google === null) throw new NotFoundError('Google is not set up on this hub.');
      const url = deps.google.connectUrl(label ?? 'personal');
      const state = stateOf(url);
      if (state === null) throw new Error('google: the consent link carries no state');
      return { url, state };
    }
    if (deps.meetings === null) throw new NotFoundError('Meetings are not set up on this hub.');
    return deps.meetings.signInUrl();
  }

  async function finishWith(service: ConnectKind, state: string, code: string): Promise<string> {
    if (service === 'google') {
      if (deps.google === null) throw new NotFoundError('Google is not set up on this hub.');
      const { email, label } = await deps.google.finish(state, code);
      return `${email} is connected as "${label}".`;
    }
    if (deps.meetings === null) throw new NotFoundError('Meetings are not set up on this hub.');
    await deps.meetings.finish(state, code);
    return 'Wispr Flow is connected.';
  }

  return {
    available,
    googleStatusText(): string | null {
      const google = deps.google;
      if (google === null) return null;
      const connected = google.accounts().map((a) => `✅ ${a.label}: ${a.email}`);
      const link = (label: string): string => `${deps.publicOrigin}/api/google/connect?t=${google.issueLink(label)}`;
      return [
        ...(connected.length > 0 ? ['*Connected*', ...connected, ''] : []),
        '*Connect an account* (each link works once, for 30 minutes; or connect it from Settings on the website):',
        `• Personal: ${link('personal')}`,
        `• Work: ${link('work')}`,
      ].join('\n');
    },
    async start(service: ConnectKind, sid: string, label: string | null): Promise<{ url: string }> {
      prune();
      if ([...bindings.values()].filter((b) => !b.used && b.expiresAt > nowMs()).length >= BINDINGS_MAX) {
        throw new RefusedError('Too many connect links are open; try again in a few minutes.');
      }
      const { url, state } = await providerUrl(service, label);
      const at = nowMs();
      bindings.set(state, { service, sidHash: sha256Hex(sid), madeAt: at, expiresAt: at + CONNECT_STATE_TTL_MS, used: false });
      deps.log.info({ service }, 'connect: a website connect link was made');
      return { url };
    },
    callback(service: ConnectKind, state: string): CallbackPlan {
      const binding = bindings.get(state);
      if (binding === undefined) return 'chat';
      if (binding.service !== service || binding.used || binding.expiresAt <= nowMs()) return 'expired';
      return 'page';
    },
    async finish(service: ConnectKind, sid: string, state: string, code: string): Promise<string> {
      const binding = bindings.get(state);
      if (binding === undefined || binding.service !== service) throw new RefusedError('This connect link is not known; start again from the website.');
      if (binding.sidHash !== sha256Hex(sid)) {
        deps.log.warn({ service }, 'connect: a finish from another session was refused');
        throw new ConnectForbiddenError();
      }
      if (binding.used) throw new RefusedError('This connect link was already used; start again from the website.');
      if (binding.expiresAt <= nowMs()) throw new RefusedError('This connect link expired; start again from the website.');
      binding.used = true;
      return finishWith(service, state, code);
    },
    async finishChat(service: ConnectKind, state: string, code: string): Promise<string> {
      if (bindings.has(state)) throw new RefusedError('This connect link belongs to the website; finish it there.');
      return finishWith(service, state, code);
    },
    chatGoogleUrl(code: string): string | null {
      if (deps.google === null) return null;
      const label = deps.google.consumeLink(code);
      return label === null ? null : deps.google.connectUrl(label);
    },
    async wisprCommand(arg: string | null): Promise<string> {
      if (deps.meetings === null) return 'Meetings are not set up on the hub.';
      return deps.meetings.command(arg);
    },
  };
}


/** A finish from a session other than the one that started the link. */
export class ConnectForbiddenError extends Error {
  readonly statusCode = 403;
  constructor() {
    super('This connect link was started in another session.');
    this.name = 'ConnectForbiddenError';
  }
}
