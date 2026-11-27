import type { StepDTO } from '@luady/shared';
import { BubbleGlyph } from '../../hud/BubbleGlyph.js';
import { clock, kindIcon, stepSuffix } from './step-text.js';

/** How many recent steps the agent view lists. */
export const RECENT_STEPS = 10;

/** The last steps, newest first: kind, title, changed lines or "failed", and when it started. */
export function StepList({ steps }: { steps: readonly StepDTO[] }) {
  if (steps.length === 0) return null;
  const recent = steps.slice(-RECENT_STEPS).toReversed();
  return (
    <section className="agent-section">
      <h3 className="agent-section__title">Recent steps</h3>
      <ol className="agent-steps" aria-label="Recent steps">
        {recent.map((step) => {
          const suffix = stepSuffix(step);
          return (
            <li key={step.id} className={step.ok === false ? 'agent-step agent-step--failed' : 'agent-step'}>
              <BubbleGlyph icon={kindIcon(step.kind)} />
              <span className="agent-step__title" dir="auto">{step.title.trim() === '' ? step.tool : step.title}</span>
              {suffix === '' ? null : <span className="agent-step__suffix">{suffix}</span>}
              <time className="agent-step__time" dateTime={step.startedAt}>{clock(step.startedAt)}</time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
