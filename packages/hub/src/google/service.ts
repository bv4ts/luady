import { randomBytes } from 'node:crypto';
import type { Clock, Db, Logger, OutboundChannel, SettingsService } from '../core/contracts.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { clock12, inQuietHours } from '../core/time.js';
import { newMailEvent, type NewMail } from '../mail/digest.js';
import {
  accessToken, authUrl, exchangeCode, listEvents, readMail, sealer, searchMail, type CalendarEvent, type GoogleClient, type MailSummary,
} from './api.js';

export const GOOGLE_TICK_MS = 2 * 60_000;
/** Meeting reminders go out once an event starts within this window (checked every 2 minutes, so 10-12 min ahead). */
export const REMIND_AHEAD_MS = 12 * 60_000;
export const IMPORTANT_QUERY = 'in:inbox is:unread is:important newer_than:1d -category:promotions -category:social';
const STATE_TTL_MS = 10 * 60_000;
const LINK_TTL_MS = 30 * 60_000;
const LABEL_RE = /^[a-z0-9][a-z0-9 _-]{0,23}$/i;
const SNIPPET_MAX = 160;
const BODY_MAX = 8000;

export interface GoogleDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  outbound: OutboundChannel;
  /** Calendar reminders ("In 12 min"): time-critical, never held on the website. Defaults to `outbound`. */
  reminders?: OutboundChannel;
  settings: SettingsService;
  client: GoogleClient;
  /** The hub session secret; refresh tokens are sealed with a key derived from it. */
  secret: string;
  /** When set, new important mail goes to Luady, who sends the owner a short conclusion of what matters. */
  toLuady?: (text: string) => Promise<void>;
  /** An extra reminder line from earlier meetings with the same title ("↩️ Last time …"). */
  meetingContext?: (title: string, startIso: string) => string | null;
}

