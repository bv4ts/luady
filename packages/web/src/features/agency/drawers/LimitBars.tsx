import type { AccountLimitsDTO, RateWindowDTO } from '@luady/shared';
import type { CSSProperties } from 'react';
import { liveWindow } from '../model/limits.js';
import { limitLine, limitsNote } from './account-text.js';

const fill = (pct: number): CSSProperties => ({ '--fill': `${Math.max(0, Math.min(100, pct))}%` }) as CSSProperties;
const tone = (pct: number): string => (pct >= 95 ? 'acct-bar--red' : pct >= 85 ? 'acct-bar--amber' : '');

/** One window: a bar only while it is reported and still running, its line in words always. */
function Window({ label, window, now }: { label: string; window: RateWindowDTO | null; now: Date }) {
  const running = liveWindow(window, now.getTime());
  return (
    <div className="acct-limit">
      <p className="acct-limit__line">{limitLine(label, window, now)}</p>
      {running === null ? null : (
        <div className={`acct-bar ${tone(running.usedPct)}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(running.usedPct)} style={fill(running.usedPct)} />
      )}
    </div>
  );
}

/** Both limit windows of an account, or the note saying why there are none. */
export function LimitBars({ limits, now }: { limits: AccountLimitsDTO; now: Date }) {
  const note = limitsNote(limits);
  if (note !== null) return <p className="acct__note">{note}</p>;
  return (
    <div className="acct__limits">
      <Window label="5-hour limit" window={limits.fiveHour} now={now} />
      <Window label="Weekly limit" window={limits.sevenDay} now={now} />
    </div>
  );
}
