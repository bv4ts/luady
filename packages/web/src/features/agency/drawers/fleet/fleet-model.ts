import type { AccountDTO, FleetHistoryDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { formatKb } from '../../../../lib/format.js';
import { liveWindow } from '../../model/limits.js';
import { whenWords } from '../schedule/owner-time.js';

/** One reading of a series: epoch seconds and a value (null = not reported then). */
export type SeriesPoint = readonly [t: number, value: number | null];

export interface GraphBox {
  readonly width: number;
  readonly height: number;
  /** The time window shown, epoch seconds. */
  readonly from: number;
  readonly to: number;
  /** The value at the top edge (the bottom is 0). */
  readonly max: number;
}

const round1 = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * Graph points to an SVG path: x by time inside the window, y from the bottom by value (clamped to 0..max). A gap
 * (null, or a point outside the window) starts a new line with `M`. An empty string when there is nothing to draw.
 */
export function linePath(points: readonly SeriesPoint[], box: GraphBox): string {
  const span = Math.max(1, box.to - box.from);
  const top = box.max > 0 ? box.max : 1;
  let pen = false;
  const parts: string[] = [];
  for (const [t, value] of points) {
    if (value === null || t < box.from || t > box.to) {
      pen = false;
      continue;
    }
    const x = ((t - box.from) / span) * box.width;
    const y = box.height - (Math.min(Math.max(value, 0), top) / top) * box.height;
    parts.push(`${pen ? 'L' : 'M'}${round1(x)} ${round1(y)}`);
    pen = true;
  }
  return parts.join(' ');
}

/** The same line closed down to the bottom edge, for a soft fill under it (each run of points closed by itself). */
export function areaPath(points: readonly SeriesPoint[], box: GraphBox): string {
  const runs = linePath(points, box).split(/ (?=M)/).filter(Boolean);
  return runs.map((run) => {
    const coords = run.slice(1).split(/ L/).map((pair) => pair.split(' '));
    const first = coords[0]?.[0] ?? '0';
    const last = coords.at(-1)?.[0] ?? '0';
    return `${run} L${last} ${String(box.height)} L${first} ${String(box.height)} Z`;
  }).join(' ');
}

/** The top of a load graph: at least 2, else the highest load rounded up. */
export function loadMax(points: readonly SeriesPoint[]): number {
  const high = points.reduce((max, [, value]) => (value === null ? max : Math.max(max, value)), 0);
  return Math.max(2, Math.ceil(high));
}

export interface ServerSeries {
  readonly load: readonly SeriesPoint[];
  readonly mem: readonly SeriesPoint[];
  /** Null when the server does not report its disk size (a kit older than 2.1.0). */
  readonly disk: readonly SeriesPoint[] | null;
}

/** One server's three series from the history (empty when the hub has none for it yet). */
export function serverSeries(history: FleetHistoryDTO | null, name: string): ServerSeries {
  const points = history?.servers.find((server) => server.name === name)?.points ?? [];
  const reportsDisk = points.length > 0 && points.some((point) => point[3] !== null);
  return {
    load: points.map(([t, load]) => [t, load] as const),
    mem: points.map(([t, , mem]) => [t, mem] as const),
    disk: reportsDisk ? points.map(([t, , , disk]) => [t, disk] as const) : null,
  };
}

/** One account's two limit series. */
export function accountSeries(history: FleetHistoryDTO | null, id: string): { readonly fiveHour: readonly SeriesPoint[]; readonly sevenDay: readonly SeriesPoint[] } {
  const points = history?.accounts.find((account) => account.id === id)?.points ?? [];
  return { fiveHour: points.map(([t, five]) => [t, five] as const), sevenDay: points.map(([t, , week]) => [t, week] as const) };
}

/** The total disk size, when the server sends it (kit 2.1.0 and newer). */
const diskTotalKb = (sysinfo: ServerDTO['sysinfo']): number | null => {
  const total = (sysinfo as { disk_total_kb?: unknown } | null)?.disk_total_kb;
  return typeof total === 'number' && total > 0 ? total : null;
};

export interface ServerFacts {
  readonly online: boolean;
  readonly link: string;
  readonly load: string;
  readonly mem: string;
  readonly disk: string;
  readonly sessions: string;
  readonly versions: string;
}

const pct = (value: number): string => `${String(Math.round(value))}%`;

/** A server's numbers now, in words. */
export function serverFacts(server: ServerDTO, sessions: readonly SessionDTO[], now: number): ServerFacts {
  const info = server.sysinfo;
  const live = sessions.filter((session) => session.host === server.name && session.state !== 'ended').length;
  const lastSeen = server.lastSeenAt === null ? Number.NaN : Date.parse(server.lastSeenAt);
  const link = server.status === 'online' ? 'Online'
    : server.status === 'connecting' ? 'Connecting…'
      : Number.isFinite(lastSeen) ? `Offline since ${whenWords(lastSeen, now)}` : 'Offline';
  const total = diskTotalKb(info);
  const disk = info === null ? '—'
    : total === null ? `disk: ${formatKb(info.disk_free_kb)} free`
      : `disk ${pct(((total - info.disk_free_kb) / total) * 100)} · ${formatKb(info.disk_free_kb)} free`;
  return {
    online: server.status === 'online',
    link,
    load: info === null ? '—' : `load ${info.load1.toFixed(2)}`,
    mem: info === null || info.mem_total_kb <= 0 ? '—' : `memory ${pct(((info.mem_total_kb - info.mem_avail_kb) / info.mem_total_kb) * 100)}`,
    disk,
    sessions: live === 1 ? '1 session' : `${String(live)} sessions`,
    versions: [server.kitVersion === null ? 'kit ?' : `kit ${server.kitVersion}`, server.claudeVersion === null ? null : `Claude Code ${server.claudeVersion}`]
      .filter((part): part is string => part !== null).join(' · '),
  };
}

export interface LimitFact {
  readonly label: string;
  /** 0–100, or null when the window is not reported or already reset. */
  readonly pct: number | null;
  readonly text: string;
}

/** The 5-hour and weekly limits of an account with their reset times ("62% · resets 3:20 PM"). */
export function accountLimits(account: AccountDTO, now: number): readonly LimitFact[] {
  const one = (label: string, window: AccountDTO['limits']['fiveHour']): LimitFact => {
    const live = liveWindow(window, now);
    if (live === null) return { label, pct: null, text: account.limits.reported === 'no' ? 'not reported by this plan' : 'no reading' };
    return { label, pct: live.usedPct, text: `${pct(live.usedPct)} · resets ${whenWords(Date.parse(live.resetsAt), now)}` };
  };
  return [one('5-hour', account.limits.fiveHour), one('Week', account.limits.sevenDay)];
}

/** Who an account is, in the owner's words. */
export function accountName(account: AccountDTO, fallback: string): string {
  const who = account.email ?? account.orgName ?? fallback;
  return account.provider === 'codex' ? `ChatGPT · ${who}` : who;
}

/** A limit is near its end from 80%, at its end from 95% (the fleet wall's red dot). */
export function limitTone(value: number | null): 'ok' | 'warn' | 'alert' {
  if (value === null || value < 80) return 'ok';
  return value >= 95 ? 'alert' : 'warn';
}

/** The window a 24-hour graph shows, ending now. */
export function dayWindow(now: number): { readonly from: number; readonly to: number } {
  const to = Math.floor(now / 1000);
  return { from: to - 24 * 3600, to };
}