export interface GoogleService {
  /** A single-use code for a connect link sent on the chat (valid 30 minutes). */
  issueLink(label: string): string;
  /** The label the code was issued for, or null when unknown, used or expired. */
  consumeLink(code: string): string | null;
  /** Starts the OAuth dance for an account label ("personal", "work"); returns Google's consent URL. */
  connectUrl(label: string): string;
  finish(state: string, code: string): Promise<{ email: string; label: string }>;
  /** mail=false: a Google account without Gmail (its mail is hosted elsewhere), calendar only. */
  accounts(): Array<{ email: string; label: string; mail: boolean }>;
  search(query: string, account: string | undefined, limit: number): Promise<string>;
  read(id: string, account: string | undefined): Promise<string>;
  events(days: number, account: string | undefined): Promise<string>;
  /** Today's meetings and important unread mail, for the morning brief. */
  briefData(): Promise<string>;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

interface AccountRow { email: string; label: string; refresh_enc: string; primed: number }

function senderName(from: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (match?.[1] ?? from).trim();
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Two accounts must never share a label (alerts and account picks use it): a taken label becomes the email's domain name. */
export function distinctLabel(wanted: string, email: string, existing: ReadonlyArray<{ email: string; label: string }>): string {
  const taken = existing.some((row) => row.label === wanted && row.email !== email);
  if (!taken) return wanted;
  const domain = (email.split('@')[1] ?? '').split('.')[0] ?? '';
  return domain !== '' && domain !== 'gmail' && !existing.some((row) => row.label === domain && row.email !== email) ? domain : `${wanted}-${existing.length + 1}`;
}

export function createGoogleService(deps: GoogleDeps): GoogleService {
  const db = deps.db;
  const box = sealer(deps.secret);
  const all = db.prepare<[], AccountRow>('SELECT email, label, refresh_enc, primed FROM google_accounts ORDER BY added_at');
  const upsert = db.prepare<[string, string, string, string]>(
    `INSERT INTO google_accounts (email, label, refresh_enc, added_at, primed) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET label = excluded.label, refresh_enc = excluded.refresh_enc`,
  );
  const setPrimed = db.prepare<[string]>('UPDATE google_accounts SET primed = 1 WHERE email = ?');
  const seenMail = db.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM google_seen WHERE account = ? AND item = ?');
  const markSeen = db.prepare<[string, string, string]>('INSERT OR IGNORE INTO google_seen (account, item, seen_at) VALUES (?, ?, ?)');
  const states = new Map<string, { label: string; expires: number }>();
  const links = new Map<string, { label: string; expires: number }>();
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const now = (): Date => deps.clock.now();

  async function token(row: AccountRow): Promise<string> {
    const cached = tokens.get(row.email);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;
    const fresh = await accessToken(deps.client, box.open(row.refresh_enc));
    tokens.set(row.email, fresh);
    return fresh.token;
  }

  function pick(account: string | undefined): AccountRow[] {
    const rows = all.all();
    if (rows.length === 0) throw new NotFoundError('No Google account is connected yet. Send /google to connect one.');
    if (account === undefined || account.trim() === '') return rows;
    const wanted = account.trim().toLowerCase();
    const found = rows.filter((row) => row.email === wanted || row.label.toLowerCase() === wanted);
    if (found.length === 0) throw new NotFoundError(`No connected account "${account}". Connected: ${rows.map((r) => `${r.label} (${r.email})`).join(', ')}`);
    return found;
  }

  /** Google answers "Precondition check failed" for accounts without Gmail (e.g. mail hosted elsewhere): calendar only. */
  const noMail = (row: AccountRow): boolean => (seenMail.get(row.email, 'nomail')?.n ?? 0) > 0;
  const isNoGmail = (err: unknown): boolean => err instanceof Error && /Precondition check failed|failedPrecondition/i.test(err.message);

  async function newImportant(row: AccountRow): Promise<MailSummary[]> {
    const mails = await searchMail(await token(row), IMPORTANT_QUERY, 15);
    const fresh = mails.filter((mail) => (seenMail.get(row.email, `m:${mail.id}`)?.n ?? 0) === 0);
    for (const mail of fresh) markSeen.run(row.email, `m:${mail.id}`, now().toISOString());
    return row.primed === 1 ? fresh : [];
  }

  async function mailAlerts(rows: AccountRow[]): Promise<void> {
    const settings = deps.settings.get();
    const muted = settings.mute_until !== null && Date.parse(settings.mute_until) > now().getTime();
    let forLuady: NewMail[] = [];
    for (const row of rows) {
      if (noMail(row)) continue;
      let fresh: MailSummary[];
      try {
        fresh = await newImportant(row);
      } catch (err) {
        if (isNoGmail(err)) {
          markSeen.run(row.email, 'nomail', now().toISOString());
          setPrimed.run(row.email);
          deps.log.info({ email: row.email }, 'google: account has no Gmail, calendar only');
        } else {
          deps.log.warn({ email: row.email, err }, 'google: mail check failed');
        }
        continue;
      }
      if (row.primed === 0) setPrimed.run(row.email);
      if (fresh.length === 0 || muted || inQuietHours(now(), settings.quiet_hours)) continue;
      if (deps.toLuady !== undefined) {
        const mails = fresh.map((mail) => ({ account: row.label, from: senderName(mail.from), subject: mail.subject, snippet: mail.snippet }));
        forLuady = [...forLuady, ...mails];
        continue;
      }
      const lines = fresh.slice(0, 5).map((mail) => `📧 *${senderName(mail.from)}* · ${row.label}\n*${clip(mail.subject, 120)}*\n_${clip(mail.snippet, SNIPPET_MAX)}_`);
      const more = fresh.length > 5 ? `\n…and ${fresh.length - 5} more important emails.` : '';
      await deps.outbound.send(`${lines.join('\n\n')}${more}`, null);
    }
    if (forLuady.length > 0) await deps.toLuady?.(newMailEvent(forLuady));
  }

  function safeContext(title: string, startIso: string): string {
    try {
      return deps.meetingContext?.(title, startIso) ?? '';
    } catch (err) {
      deps.log.warn({ err }, 'google: meeting context failed');
      return '';
    }
  }

  async function meetingReminders(rows: AccountRow[]): Promise<void> {
    const from = now();
    const to = new Date(from.getTime() + REMIND_AHEAD_MS);
    for (const row of rows) {
      const events = await listEvents(await token(row), new Date(from.getTime() - 60_000).toISOString(), to.toISOString())
        .catch((err: unknown) => {
          deps.log.warn({ email: row.email, err }, 'google: calendar check failed');
          return [] as CalendarEvent[];
        });
      for (const event of events.filter((e) => !e.allDay)) {
        const key = `e:${event.id}:${event.start}`;
        if ((seenMail.get(row.email, key)?.n ?? 0) > 0) continue;
        markSeen.run(row.email, key, now().toISOString());
        const start = new Date(event.start);
        const minutes = Math.max(0, Math.round((start.getTime() - from.getTime()) / 60_000));
        const where = event.link ? `🔗 ${event.link}` : event.location ? `📍 ${event.location}` : '';
        const before = safeContext(event.title, event.start);
        await (deps.reminders ?? deps.outbound).send([`📅 *In ${minutes} min* · ${clock12(start)} · ${row.label}`, `*${event.title}*`, where, before].filter(Boolean).join('\n'), null);
      }
    }
  }

  async function tick(): Promise<void> {
    const rows = all.all();
    if (rows.length === 0) return;
    await meetingReminders(rows).catch((err: unknown) => deps.log.warn({ err }, 'google: calendar check failed'));
    await mailAlerts(rows).catch((err: unknown) => deps.log.warn({ err }, 'google: mail check failed'));
  }

  function eventLine(event: CalendarEvent, label: string): string {
    const when = event.allDay ? 'all day' : `${clock12(new Date(event.start))}–${clock12(new Date(event.end))}`;
    return `- ${when} · ${event.title} (${label})${event.link ? ` · ${event.link}` : ''}`;
  }

  return {
    issueLink(label) {
      if (!LABEL_RE.test(label)) throw new ValidationError('Account label: letters, digits, space, _ or -, up to 24 characters');
      for (const [key, value] of links) if (value.expires < Date.now()) links.delete(key);
      const code = randomBytes(24).toString('base64url');
      links.set(code, { label: label.toLowerCase(), expires: Date.now() + LINK_TTL_MS });
      return code;
    },
    consumeLink(code) {
      const link = links.get(code);
      links.delete(code);
      return link === undefined || link.expires < Date.now() ? null : link.label;
    },
    connectUrl(label) {
      if (!LABEL_RE.test(label)) throw new ValidationError('Account label: letters, digits, space, _ or -, up to 24 characters');
      for (const [key, value] of states) if (value.expires < Date.now()) states.delete(key);
      const state = randomBytes(24).toString('base64url');
      states.set(state, { label: label.toLowerCase(), expires: Date.now() + STATE_TTL_MS });
      return authUrl(deps.client, state);
    },
    async finish(state, code) {
      const pending = states.get(state);
      states.delete(state);
      if (pending === undefined || pending.expires < Date.now()) throw new ValidationError('This connect link expired; send /google and try again');
      const { refreshToken, email } = await exchangeCode(deps.client, code);
      const label = distinctLabel(pending.label, email, all.all());
      upsert.run(email, label, box.seal(refreshToken), now().toISOString());
      tokens.delete(email);
      deps.log.info({ email, label }, 'google: account connected');
      return { email, label };
    },
    accounts: () => all.all().map((row) => ({ email: row.email, label: row.label, mail: !noMail(row) })),
    async search(query, account, limit) {
      const lines: string[] = [];
      for (const row of pick(account).filter((r) => !noMail(r))) {
        for (const mail of await searchMail(await token(row), query, limit)) {
          lines.push(`- [${row.label}] ${mail.id} · ${mail.date.slice(0, 22)} · ${senderName(mail.from)} · ${clip(mail.subject, 100)} — ${clip(mail.snippet, 120)}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : `No emails match "${query}".`;
    },
    async read(id, account) {
      for (const row of pick(account).filter((r) => !noMail(r))) {
        try {
          const mail = await readMail(await token(row), id);
          return `[${row.label}] From: ${mail.from}\nSubject: ${mail.subject}\nDate: ${mail.date}\n\n${clip(mail.body, BODY_MAX)}`;
        } catch {
          continue;
        }
      }
      throw new NotFoundError(`No email ${id} in the connected accounts`);
    },
    async events(days, account) {
      const from = now();
      const to = new Date(from.getTime() + days * 24 * 60 * 60_000);
      const lines: string[] = [];
      for (const row of pick(account)) {
        for (const event of await listEvents(await token(row), from.toISOString(), to.toISOString())) lines.push(eventLine(event, row.label));
      }
      return lines.length > 0 ? lines.sort().join('\n') : `No events in the next ${days} day(s).`;
    },
    async briefData() {
      const rows = all.all();
      if (rows.length === 0) return 'No Google account connected.';
      const start = now();
      const end = new Date(start.getTime() + 18 * 60 * 60_000);
      const meetings: string[] = [];
      const mail: string[] = [];
      for (const row of rows) {
        const t = await token(row);
        for (const event of await listEvents(t, start.toISOString(), end.toISOString())) meetings.push(eventLine(event, row.label));
        if (!noMail(row)) for (const m of await searchMail(t, IMPORTANT_QUERY, 10)) mail.push(`- [${row.label}] ${senderName(m.from)}: ${clip(m.subject, 100)}`);
      }
      return [`## Meetings today\n${meetings.join('\n') || '- none'}`, `## Important unread email\n${mail.join('\n') || '- none'}`].join('\n\n');
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        tick().catch((err: unknown) => deps.log.warn({ err }, 'google: tick failed'));
      }, GOOGLE_TICK_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
