import type { CSSProperties } from 'react';
import type { Energy } from '../model/energy.js';
import { formatClock } from './Clock.js';

const fill = (pct: number): CSSProperties => ({ '--fill': `${Math.max(0, Math.min(100, pct))}%` }) as CSSProperties;

/** The fullest account (or the focused room's) as a small bar: "cedar 62%". Opens Accounts and limits. Nothing without a reading. */
export function EnergyBar({ energy, onOpen }: { energy: Energy | null; onOpen: () => void }) {
  if (energy === null) return null;
  const resets = Date.parse(energy.resetsAt);
  const when = Number.isFinite(resets) ? formatClock(resets) : 'soon';
  return (
    <button type="button" className={`agency-energy agency-energy--${energy.tone}`} data-testid="energy-bar"
      title={`5-hour limit resets ${when}`}
      aria-label={`${energy.label}: ${energy.usedPct}% of the 5-hour limit used, resets ${when}. Open accounts and limits`}
      onClick={onOpen}>
      <span className="agency-energy__label">{energy.label}</span>
      <span className="agency-energy__bar" style={fill(energy.usedPct)} aria-hidden="true" />
      <span className="agency-energy__pct">{`${energy.usedPct}%`}</span>
    </button>
  );
}
