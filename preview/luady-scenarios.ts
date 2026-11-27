import type { Scenario } from './scenarios.ts';

/** The part of the hub's Luady service the preview may use: an event turn, as when a session he watches finishes. */
export interface LuadyEvents {
  postEvent(text: string): Promise<void>;
}

const RESULTS_USAGE = 'usage: results [count 1..10]';
const MAX_RESULTS = 10;
/** Luady takes one turn at a time and the fake brain answers after two seconds. */
const EVENT_GAP_MS = 3_000;
const WHAT = ['the payroll export finished', 'the nightly backup is done', 'the release notes are written', 'the tests pass again'];

function countArg(text: string | undefined): number {
  const count = text === undefined ? 1 : Number(text);
  if (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS) throw new Error(RESULTS_USAGE);
  return count;
}

/** Luady starts that many updates himself (results): each event gets his reply, which the hub routes as a result. */
export const resultsScenario: Scenario = async (driver, [countText]) => {
  const count = countArg(countText);
  if (driver.luady === null) throw new Error('This preview has no Luady to post events to.');
  for (let i = 0; i < count; i += 1) {
    if (i > 0) await driver.wait(EVENT_GAP_MS);
    await driver.luady.postEvent(`Preview event ${i + 1}: ${WHAT[i % WHAT.length] ?? 'done'}. Tell the owner in one line.`);
  }
  return `Posted ${count} events to Luady; each reply is a result notice.`;
};
