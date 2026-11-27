import type { SessionState } from '@luady/shared';
import type { ReactNode } from 'react';
import { STATE_LABEL, STATE_TONE, type Tone } from './tones.js';

export function Badge({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge tone-${tone}`}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function StateBadge({ state }: { state: SessionState }) {
  return <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
}
