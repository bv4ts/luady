import type { SessionDetailDTO, SessionDTO } from '@luady/shared';
import { BubbleGlyph } from '../../hud/BubbleGlyph.js';
import { currentLine } from './step-text.js';

/** What the agent is doing right now: the map's bubble and the step title (or the state in words). */
export function CurrentStep({ session, detail }: { session: SessionDTO; detail: SessionDetailDTO | null }) {
  const line = currentLine({ state: session.state, detail });
  return (
    <p className="agent-now" data-testid="current-step">
      {line.icon === null ? null : <BubbleGlyph icon={line.icon} />}
      <span className="agent-now__text" dir="auto">{line.text}</span>
    </p>
  );
}
