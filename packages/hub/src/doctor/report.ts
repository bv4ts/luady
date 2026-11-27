import type { CheckResult, CheckState } from './types.js';

export interface DoctorReport {
  readonly checks: readonly CheckResult[];
  readonly counts: Readonly<Record<CheckState, number>>;
  /** 0 only when nothing FAILs. */
  readonly exitCode: number;
}

export interface RenderOptions {
  /** Show the private particulars (paths, names, addresses). */
  readonly full: boolean;
}

export const SAFE_NOTE = 'Safe to paste into a bug report: states and counts only, no names, addresses, e-mail, phone numbers or paths.';
export const FULL_NOTE = 'Full output: it shows names, addresses and paths. Remove the private parts before you share it.';
export const FULL_HINT = 'For names, addresses and paths: npm run doctor -- --full';

export function reportOf(checks: readonly CheckResult[]): DoctorReport {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of checks) counts[check.state] += 1;
  return { checks, counts, exitCode: counts.FAIL > 0 ? 1 : 0 };
}

/** The text report: one line per check, its fix beneath it, and (with `full`) its particulars. */
export function renderText(report: DoctorReport, options: RenderOptions): string[] {
  const lines = ['Luady doctor', options.full ? FULL_NOTE : SAFE_NOTE, ''];
  for (const check of report.checks) {
    lines.push(`${check.state.padEnd(4)}  ${check.summary}`);
    if (check.fix !== null) lines.push(`      Fix: ${check.fix}`);
    if (options.full && check.detail !== null) for (const line of check.detail.split('\n')) lines.push(`      · ${line}`);
  }
  const { PASS, WARN, FAIL } = report.counts;
  lines.push('', `${PASS} pass, ${WARN} warn, ${FAIL} fail`);
  if (!options.full) lines.push(FULL_HINT);
  return lines;
}

/** `--json`: the same checks; particulars only with `full`. */
export function renderJson(report: DoctorReport, options: RenderOptions): string {
  const checks = report.checks.map((check) => ({
    id: check.id, group: check.group, state: check.state, summary: check.summary, fix: check.fix,
    ...(options.full ? { detail: check.detail } : {}),
  }));
  return JSON.stringify({ full: options.full, counts: report.counts, exitCode: report.exitCode, checks }, null, 2);
}
