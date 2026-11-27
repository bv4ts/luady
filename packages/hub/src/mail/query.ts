/** What an IMAP mailbox can search for; built from the Gmail-style queries Luady writes. */
export interface MailQuery {
  from?: string;
  to?: string;
  subject?: string;
  /** Plain words, matched anywhere in the headers or body. */
  text?: string;
  since?: Date;
  before?: Date;
  seen?: boolean;
}

const TOKEN_RE = /(-?)(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };
/** Gmail operators an IMAP server has no answer for: dropped instead of searched as words. */
const IGNORED = new Set(['in', 'label', 'has', 'category', 'filename', 'larger', 'smaller', 'list', 'cc', 'bcc', 'deliveredto']);
const NOISE = new Set(['or', 'and']);

function age(value: string, now: Date): Date | undefined {
  const m = /^(\d{1,4})([hdmy])$/i.exec(value);
  return m === null ? undefined : new Date(now.getTime() - Number(m[1]) * (UNIT_MS[m[2]!.toLowerCase()] ?? 0));
}

function day(value: string): Date | undefined {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  return m === null ? undefined : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Translates Gmail search syntax (from:, subject:, newer_than:7d, after:2026/10/01, is:unread…) into IMAP criteria. */
export function parseMailQuery(query: string, now: Date): MailQuery {
  const out: MailQuery = {};
  const words: string[] = [];
  for (const match of query.matchAll(TOKEN_RE)) {
    const [, negated, rawKey, rawValue, phrase, word] = match;
    if (rawKey === undefined) {
      const text = (phrase ?? word ?? '').trim();
      if (text !== '' && !NOISE.has(text.toLowerCase())) words.push(text);
      continue;
    }
    if (negated === '-') continue;
    const key = rawKey.toLowerCase();
    const value = (rawValue ?? '').replace(/^"|"$/g, '');
    if (key === 'from' || key === 'to' || key === 'subject') out[key] = value;
    else if (key === 'newer_than' || key === 'newer') out.since = age(value, now);
    else if (key === 'older_than' || key === 'older') out.before = age(value, now);
    else if (key === 'after' || key === 'since') out.since = day(value);
    else if (key === 'before') out.before = day(value);
    else if (key === 'is' && /^(unread|read)$/i.test(value)) out.seen = value.toLowerCase() === 'read';
    else if (!IGNORED.has(key) && key !== 'is') words.push(`${rawKey}:${value}`);
  }
  if (words.length > 0) out.text = words.join(' ');
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as MailQuery;
}
