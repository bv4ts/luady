import {
  HttpsUrlSchema, KIT_V2, isSelfHost, type Channel, type CtlAuthLogout, type CtlAuthStatus, type HostId, type LoginResultDTO,
  type LoginStartDTO,
} from '@luady/shared';
import type { Clock, Db, EventBus, Fleet, LuadyService, Logger, OutboundChannel, SettingsService } from '../core/contracts.js';
import { CtlError, KitTooOldError, RefusedError } from '../core/errors.js';
import { ALERT_OUT, createLoginAlerts } from './alerts.js';
import { SignInCodeSchema } from './code.js';
import { createIdentityWatch, signedInSummary } from './identity.js';
import { createPendingSignIns, toLoginStart } from './pending.js';
import { createLoginState } from './state.js';
import { statusChanged, toLoginStatus, uncheckedStatus, type LoginStatus } from './status.js';
import { isProviderLink } from './link.js';
import { CODE_IN_FLIGHT, CODE_NOT_RECOGNISED, NO_SIGN_IN_WAITING, TOO_MANY_TRIES, UNEXPECTED_LINK, hostLabel } from './text.js';

export { LOGIN_WAIT_MS } from './pending.js';
export { WARN_AHEAD_MS } from './alerts.js';
export type { LoginStatus } from './status.js';

