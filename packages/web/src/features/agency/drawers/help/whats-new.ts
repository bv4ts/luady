import { managerName } from '@luady/shared';
/** What changed in the office, newest first. Add an entry with every release; keep each line short and plain. */
export interface WhatsNewEntry {
  readonly title: string;
  /** YYYY-MM-DD (owner time). */
  readonly date: string;
  readonly items: readonly string[];
}

export const WHATS_NEW: readonly WhatsNewEntry[] = Object.freeze([
  {
    title: 'More things in HQ',
    date: '2026-11-15',
    items: [
      `Welcome back: after half an hour away, ${managerName()} hands you one card with what finished, what broke and what waits for you.`,
      'The TV on HQ’s wall shows every server and account with the last 24 hours.',
      'The wins board shows what shipped this week; the clock opens today as one strip.',
      `The calendar holds ${managerName()}’s reminders and timed jobs; add or cancel one there.`,
      'Each office has a links board for your own quick links.',
      'Every desk monitor shows how full the session’s context is; from 60% you can compact it.',
      'Day and night: the office follows owner time, and HQ dims in your quiet hours. Turn it off in Settings.',
      'Soft sounds for a new message, done, needs you and an arrival. M or the speaker mutes them.',
      'Cards can wait: “Remind me…” hides one until later, and a due date turns red when it passes.',
      'This robot explains every part of the office.',
    ],
  },
  {
    title: 'The working HQ',
    date: '2026-11-15',
    items: [
      'The office fills the screen, with a garden around the building.',
      `The board in HQ: cards from anywhere, run several at once, and ${managerName()} puts them in the right sessions.`,
      'Notes, the library with the knowledge base, and Jira boards for your offices.',
      `Agents say what they finished in a bubble above them; ${managerName()}’s whole answer shows above him.`,
      'The chat opens into the full conversation; the pill in the top bar says how many are working.',
    ],
  },
]);
