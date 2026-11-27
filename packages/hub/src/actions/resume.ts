/** What a resume did, from the kit's reply: the pause had stopped the agent (`wasHit`), and the resume text was typed (`sent`). */
export interface ResumeOutcome { readonly wasHit: boolean; readonly sent: boolean }

const RESUMED = 'resumed';
const STILL_WORKING = 'pause lifted; the agent was still working';
const IDLE = 'pause lifted; the agent was idle';

/** The action result of a resume; `resumeOf` reads it back exactly (both live here so they cannot drift apart). */
export function resumeText(outcome: ResumeOutcome): string {
  if (outcome.sent) return RESUMED;
  return outcome.wasHit ? IDLE : STILL_WORKING;
}

export function resumeOf(text: string | null): ResumeOutcome | undefined {
  if (text === RESUMED) return { wasHit: true, sent: true };
  if (text === STILL_WORKING) return { wasHit: false, sent: false };
  if (text === IDLE) return { wasHit: true, sent: false };
  return undefined;
}