export { SIGN_IN_CODE_RE } from './code.js';
/** What /login <arg> accepts as a code when the argument is not a host name. */
export const LOOSE_CODE_RE = /^[A-Za-z0-9._~-]{8,512}(#[A-Za-z0-9._~-]{8,512})?$/;
export const BRAIN_CHECK_MS = 10 * 60_000;
export const SERVER_CHECK_MS = 60 * 60_000;
export const FIRST_CHECK_MS = 60_000;
/** Wrong codes one sign-in takes; the next wrong one ends it. */
export const CODE_ATTEMPTS_MAX = 5;
/** The kit's link failed the https-only schema in the fleet client. */
const BAD_LINK_RE = /^luady-ctl auth-login: unexpected output \(url /;

export interface ClaudeLoginDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  bus: Pick<EventBus, 'emit'>;
  fleet: Pick<Fleet, 'client' | 'servers'>;
  outbound: Pick<OutboundChannel, 'send'>;
  settings: Pick<SettingsService, 'get'>;
  /** Restarts a brain that was signed out, and passes on what was kept for it meanwhile. */
  luady: Pick<LuadyService, 'rotate' | 'release'>;
  /** Every host whose sign-in the accounts view lists: read at every call, never captured (the fleet changes). */
  hosts: () => readonly HostId[];
  /** Writes the audit row of a finished sign-in (actions table); never given the code. */
  audit?: (entry: SignInAudit) => void;
  /** The host moved to another account or signed out: its plan limits belonged to the old one (accounts/limits.ts). */
  onAccountChange?: (host: HostId, atIso: string) => void;
}

export interface SignInAudit { readonly host: HostId; readonly summary: string; readonly via: Channel }

export interface ClaudeLoginService {
  /** Starts a sign-in on host; replaces any earlier pending sign-in of that host, leaves other hosts' alone. */
  begin(host: HostId): Promise<LoginStartDTO>;
  /** Types the owner's code into host's waiting sign-in (stdin only). Never throws for a wrong code. `via` goes to the audit. */
  submit(host: HostId, code: string, via?: Channel): Promise<LoginResultDTO>;
  /** Signs host out (kit 2). For the self host, owner messages are then held until a new sign-in. */
  logout(host: HostId): Promise<LoginResultDTO>;
  /** null once it is 30 minutes old or done. */
  pending(host: HostId): LoginStartDTO | null;
  /** The host whose sign-in started last and still waits. */
  latestPending(): HostId | null;
  /** The last check of every host; hosts never checked are listed with nulls. */
  statuses(): readonly LoginStatus[];
  refresh(host: HostId): Promise<LoginStatus>;
  /** Luady's own login was signed out at the last check (or by a sign-out): the brain's queue is held. */
  brainSignedOut(): boolean;
  /** Checks every host's login; warns the owner once when one is signed out or runs out within 48 h. */
  check(): Promise<void>;
  start(): void;
  stop(): void;
}

const ERROR_TEXT_MAX = 300;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errorText = (err: unknown): string => errorMessage(err).slice(0, ERROR_TEXT_MAX);

/** A kit or CLI message must never carry the code back out (logs, errors, the website, the chat). */
export function scrubCode(text: string, code: string): string {
  const parts = [code, ...code.split('#')].filter((part) => part.length >= 8);
  return parts.reduce((out, part) => out.split(part).join('[code]'), text);
}

function tooOld(host: HostId): KitTooOldError {
  return new KitTooOldError(`${hostLabel(host)}'s kit is older than ${KIT_V2} and cannot sign out. Update the kit on ${hostLabel(host)} first.`);
}

export function createClaudeLoginService(deps: ClaudeLoginDeps): ClaudeLoginService {
  const alerts = createLoginAlerts(deps);
  const state = createLoginState(deps.db);
  const identities = createIdentityWatch({ state, log: deps.log, outbound: deps.outbound });
  const pendings = createPendingSignIns();
  let known: ReadonlyMap<HostId, LoginStatus> = new Map();
  /** Remembered over restarts, so messages kept for a signed-out brain are not typed into it after a deploy. */
  let brainOut = state.brainSignedOut();
  const lastCheckMs = new Map<HostId, number>();
  let checking = false;
  /** Hosts whose code is with the kit right now. */
  let checkingCode: ReadonlySet<HostId> = new Set();
  let timers: ReturnType<typeof setTimeout>[] = [];
  const nowMs = (): number => deps.clock.now().getTime();
  const changed = (): void => deps.bus.emit('accounts.changed', { at: deps.clock.now().toISOString() });

  /**
   * Luady's own sign-in, however it was found (code, check, refresh, a sign-in at the terminal): signed out → in
   * restarts the brain and passes on what was kept for it. Null when it did not come back just now.
   */
  async function brainState(status: CtlAuthStatus): Promise<boolean | null> {
    const wasOut = brainOut;
    brainOut = !status.logged_in;
    if (wasOut !== brainOut) state.setBrainSignedOut(brainOut);
    return wasOut && status.logged_in ? brainBack(true) : null;
  }

  /**
   * Stores what a check, a sign-in or a sign-out found (telling the owner first when the host is now on another
   * account). `changed`: the accounts view changes; `back`: Luady came back just now (true = the brain restarted).
   */
  async function observe(host: HostId, status: CtlAuthStatus): Promise<{ changed: boolean; back: boolean | null }> {
    const moved = await identities.observe(host, status);
    const next = toLoginStatus(host, status, deps.clock.now().toISOString());
    const before = known.get(host);
    if (moved || (!status.logged_in && before?.loggedIn !== false)) deps.onAccountChange?.(host, next.checkedAt ?? deps.clock.now().toISOString());
    known = new Map([...known, [host, next]]);
    const back = isSelfHost(host) ? await brainState(status) : null;
    return { changed: statusChanged(before, next), back };
  }

  function failed(host: HostId, message: string): LoginResultDTO {
    const last = known.get(host);
    return { host, ok: false, message, loggedIn: last?.loggedIn ?? false, expiresAt: last?.expiresAt ?? null, brainRestarted: false };
  }

  async function linkFrom(host: HostId): Promise<string> {
    let url: string;
    try {
      ({ url } = await deps.fleet.client(host).authLogin());
    } catch (err) {
      throw err instanceof CtlError && BAD_LINK_RE.test(err.message) ? new RefusedError(UNEXPECTED_LINK) : err;
    }
    if (!HttpsUrlSchema.safeParse(url).success || !isProviderLink(url)) {
      deps.log.warn({ host, outcome: 'unexpected_link' }, 'claude-login: sign-in link refused');
      throw new RefusedError(UNEXPECTED_LINK);
    }
    return url;
  }

  async function begin(host: HostId): Promise<LoginStartDTO> {
    const url = await linkFrom(host);
    const at = nowMs();
    pendings.put(host, url, at);
    deps.log.info({ host, outcome: 'link_issued' }, 'claude-login: sign-in started');
    changed();
    return toLoginStart({ host, url, at, tries: 0 });
  }

  /** A signed-out brain has nothing running, so restart it now; a renewal waits for an idle brain (or tonight's rotation). */
  async function brainBack(wasOut: boolean): Promise<boolean> {
    let restarted = false;
    try {
      restarted = (await deps.luady.rotate?.(wasOut)) ?? false;
    } catch (err) {
      deps.log.warn({ err: errorText(err) }, 'claude-login: brain restart after sign-in failed');
    }
    // A restarted brain gets the kept messages when it is up; a running one gets them now.
    if (!restarted) {
      await deps.luady.release?.().catch((err: unknown) => deps.log.warn({ err: errorText(err) }, 'claude-login: kept messages not passed on'));
    }
    return restarted;
  }

  async function signedIn(host: HostId, result: CtlAuthStatus & { message: string }, code: string, via: Channel): Promise<LoginResultDTO> {
    pendings.clear(host);
    const { back } = await observe(host, result);
    alerts.clear(host);
    deps.audit?.({ host, summary: signedInSummary(host, result), via });
    deps.log.info({ host, outcome: 'signed_in', expiresAt: result.expires_at }, 'claude-login: signed in');
    // Back from signed out: already restarted. A renewal restarts only an idle brain (or waits for tonight's rotation).
    const brainRestarted = !isSelfHost(host) ? false : back ?? await brainBack(false);
    return { host, ok: true, message: scrubCode(result.message, code), loggedIn: result.logged_in, expiresAt: result.expires_at, brainRestarted };
  }

  function wrongCode(host: HostId, message: string): LoginResultDTO {
    deps.log.info({ host, outcome: 'wrong_code' }, 'claude-login: code refused');
    return failed(host, message);
  }

  /** Every try is counted before the kit is asked; the sixth for one sign-in ends it without reaching the kit. */
  async function attempt(host: HostId, code: string, via: Channel): Promise<LoginResultDTO> {
    if (pendings.get(host, nowMs()) === null) return failed(host, NO_SIGN_IN_WAITING);
    if (pendings.countTry(host, nowMs()) > CODE_ATTEMPTS_MAX) {
      pendings.clear(host);
      deps.log.info({ host, outcome: 'too_many_tries' }, 'claude-login: sign-in ended');
      return failed(host, TOO_MANY_TRIES);
    }
    const parsed = SignInCodeSchema.safeParse(code);
    if (!parsed.success) return wrongCode(host, CODE_NOT_RECOGNISED);
    const clean = parsed.data;
    try {
      const result = await deps.fleet.client(host).authCode(clean);
      return result.ok ? await signedIn(host, result, clean, via) : wrongCode(host, scrubCode(result.message, clean));
    } catch (err) {
      if (err instanceof CtlError && err.code === 'usage') return wrongCode(host, CODE_NOT_RECOGNISED);
      if (err instanceof CtlError && err.code === 'not_found') pendings.clear(host);
      deps.log.warn({ host, outcome: 'error', code: err instanceof CtlError ? err.code : 'unexpected' }, 'claude-login: code not delivered');
      // Scrubbed before it is cut: a cut through the code would leave a piece the scrub no longer recognises.
      return failed(host, scrubCode(errorMessage(err), clean).slice(0, ERROR_TEXT_MAX));
    }
  }

  async function logout(host: HostId): Promise<LoginResultDTO> {
    let result: CtlAuthLogout;
    try {
      result = await deps.fleet.client(host).authLogout();
    } catch (err) {
      throw err instanceof CtlError && err.code === 'usage' ? tooOld(host) : err;
    }
    pendings.clear(host);
    await observe(host, result);
    // The owner asked for it: the next check does not warn that the host is signed out.
    if (result.logged_in) alerts.clear(host);
    else alerts.known(host, ALERT_OUT, deps.clock.now());
    deps.log.info({ host, outcome: result.ok ? 'signed_out' : 'refused' }, `claude-login: sign-out of ${hostLabel(host)}`);
    changed();
    return { host, ok: result.ok, message: result.message, loggedIn: result.logged_in, expiresAt: result.expires_at, brainRestarted: false };
  }

  async function checkHost(host: HostId, now: Date): Promise<boolean> {
    const status = await deps.fleet.client(host).authStatus();
    const { changed: moved } = await observe(host, status);
    await alerts.warnIfDue(host, status, now);
    lastCheckMs.set(host, now.getTime());
    return moved;
  }

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    let moved = false;
    try {
      const now = deps.clock.now();
      // Every listed host (the fleet's hosts: the self host only while the manager is switched on, so nothing is asked
      // of it while it is off): the self host every tick, servers hourly; a failed check (offline, old kit) is retried.
      const online = new Set(deps.fleet.servers().filter((s) => s.status === 'online').map((s) => s.name));
      const due = (host: HostId): boolean =>
        isSelfHost(host) || (online.has(host) && now.getTime() - (lastCheckMs.get(host) ?? 0) >= SERVER_CHECK_MS);
      for (const host of deps.hosts().filter(due)) {
        try {
          moved = (await checkHost(host, now)) || moved;
        } catch (err) {
          deps.log.warn({ host, err: errorText(err) }, 'claude-login: login check failed');
        }
      }
    } finally {
      checking = false;
    }
    if (moved) changed();
  }

  return {
    begin,
    async submit(host, code, via = 'web') {
      // One code per host at a time: a second one while the first is with the kit never reaches it.
      if (checkingCode.has(host)) return failed(host, CODE_IN_FLIGHT);
      checkingCode = new Set([...checkingCode, host]);
      try {
        return await attempt(host, code, via);
      } finally {
        checkingCode = new Set([...checkingCode].filter((busy) => busy !== host));
        changed();
      }
    },
    logout,
    pending: (host) => {
      const waiting = pendings.get(host, nowMs());
      return waiting === null ? null : toLoginStart(waiting);
    },
    latestPending: () => pendings.latest(nowMs()),
    statuses: () => deps.hosts().map((host) => known.get(host) ?? uncheckedStatus(host)),
    async refresh(host) {
      const status = await deps.fleet.client(host).authStatus();
      if ((await observe(host, status)).changed) changed();
      return known.get(host) ?? uncheckedStatus(host);
    },
    brainSignedOut: () => brainOut,
    check,
    start() {
      if (timers.length > 0) return;
      timers = [setTimeout(() => void check(), FIRST_CHECK_MS), setInterval(() => void check(), BRAIN_CHECK_MS)];
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    },
  };
}
