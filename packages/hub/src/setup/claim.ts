import { systemClock } from '../core/clock.js';
import type { Clock, Db } from '../core/contracts.js';
import { isRemote } from '../config/remote.js';
import { createSetupCodeService, SETUP_CODE_TTLS } from '../security/setup-codes.js';
import { readFacts, stateOf, type SetupConfig } from './state.js';

/** What `luady start` prints about claiming, and whether the install already has an owner. */
export interface ClaimBanner {
  readonly claimed: boolean;
  readonly lines: readonly string[];
}

export interface BannerOptions {
  readonly clock?: Clock;
  /** The zone the expiry time is shown in; this machine's own zone by default. */
  readonly timeZone?: string;
}

/** `ABCDEFGHJKLM` as `ABCD-EFGH-JKLM`: easier to read and type; the hub ignores the dashes. */
export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** "in 30 minutes (at 14:32)", in the given zone. */
export function expiryText(expiresAtMs: number, nowMs: number, timeZone?: string): string {
  const minutes = Math.round((expiresAtMs - nowMs) / 60_000);
  const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
    .format(new Date(expiresAtMs));
  return `in ${minutes} minutes (at ${at})`;
}

/** The lines that hand out a new setup code: the code, its lifetime, and what to do with it. */
export function setupCodeBlock(code: string, nowMs: number, timeZone?: string): string[] {
  return [
    `Setup code: ${groupCode(code)}`,
    `It works once and expires ${expiryText(nowMs + SETUP_CODE_TTLS.owner_setup, nowMs, timeZone)}.`,
  ];
}

export interface ClaimBannerOptions extends BannerOptions {
  /**
   * False when the output is not a terminal (a service manager or a container keeps it in a log): no code is issued
   * or printed, only how to get one. True by default.
   */
  readonly toTerminal?: boolean;
}

/** In place of the code when `start` does not write to a terminal. */
export const SETUP_CODE_ELSEWHERE = 'To claim this install, run npm run luady -- setup-code in a terminal on this machine and enter '
  + 'the code it prints on the page. (start prints no code here: this output is not a terminal, so a log would keep it.)';

/**
 * The claim banner: run over the database, so `luady start` can call it before or after the hub listens. On an
 * unclaimed install it issues a setup code (30 minutes, single use) and returns the lines to print: where to open
 * Luady, the code, when it expires, and the login-link way for a device without passkeys (never on a remote install).
 * On a claimed install it issues nothing, and with `toTerminal` false neither: it says how to get a code instead.
 * Nothing here logs the code.
 */
export function claimBanner(db: Db, config: SetupConfig, options: ClaimBannerOptions = {}): ClaimBanner {
  const clock = options.clock ?? systemClock;
  const state = stateOf(readFacts(db), config);
  const open = `Luady is running: open ${config.publicOrigin} in your browser.`;
  if (state.claimed) {
    const pin = state.step === 'pin' ? ['No PIN is set: run npm run luady -- setup-code for a code, then choose a PIN on the page.'] : [];
    return { claimed: true, lines: [open, ...pin] };
  }
  const way = isRemote(config)
    ? 'This hub can be reached from other machines, so claim it with a passkey (login links are off).'
    : 'No passkey on this device? Run npm run luady -- login instead.';
  if (options.toTerminal === false) return { claimed: false, lines: [open, SETUP_CODE_ELSEWHERE, way] };
  const code = createSetupCodeService({ db, clock }).issue('owner_setup');
  return { claimed: false, lines: [open, 'To claim this install, enter this code on the page.', ...setupCodeBlock(code, clock.now().getTime(), options.timeZone), way] };
}
