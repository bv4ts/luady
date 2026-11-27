import { isSelfHost, NAME_RE, type AskQuestion, type HostId } from '@luady/shared';
import { ACCOUNT_SCENARIOS } from './account-scenarios.ts';
import { activityScenarios, runSteps } from './activity-scenarios.ts';
import { boardItemsIn, stepCScenarios, workCards, type StepCControls } from './board-scenarios.ts';
import { WAVE2_SCENARIOS, type Wave2Controls } from './wave2-scenarios.ts';
import { targetFor, type FakeKit, type PreviewPane } from './fake-kit.ts';
import { resultsScenario, type LuadyEvents } from './luady-scenarios.ts';
import type { PreviewFleet } from './fake-fleet.ts';
import { projectCwd, promptData, SEED } from './seed.ts';

export interface Driver {
  readonly fleet: PreviewFleet;
  /** The hub's Luady, when the preview runs one (null in tests that only have a fleet). */
  readonly luady: LuadyEvents | null;
  /** Cards and Jira on the preview hub (null in tests that only have a fleet). */
  readonly stepC: StepCControls | null;
  /** The welcome-back card, day and night, reminders (null in tests that only have a fleet). */
  readonly wave2: Wave2Controls | null;
  wait(ms: number): Promise<void>;
  /** sessionRef = '<host>/<name>', for example 'cedar/meadow-vat'. */
  ref(sessionRef: string): { kit: FakeKit; pane: PreviewPane };
}
export type Scenario = (driver: Driver, args: readonly string[]) => Promise<string>;

const REPLY_DELAY_MS = 2_000;
const DEMO_STEP_MS = 4_000;
const DEMO_ASK_EVERY = 5;
/** Tool steps a session runs right after the demo sets it working (4 × 700 ms, done before the next demo step). */
const DEMO_TOOL_STEPS = 4;
const KNOWN_LIMIT = 30;
const LUADY_REPLY = 'Preview Luady: got it.';
const DEFAULT_FINISH = 'Done. All tests pass.';
const DEMO_QUESTION: readonly AskQuestion[] = [{
  question: 'Which option should I use?', header: 'Option', multiSelect: false,
  options: [{ label: 'Option A', description: 'The quick fix' }, { label: 'Option B', description: 'The clean fix' }],
}];

type Activity = 'idle' | 'working';

/** What each pane is doing as far as the preview knows (the hub keeps the real state). */
const activity = new WeakMap<FakeKit, ReadonlyMap<string, Activity>>();

function mark(kit: FakeKit, target: string, state: Activity | null): void {
  const next = new Map(activity.get(kit) ?? []);
  if (state === null) next.delete(target);
  else next.set(target, state);
  activity.set(kit, next);
}

function activityOf(kit: FakeKit, pane: PreviewPane): Activity {
  const tracked = activity.get(kit)?.get(pane.target);
  if (tracked !== undefined) return tracked;
  const seeded = SEED.find((s) => s.host === kit.host && targetFor(s.host, s.name) === pane.target);
  return seeded === undefined || seeded.state === 'idle' || seeded.state === 'error' ? 'idle' : 'working';
}

const nameOf = (target: string): string => target.replace(/:\d+\.\d+$/, '').replace(/^cc-/, '');
const refOf = (host: HostId, pane: PreviewPane): string => `${host}/${nameOf(pane.target)}`;

function knownRefs(fleet: PreviewFleet): string[] {
  return fleet.kitHosts().flatMap((host) => fleet.kit(host).panes().map((pane) => refOf(host, pane)));
}

function findRef(fleet: PreviewFleet, sessionRef: string): { kit: FakeKit; pane: PreviewPane } {
  const slash = sessionRef.indexOf('/');
  const host = sessionRef.slice(0, slash);
  if (slash > 0 && fleet.kitHosts().includes(host)) {
    const kit = fleet.kit(host);
    const pane = kit.pane(targetFor(host, sessionRef.slice(slash + 1)));
    if (pane !== undefined) return { kit, pane };
  }
  throw new Error(`unknown session "${sessionRef}". Known: ${knownRefs(fleet).slice(0, KNOWN_LIMIT).join(', ')}`);
}

