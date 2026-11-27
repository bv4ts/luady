import type { HostId } from '@luady/shared';
import type { FakeKit, PreviewPane } from './fake-kit.ts';
import type { Driver, Scenario } from './scenarios.ts';

const HOUR_MS = 3_600_000;
/** The hub decides "this plan does not report limits" after five readings without any window. */
const EMPTY_READINGS = 5;
const READING_GAP_MS = 1_000;
const LIMITS_USAGE = 'usage: limits <host> <5-hour%> <7-day%> (host cedar, birch, ash, local or luady; numbers 0..100)';
const NO_LIMITS_USAGE = 'usage: no-limits <host> (cedar, birch, ash, local or luady)';
const SIGNOUT_USAGE = 'usage: signout <host> (cedar, birch, ash, local or luady)';

/** A host of the preview's fleet (any host with a fake kit, the manager's own included). */
function hostArg(driver: Driver, text: string | undefined, usage: string): HostId {
  if (text !== undefined && driver.fleet.kitHosts().includes(text)) return text;
  throw new Error(usage);
}

function pctArg(text: string | undefined): number {
  const value = Number(text);
  if (text === undefined || text === '' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(LIMITS_USAGE);
  return value;
}

/** Meters come from a session's status line, so the host needs a pane. */
function firstPane(driver: Driver, host: HostId): { kit: FakeKit; pane: PreviewPane } {
  const kit = driver.fleet.kit(host);
  const pane = kit.panes()[0];
  if (pane === undefined) throw new Error(`${host} has no session to report meters from. Start one first.`);
  return { kit, pane };
}

const window = (usedPct: number, resetsAtMs: number) => ({ used_pct: usedPct, resets_at: new Date(resetsAtMs).toISOString() });

const limitsScenario: Scenario = async (driver, [hostText, fiveText, sevenText]) => {
  const host = hostArg(driver, hostText, LIMITS_USAGE);
  const [five, seven] = [pctArg(fiveText), pctArg(sevenText)];
  const { kit, pane } = firstPane(driver, host);
  const at = Date.now();
  kit.emit('meters', pane.target, {
    context_pct: 30, model: 'Opus', cost_usd: 0.5, five_hour: window(five, at + 2 * HOUR_MS), seven_day: window(seven, at + 72 * HOUR_MS),
  });
  return `${host} reports its plan limits: 5-hour ${five}%, week ${seven}%.`;
};

const noLimitsScenario: Scenario = async (driver, [hostText]) => {
  const host = hostArg(driver, hostText, NO_LIMITS_USAGE);
  const { kit, pane } = firstPane(driver, host);
  // A host that ever reported limits keeps them (the hub's rule), and the preview seeds a day of them: start the host
  // over first, as the hub does after a sign-in to another account.
  driver.wave2?.forgetLimits(host, new Date(Date.now() - EMPTY_READINGS * READING_GAP_MS));
  // A second apart, oldest first, like real status-line readings (the hub counts a replayed reading once).
  for (let i = 0; i < EMPTY_READINGS; i += 1) {
    const ageMs = (EMPTY_READINGS - 1 - i) * READING_GAP_MS;
    kit.emit('meters', pane.target, { context_pct: 10 + i, model: 'Opus', cost_usd: 0.1, five_hour: null, seven_day: null }, { ageMs });
  }
  return `${host} sent ${EMPTY_READINGS} readings without limits: its plan does not report them.`;
};

const signoutScenario: Scenario = async (driver, [hostText]) => {
  const host = hostArg(driver, hostText, SIGNOUT_USAGE);
  driver.fleet.kit(host).signOut();
  return `${host} is signed out of Claude. The hub sees it at its next check, or press Refresh in Accounts.`;
};

/** Accounts: plan limits per host and a sign-in that ends at the terminal. */
export const ACCOUNT_SCENARIOS: Readonly<Record<string, Scenario>> = {
  limits: limitsScenario,
  'no-limits': noLimitsScenario,
  signout: signoutScenario,
};
