import { areaPath, linePath, type SeriesPoint } from './fleet-model.js';

const W = 120;
const H = 28;

export interface SparklineProps {
  readonly points: readonly SeriesPoint[];
  readonly from: number;
  readonly to: number;
  readonly max: number;
  /** What the graph shows, for screen readers ("Load over the last 24 hours"). */
  readonly label: string;
  readonly tone?: 'ok' | 'warn' | 'alert';
  /** A dashed line at this value (a limit's 80% mark). */
  readonly mark?: number;
}

/** A 24-hour graph as inline SVG: a soft area, the line, and its last value as a dot. */
export function Sparkline({ points, from, to, max, label, tone = 'ok', mark }: SparklineProps) {
  const box = { width: W, height: H, from, to, max };
  const line = linePath(points, box);
  const last = points.findLast(([t, value]) => value !== null && t >= from && t <= to);
  const lastX = last === undefined ? null : ((last[0] - from) / Math.max(1, to - from)) * W;
  const lastY = last?.[1] == null ? null : H - (Math.min(last[1], max) / (max || 1)) * H;
  if (line === '') return <span className="fleet-spark fleet-spark--empty" role="img" aria-label={`${label}: no readings yet`}>no readings yet</span>;
  return (
    <svg className={`fleet-spark fleet-spark--${tone}`} viewBox={`0 0 ${String(W)} ${String(H)}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {mark === undefined ? null : (
        <line className="fleet-spark__mark" x1="0" x2={W} y1={H - (mark / (max || 1)) * H} y2={H - (mark / (max || 1)) * H} />
      )}
      <path className="fleet-spark__area" d={areaPath(points, box)} />
      <path className="fleet-spark__line" d={line} />
      {lastX === null || lastY === null ? null : <circle className="fleet-spark__dot" cx={lastX} cy={lastY} r="1.8" />}
    </svg>
  );
}