/** A pane that waits for an answer cannot take a new turn, just like Claude Code. */
function idleRef(driver: Driver, sessionRef: string | undefined): { kit: FakeKit; pane: PreviewPane } {
  const found = driver.ref(sessionRef ?? '');
  if (found.pane.pendingQid !== null) {
    throw new Error(`${sessionRef} is waiting for an answer to #${found.pane.pendingQid}. Answer it on the website first.`);
  }
  return found;
}

function work(kit: FakeKit, pane: PreviewPane, text: string): void {
  kit.emit('prompt', pane.target, promptData(text));
  kit.say(pane.target, 'user', text);
  mark(kit, pane.target, 'working');
}

function finish(kit: FakeKit, pane: PreviewPane, text: string): void {
  kit.emit('stop', pane.target, { last_assistant_message: text, truncated: false });
  kit.say(pane.target, 'assistant', text);
  mark(kit, pane.target, 'idle');
}

/** A server of the preview's fleet (any host with a fake kit but the manager's own). */
function serverArg(driver: Driver, value: string | undefined): HostId {
  const servers = driver.fleet.kitHosts().filter((host) => !isSelfHost(host));
  if (value !== undefined && servers.includes(value)) return value;
  throw new Error(`unknown server "${value ?? ''}". Known: ${servers.join(', ')}`);
}

const workScenario: Scenario = async (driver, [ref, text]) => {
  const { kit, pane } = idleRef(driver, ref);
  work(kit, pane, text ?? 'Continue');
  return `${ref} is working.`;
};

const finishScenario: Scenario = async (driver, [ref, text]) => {
  const { kit, pane } = idleRef(driver, ref);
  finish(kit, pane, text ?? DEFAULT_FINISH);
  return `${ref} finished its turn.`;
};

const askScenario: Scenario = async (driver, [ref]) => {
  const { kit, pane } = idleRef(driver, ref);
  work(kit, pane, 'Continue');
  const qid = kit.ask(pane.target, DEMO_QUESTION);
  return `${ref} asks question #${qid}.`;
};

const permitScenario: Scenario = async (driver, [ref, command]) => {
  const { kit, pane } = idleRef(driver, ref);
  work(kit, pane, 'Continue');
  const qid = kit.permit(pane.target, 'Bash', command ?? 'rm -rf build');
  return `${ref} asks permission #${qid}.`;
};

const failScenario: Scenario = async (driver, [ref]) => {
  const { kit, pane } = driver.ref(ref ?? '');
  kit.emit('stop_failure', pane.target, { error: 'API Error: 500' });
  mark(kit, pane.target, 'idle');
  return `${ref} failed with an API error.`;
};

const endScenario: Scenario = async (driver, [ref]) => {
  const { kit, pane } = driver.ref(ref ?? '');
  kit.emit('session_end', pane.target, { reason: 'prompt_input_exit' });
  kit.removePane(pane.target);
  mark(kit, pane.target, null);
  return `${ref} ended and its pane is gone.`;
};

const startScenario: Scenario = async (driver, [host, name]) => {
  const server = serverArg(driver, host);
  if (name === undefined || !NAME_RE.test(name)) throw new Error('usage: start <server> <name> (letters, digits, . _ -)');
  const kit = driver.fleet.kit(server);
  if (kit.pane(targetFor(server, name)) !== undefined) throw new Error(`${server}/${name} is already running`);
  const pane = kit.addPane(name, projectCwd(name));
  kit.emit('session_start', pane.target, { source: 'startup', model: 'opus' });
  mark(kit, pane.target, 'idle');
  return `${server}/${name} started.`;
};

const statusScenario = (status: 'online' | 'offline'): Scenario => async (driver, [name]) => {
  const server = serverArg(driver, name);
  driver.fleet.setStatus(server, status);
  return `${server} is ${status}.`;
};

interface DemoState { running: boolean; stopped: boolean; next: number }
const demos = new WeakMap<PreviewFleet, DemoState>();

