import { SELF_HOST_ID } from '@luady/shared';
import type { FakeKit, PreviewPane } from './fake-kit.ts';
import type { Driver, Scenario } from './scenarios.ts';
import { promptData } from './seed.ts';

/** Drive verbs for speech, reports, Luady's chat, cards and Jira, and the fake worker that ticks linked cards. */

/** What the preview hub lets these verbs do; null in tests that run only a fleet. */
export interface StepCControls {
  addCard(title: string): Promise<number>;
  jiraOff(): Promise<void>;
  jiraOn(): Promise<void>;
}

export interface WorkerHelpers {
  idleRef(driver: Driver, sessionRef: string | undefined): { kit: FakeKit; pane: PreviewPane };
  work(kit: FakeKit, pane: PreviewPane, text: string): void;
  finish(kit: FakeKit, pane: PreviewPane, text: string): void;
}

/** Time between two cards a fake session reports done. */
export const CARD_STEP_MS = 3_000;
const SAY_WORK_MS = 800;
const LUADY_TYPING_MS = 1_500;
const TITLE_MAX = 300;

/** The ids of the hub's "Board items: #12, #15." paragraph (board/reports.ts), in order. */
export function boardItemsIn(text: string): number[] {
  const list = /Board items: ((?:#\d+(?:, )?)+)\./.exec(text)?.[1];
  return list === undefined ? [] : [...list.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/** Card titles from the numbered checklist of a session prompt (`1. #12 Fix the total`). */
export function checklistTitles(text: string): ReadonlyMap<number, string> {
  return new Map([...text.matchAll(/^\s*\d+\.\s+#(\d+)\s+(.+)$/gm)].map((m) => [Number(m[1]), m[2]!.trim()]));
}

/**
 * A session that got linked cards works through them: one `luady-report "#id done: …"` every few seconds (what the
 * hub ticks them from), then it finishes its turn. Stops early when its pane goes away or starts waiting.
 */
export async function workCards(
  kit: FakeKit, target: string, text: string, wait: (ms: number) => Promise<void>, finish: (summary: string) => void,
): Promise<void> {
  const ids = boardItemsIn(text);
  const titles = checklistTitles(text);
  for (const id of ids) {
    await wait(CARD_STEP_MS);
    if (kit.pane(target)?.pendingQid !== null) return;
    const what = titles.get(id) ?? 'the item';
    kit.emit('report', target, { text: `#${id} done: ${what}: changed and tested in the preview.` });
  }
  await wait(CARD_STEP_MS / 3);
  if (kit.pane(target)?.pendingQid !== null) return;
  finish(`Done: ${ids.map((id) => `#${id}`).join(', ')}. Every card is reported and the tests pass.`);
}

const joined = (words: readonly string[]): string => words.join(' ').trim();

function textArg(words: readonly string[], usage: string): string {
  const text = joined(words);
  if (text === '' || text.length > 2_000) throw new Error(usage);
  return text;
}

function controls(driver: Driver): StepCControls {
  if (driver.stepC === null) throw new Error('This preview has no hub to add cards or switch Jira.');
  return driver.stepC;
}

export function stepCScenarios(helpers: WorkerHelpers): Readonly<Record<string, Scenario>> {
  /** The session finishes a turn with this message: its speech bubble opens. An idle one works a moment first. */
  const say: Scenario = async (driver, [ref, ...words]) => {
    const text = textArg(words, 'usage: say <host/name> <text>');
    const { kit, pane } = helpers.idleRef(driver, ref);
    helpers.work(kit, pane, 'Continue');
    await driver.wait(SAY_WORK_MS);
    helpers.finish(kit, pane, text);
    return `${ref} says: ${text}`;
  };
  /** A mid-turn `luady-report` line, e.g. "#12 done: fixed" (ticks a linked card) or any short news. */
  const report: Scenario = async (driver, [ref, ...words]) => {
    const text = textArg(words, 'usage: report <host/name> <text>   (for example "#12 done: fixed")');
    const { kit, pane } = driver.ref(ref ?? '');
    kit.emit('report', pane.target, { text });
    return `${ref} reports: ${text}`;
  };
  /** Luady takes a turn and answers with this text in the chat (typing first). */
  const luadySay: Scenario = async (driver, words) => {
    const text = textArg(words, 'usage: luady-say <text>');
    const kit = driver.fleet.kit(SELF_HOST_ID);
    const pane = kit.panes()[0];
    if (pane === undefined) throw new Error('Luady is not running in this preview.');
    kit.emit('prompt', pane.target, promptData('(preview: luady-say)'));
    await driver.wait(LUADY_TYPING_MS);
    kit.emit('stop', pane.target, { last_assistant_message: text, truncated: false });
    kit.say(pane.target, 'assistant', text);
    return `Luady says: ${text}`;
  };
  const card: Scenario = async (driver, words) => {
    const title = textArg(words, 'usage: card <title>');
    if (title.length > TITLE_MAX) throw new Error(`A card title is at most ${TITLE_MAX} characters.`);
    const id = await controls(driver).addCard(title);
    return `Added card #${id}: ${title}`;
  };
  const jiraOff: Scenario = async (driver) => {
    await controls(driver).jiraOff();
    return 'Jira is disconnected for Orchard: the Jira pop-up shows the connect form.';
  };
  const jiraOn: Scenario = async (driver) => {
    await controls(driver).jiraOn();
    return 'Jira is connected for Orchard again.';
  };
  return { say, report, 'luady-say': luadySay, card, 'jira-off': jiraOff, 'jira-on': jiraOn };
}
