import { systemClock } from '../core/clock.js';
import type { Clock, Db } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { createSetupCodeService } from '../security/setup-codes.js';
import { expiryText, setupCodeBlock, type BannerOptions } from './claim.js';
import { issueLoginLink } from './login-link.js';
import { resetPin } from './pin-reset.js';
import type { SetupConfig } from './state.js';

/**
 * What the terminal commands print (`cli.ts` calls these and writes the lines to stdout). Each runs over the
 * database, with or without the hub. The codes and links go to standard output only, never to a log or a route; the
 * hub's `start` prints a code only when that output is a terminal (claim.ts), since a service manager logs it.
 */

export interface CommandResult {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
}

/** `luady setup-code`: a new setup code (30 minutes, single use) for the first passkey or the first PIN. */
export function setupCodeCommand(db: Db, options: BannerOptions = {}): CommandResult {
  const clock = options.clock ?? systemClock;
  const code = createSetupCodeService({ db, clock }).issue('owner_setup');
  return { exitCode: 0, lines: [...setupCodeBlock(code, clock.now().getTime(), options.timeZone), 'Enter it on the Luady page that asks for it.'] };
}

/** `luady login`: a link that signs this computer's browser in once, within 5 minutes; refused on a remote install. */
export function loginCommand(db: Db, config: SetupConfig, options: BannerOptions = {}): CommandResult {
  const clock: Clock = options.clock ?? systemClock;
  try {
    const link = issueLoginLink(db, config, clock);
    const nowMs = clock.now().getTime();
    return {
      exitCode: 0,
      lines: [
        'Open this link in a browser on this computer:',
        `  ${link.url}`,
        `It works once and expires ${expiryText(Date.parse(link.expiresAt), nowMs, options.timeZone)}. Once a PIN is set, the page asks for it.`,
        ...(link.setupCode === null ? [] : ['You will also need this setup code to choose your PIN:', ...setupCodeBlock(link.setupCode, nowMs, options.timeZone)]),
      ],
    };
  } catch (err) {
    if (err instanceof RefusedError) return { exitCode: 1, lines: [err.message] };
    throw err;
  }
}

/**
 * `luady pin reset`, after the owner typed `yes`: the PIN is cleared, every browser is signed out, passkeys stay. The
 * next steps keep one code alive: `login` issues a setup code of its own, which ends any printed before it.
 */
export function pinResetCommand(db: Db): CommandResult {
  const result = resetPin(db);
  const browsers = result.sessionsEnded === 1 ? '1 browser was' : `${result.sessionsEnded} browsers were`;
  return {
    exitCode: 0,
    lines: [
      `The PIN is cleared and ${browsers} signed out; open pages and web terminals close within a minute. Passkeys are kept.`,
      'To choose a new PIN: sign in with your passkey first, then run npm run luady -- setup-code and enter that code on the page.',
      'No passkey on this device? Run npm run luady -- login instead: it prints a sign-in link and the setup code to use after it.',
    ],
  };
}