/** One demo step: the next session in a fixed rotation moves on (idle → working → done, every fifth step a question). */
function demoStep(driver: Driver, state: DemoState, step: number): void {
  const candidates = (['cedar', 'birch', 'ash', 'local'] as const).flatMap((host) =>
    driver.fleet.kit(host).panes().filter((pane) => pane.pendingQid === null).map((pane) => ({ kit: driver.fleet.kit(host), pane })));
  const pick = candidates[state.next % Math.max(candidates.length, 1)];
  state.next += 1;
  if (pick === undefined) return;
  const { kit, pane } = pick;
  if (activityOf(kit, pane) === 'idle') {
    work(kit, pane, 'Continue');
    runSteps(kit, pane.target, DEMO_TOOL_STEPS, driver.wait).catch(() => undefined);
  } else if (step % DEMO_ASK_EVERY === 0) kit.ask(pane.target, DEMO_QUESTION);
  else finish(kit, pane, DEFAULT_FINISH);
}

async function runDemo(driver: Driver, state: DemoState, steps: number): Promise<number> {
  let done = 0;
  while (done < steps && !state.stopped) {
    demoStep(driver, state, done + 1);
    done += 1;
    if (done < steps) await driver.wait(DEMO_STEP_MS);
  }
  return done;
}

const demoScenario: Scenario = async (driver, [secondsArg]) => {
  const seconds = secondsArg === undefined ? null : Number(secondsArg);
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) throw new Error('usage: demo [seconds]');
  if (demos.get(driver.fleet)?.running === true) return 'A demo is already running. Stop it with: npm run preview:drive -- stop-demo';
  const state: DemoState = { running: true, stopped: false, next: 0 };
  demos.set(driver.fleet, state);
  const steps = seconds === null ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor((seconds * 1000) / DEMO_STEP_MS));
  const loop = runDemo(driver, state, steps).finally(() => {
    state.running = false;
  });
  if (seconds !== null) return `Demo ran ${await loop} steps.`;
  loop.catch(() => undefined);
  return 'Demo started: a session changes every 4 seconds. Stop it with: npm run preview:drive -- stop-demo';
};

const stopDemoScenario: Scenario = async (driver) => {
  const state = demos.get(driver.fleet);
  if (state === undefined || !state.running) return 'No demo is running.';
  state.stopped = true;
  return 'Demo stopped.';
};

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  work: workScenario,
  finish: finishScenario,
  ask: askScenario,
  permit: permitScenario,
  fail: failScenario,
  end: endScenario,
  start: startScenario,
  offline: statusScenario('offline'),
  online: statusScenario('online'),
  demo: demoScenario,
  'stop-demo': stopDemoScenario,
  ...activityScenarios({ idleRef, work }),
  ...stepCScenarios({ idleRef, work, finish }),
  ...WAVE2_SCENARIOS,
  ...ACCOUNT_SCENARIOS,
  results: resultsScenario,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRunner(
  fleet: PreviewFleet, wait: (ms: number) => Promise<void> = sleep, luady: LuadyEvents | null = null, stepC: StepCControls | null = null,
  wave2: Wave2Controls | null = null,
): (scenario: string, args: readonly string[]) => Promise<string> {
  const driver: Driver = { fleet, luady, stepC, wave2, wait, ref: (sessionRef) => findRef(fleet, sessionRef) };
  return async (scenario, args) => {
    const run = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined;
    if (run === undefined) throw new Error(`unknown scenario "${scenario}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
    return run(driver, args);
  };
}

/**
 * The kit's onSend behaviour: the session takes the text as a turn and answers two seconds later. A prompt with linked
 * board cards ("Board items: #12, #15.") is worked through card by card with a report for each (board-scenarios.ts).
 */
export function replyTo(kit: FakeKit, wait: (ms: number) => Promise<void>): (target: string, text: string) => void {
  return (target, text) => {
    const pane = kit.pane(target);
    if (pane === undefined || pane.pendingQid !== null) return;
    kit.emit('prompt', target, promptData(text));
    mark(kit, target, 'working');
    if (!isSelfHost(kit.host) && boardItemsIn(text).length > 0) {
      void workCards(kit, target, text, wait, (summary) => {
        const now = kit.pane(target);
        if (now !== undefined) finish(kit, now, summary);
      });
      return;
    }
    const reply = isSelfHost(kit.host) ? LUADY_REPLY : `Preview reply to: ${text.slice(0, 80)}`;
    void wait(REPLY_DELAY_MS).then(() => {
      if (kit.pane(target) === undefined) return;
      kit.emit('stop', target, { last_assistant_message: reply, truncated: false });
      kit.say(target, 'assistant', reply);
      mark(kit, target, 'idle');
    });
  };
}
