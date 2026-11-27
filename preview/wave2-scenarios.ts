import { ownerFormat, type HostId } from '@luady/shared';
import { LIGHTS } from './page-hook.ts';
import type { Driver, Scenario } from './scenarios.ts';

/** Drive verbs for the welcome-back card, day and night, snooze and due reminders. */

export interface Wave2Controls {
  /** The next page load shows the welcome-back card as if the owner was away this long. */
  away(minutes: number): void;
  /** Fixes the office clock at `HH:MM` owner time (null: the real clock again); the instant set. */
  clock(hhmm: string | null): Date | null;
  /** The board's reminder check, now (it runs once a minute by itself). */
  remind(): Promise<void>;
  /** A new card snoozed for that many minutes, or due in that many minutes; its id. */
  snooze(minutes: number, title: string): Promise<number>;
  due(minutes: number, title: string): Promise<number>;
  /**
   * Starts a host's plan limits over at `at`, as the hub does after a sign-in to another account (`no-limits` begins
   * here; readings older than `at` would not count).
   */
  forgetLimits(host: HostId, at: Date): void;
}

const DEFAULT_AWAY_MIN = 180;
const MINUTES_MAX = 7 * 24 * 60;
/** In the owner's zone (the preview stores it as owner_tz). */
const TIME_FORMAT = ownerFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function controls(driver: Driver): Wave2Controls {
  if (driver.wave2 === null) throw new Error('This preview has no hub to run the welcome-back, clock and reminder verbs.');
  return driver.wave2;
}

function minutesArg(text: string | undefined, usage: string): number {
  const value = Number(text);
  if (text === undefined || !Number.isFinite(value) || value <= 0 || value > MINUTES_MAX) throw new Error(usage);
  return value;
}

function titleArg(words: readonly string[], usage: string): string {
  const title = words.join(' ').trim();
  if (title === '' || title.length > 300) throw new Error(usage);
  return title;
}

const awayScenario: Scenario = async (driver, [minutesText]) => {
  const minutes = minutesText === undefined ? DEFAULT_AWAY_MIN : minutesArg(minutesText, 'usage: away [minutes 31..10080]');
  controls(driver).away(minutes);
  return `Reload the office: it opens as if you were away ${minutes} minutes, with Luady's welcome-back card.`;
};

const clockScenario: Scenario = async (driver, [hhmm]) => {
  if (hhmm === undefined) throw new Error('usage: clock <HH:MM> | clock off');
  const at = controls(driver).clock(hhmm === 'off' ? null : hhmm);
  return at === null ? 'The office follows the real clock again. Reload the office.' : `The office clock shows ${TIME_FORMAT.format(at)} in owner time. Reload the office.`;
};

const lightScenario: Scenario = async (driver, [name]) => {
  if (name === 'off') return clockScenario(driver, ['off']);
  const hhmm = name === undefined ? undefined : LIGHTS[name];
  if (hhmm === undefined) throw new Error(`usage: light ${Object.keys(LIGHTS).join('|')}|off`);
  controls(driver).clock(hhmm);
  return `The office shows ${name} (${hhmm} in owner time). Reload the office.`;
};

const remindScenario: Scenario = async (driver) => {
  await controls(driver).remind();
  return 'The board looked at its snoozes and due times now.';
};

const snoozeScenario: Scenario = async (driver, [minutesText, ...words]) => {
  const usage = 'usage: snooze <minutes> <title>   (for example: snooze 0.5 Call the bank)';
  const minutes = minutesArg(minutesText, usage);
  const id = await controls(driver).snooze(minutes, titleArg(words, usage));
  return `Card #${id} is snoozed for ${minutes} minutes; "remind" after that brings it back with a notice.`;
};

const dueScenario: Scenario = async (driver, [minutesText, ...words]) => {
  const usage = 'usage: due <minutes> <title>   (for example: due 1 Send the invoice)';
  const minutes = minutesArg(minutesText, usage);
  const id = await controls(driver).due(minutes, titleArg(words, usage));
  return `Card #${id} is due in ${minutes} minutes; "remind" after that sends the due notice.`;
};

export const WAVE2_SCENARIOS: Readonly<Record<string, Scenario>> = {
  away: awayScenario,
  clock: clockScenario,
  light: lightScenario,
  remind: remindScenario,
  snooze: snoozeScenario,
  due: dueScenario,
};
