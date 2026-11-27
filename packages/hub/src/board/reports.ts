/** `luady-report` lines about board cards: `#12 done: …`, `#12 blocked: …`, `#12 progress: …`. */

export type ReportVerb = 'done' | 'blocked' | 'progress';

export interface CardReport {
  readonly id: number;
  readonly verb: ReportVerb;
  readonly text: string;
}

const LINE_RE = /^[\s>*-]*#\s*(\d{1,12})\s+(done|blocked|progress)\s*:\s*(.*)$/i;

/** Every card line of a report, in order; other lines are ignored. Case and spacing do not matter. */
export function parseCardReports(text: string): CardReport[] {
  return text.split(/\r?\n/).flatMap((line): CardReport[] => {
    const match = LINE_RE.exec(line.trim());
    if (match === null) return [];
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return [{ id, verb: (match[2] ?? '').toLowerCase() as ReportVerb, text: (match[3] ?? '').trim() }];
  });
}

const REPORT_CMD = '~/.luady/bin/luady-report';

/** The paragraph a prompt gains when cards are linked to the session it goes to. */
export function boardItemsParagraph(ids: readonly number[]): string {
  if (ids.length === 0) return '';
  const first = ids[0];
  return [
    `Board items: ${ids.map((id) => `#${id}`).join(', ')}. Work through them in order.`,
    `After each one, run \`${REPORT_CMD} "#${first} done: <one line>"\` (with that item's number).`,
    `If one is blocked, run \`${REPORT_CMD} "#${first} blocked: <why>"\` and carry on with the next.`,
  ].join(' ');
}
