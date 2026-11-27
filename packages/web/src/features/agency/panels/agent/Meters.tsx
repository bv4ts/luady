import type { SessionDetailDTO, SessionDTO } from '@luady/shared';
import type { CSSProperties } from 'react';
import { useStore } from '../../../../state/store.js';
import { accountOfHost, shortLimits } from '../../model/limits.js';

/** The fill of a bar as a CSS custom property, set through the CSSOM like the team colours. */
const fill = (pct: number): CSSProperties => ({ '--fill': `${Math.max(0, Math.min(100, pct))}%` }) as CSSProperties;

/**
 * How full the agent's context window is (with its model) and the limit of the account its server uses.
 * Each part is hidden while there is no reading; a limit that is not reported is simply not shown here.
 */
export function Meters({ session, detail }: { session: SessionDTO; detail: SessionDetailDTO | null }) {
  const { state } = useStore();
  const context = detail?.meters?.contextPct ?? null;
  const model = detail?.meters?.model ?? null;
  const limits = shortLimits(accountOfHost(state.accounts?.accounts, session.host), Date.now());
  if (context === null && model === null && limits === null) return null;
  return (
    <dl className="agent-meters" aria-label="Meters">
      {context === null && model === null ? null : (
        <div className="agent-meters__row">
          <dt>Context</dt>
          <dd className="agent-meters__value">
            {context === null ? null : (
              <>
                <span className={context >= 90 ? 'agent-bar agent-bar--hot' : 'agent-bar'} style={fill(context)} aria-hidden="true" />
                <span>{`${Math.round(context)}%`}</span>
              </>
            )}
            {model === null ? null : <span className="agent-meters__model">{model}</span>}
          </dd>
        </div>
      )}
      {limits === null ? null : (
        <div className="agent-meters__row">
          <dt>Limits</dt>
          <dd className="agent-meters__value">{limits}</dd>
        </div>
      )}
    </dl>
  );
}
