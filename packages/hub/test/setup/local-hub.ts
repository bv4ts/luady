import type { LightMyRequestResponse } from 'fastify';
import { vi } from 'vitest';
import { PAGE_KEY_HEADER, type SetupStateDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, HubConfig, Logger, SetupCodeService, SetupService } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createPinService } from '../../src/security/pin.js';
import { hashPin } from '../../src/security/pin-hash.js';
import { createSetupCodeService } from '../../src/security/setup-codes.js';
import { createSetupModule } from '../../src/setup/index.js';
import { createLocalIdentity } from '../../src/web/auth/access.js';
import { SESSION_COOKIE, createSessionStore, type SessionStore } from '../../src/web/auth/sessions.js';
import type { WebDeps } from '../../src/web/server.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { makeDirs, testConfig, type Harness } from '../web/helpers.js';

export const LOCAL_ORIGIN = 'http://localhost:7410';
export const OWNER_PIN = '482915';

export type HarnessFactory = (over?: Partial<WebDeps>) => Promise<Harness>;

export interface SignedIn {
  readonly cookie: string;
  readonly csrf: string;
  readonly pageKey: string;
  readonly sid: string;
}

export interface LocalHub {
  readonly h: Harness;
  readonly db: Db;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly config: HubConfig;
  readonly setup: SetupService;
  readonly setupCodes: SetupCodeService;
  /** Every code and token the hub's setup-code service handed out. */
  readonly issued: string[];
  readonly events: SetupStateDTO[];
  readonly store: SessionStore;
  /** A session as a passkey sign-in makes it (not a login link). */
  signIn(): SignedIn;
  /** A request as the browser on this computer sends it (Origin, cookie, CSRF and page key when signed in). */
  send(method: 'GET' | 'POST', url: string, body?: object, opts?: SendOptions): Promise<LightMyRequestResponse>;
}

export interface SendOptions {
  readonly session?: Pick<SignedIn, 'cookie' | 'csrf' | 'pageKey'>;
  readonly headers?: Record<string, string>;
  readonly remoteAddress?: string;
  /** Leave out the page key while sending the cookie. */
  readonly noKey?: boolean;
}

export interface LocalHubOptions {
  readonly config?: Partial<HubConfig>;
  readonly pinSet?: boolean;
  readonly passkey?: boolean;
  readonly log?: Logger;
}

export function addPasskey(db: Db): void {
  db.prepare(`INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at)
    VALUES ('cred-1', ?, 0, '[]', 'Laptop', '2026-11-21T08:00:00.000Z')`).run(Buffer.from([1, 2, 3]));
}

/** The `hub_sid=…` pair a response set. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const all = Array.isArray(header) ? header : header === undefined ? [] : [String(header)];
  const own = all.find((line) => line.startsWith(`${SESSION_COOKIE}=`));
  if (own === undefined) throw new Error('no session cookie was set');
  return own.split(';', 1)[0] ?? '';
}

/**
 * A local-mode hub with the real setup module, PIN service and setup codes over one database; the
 * page key is required, as in the hub.
 */
export async function localHub(harness: HarnessFactory, options: LocalHubOptions = {}): Promise<LocalHub> {
  const db = openMemoryDb();
  const clock = createFakeClock();
  const bus = createBus();
  const log = options.log ?? silentLogger();
  const events: SetupStateDTO[] = [];
  bus.on('setup.changed', ({ state }) => events.push(state));
  // Local mode: no Access e-mail and no Access fields at all.
  const { ownerEmail: _email, cfTeamDomain: _team, cfAccessAud: _aud, ...base } = testConfig(makeDirs());
  const config: HubConfig = {
    ...base, publicOrigin: LOCAL_ORIGIN, rpId: 'localhost', authMode: 'local', ownerLabel: 'owner', bindHost: '127.0.0.1', ...options.config,
  };
  const codes = createSetupCodeService({ db, clock });
  const issued: string[] = [];
  const setupCodes: SetupCodeService = {
    ...codes,
    issue: vi.fn((purpose) => {
      const code = codes.issue(purpose);
      issued.push(code);
      return code;
    }),
  };
  const pin = createPinService({ db, clock, setupCodes, log });
  if (options.passkey === true) addPasskey(db);
  if (options.pinSet === true) db.prepare('UPDATE pin_state SET hash = ? WHERE id = 1').run(await hashPin(OWNER_PIN));
  const setup = createSetupModule({ db, bus, clock, config, log });
  const store = createSessionStore({ db, clock });
  const h = await harness({
    config, db, bus, clock, log, pin, setupCodes, setup, access: createLocalIdentity('owner'),
    pageKey: { required: () => true, matches: (sid, key) => store.pageKeyMatches(sid, key) },
  });
  const signIn = (): SignedIn => {
    const made = store.create();
    return { sid: made.sid, csrf: made.csrf, pageKey: made.pageKey, cookie: `${SESSION_COOKIE}=${encodeURIComponent(h.app.signCookie(made.sid))}` };
  };
  const send: LocalHub['send'] = (method, url, body, opts = {}) => h.app.inject({
    method,
    url,
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: {
      ...(method === 'POST' ? { origin: LOCAL_ORIGIN } : {}),
      ...(opts.session === undefined ? {} : { cookie: opts.session.cookie, ...(method === 'POST' ? { 'x-hub-csrf': opts.session.csrf } : {}) }),
      ...(opts.session === undefined || opts.noKey === true ? {} : { [PAGE_KEY_HEADER]: opts.session.pageKey }),
      ...opts.headers,
    },
    ...(body === undefined ? {} : { payload: body }),
  });
  return { h, db, clock, config, setup, setupCodes, issued, events, store, signIn, send };
}
