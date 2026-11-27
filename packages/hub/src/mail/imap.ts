import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Clock, Db, Logger, OutboundChannel, SettingsService } from '../core/contracts.js';
import { NotFoundError } from '../core/errors.js';
import { inQuietHours } from '../core/time.js';
import { newMailEvent } from './digest.js';
import { htmlToText } from './mail-text.js';
import { parseMailQuery, type MailQuery } from './query.js';

export interface ImapAccount { host: string; port: number; user: string; password: string; label: string }

export interface ImapDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  outbound: OutboundChannel;
  settings: SettingsService;
  account: ImapAccount;
  /** Tests swap the IMAP client. */
  connect?: (account: ImapAccount) => Promise<ImapSession>;
  /** When set, new personal mail goes to Luady, who sends the owner a short conclusion of what matters. */
  toLuady?: (text: string) => Promise<void>;
}

const LUADY_MAILS_MAX = 5;
const SNIPPET_MAX = 200;

export interface ImapMessage { uid: number; from: string; subject: string; date: string; bulk: boolean }

/** The part of an IMAP connection the service uses; `connectImap` builds it on imapflow. */
export interface ImapSession {
  unseen(since: Date): Promise<ImapMessage[]>;
  search(query: MailQuery, limit: number): Promise<ImapMessage[]>;
  source(uid: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

export interface ImapService {
  label: string;
  /** The mailbox address, shown to Luady so it knows which mailbox this is. */
  user: string;
  search(query: string, limit: number): Promise<string[]>;
  /** id is "imap:<uid>". */
  read(id: string): Promise<string>;
  briefLines(): Promise<string[]>;
  tick(): Promise<void>;
}

const DAY_MS = 24 * 60 * 60_000;
const BODY_MAX = 8000;
const BULK_HEADER_RE = /^(list-unsubscribe|list-id):|^precedence:\s*(bulk|list|junk)|^auto-submitted:\s*auto-/im;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function toMessage(msg: FetchMessageObject): ImapMessage {
  const from = msg.envelope?.from?.[0];
  return {
    uid: msg.uid,
    from: from?.name || from?.address || '(unknown sender)',
    subject: msg.envelope?.subject ?? '(no subject)',
    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '',
    bulk: BULK_HEADER_RE.test(msg.headers?.toString('utf8') ?? '') || /no-?reply|mailer-daemon/i.test(from?.address ?? ''),
  };
}

const QUERY = { uid: true, envelope: true, headers: ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted'] } as const;

/** One short-lived connection per use (every 2 minutes at most): no idle socket to babysit. */
export async function connectImap(account: ImapAccount, log: Logger): Promise<ImapSession> {
  const client = new ImapFlow({
    host: account.host, port: account.port, secure: account.port === 993, auth: { user: account.user, pass: account.password },
    logger: false, socketTimeout: 60_000,
  });
  // An 'error' event with no listener kills the hub (a dropped socket raises one); the pending call still rejects.
  client.on('error', (err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err), mailbox: account.label }, 'imap: connection error');
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  async function collect(uids: number[] | false | undefined, limit: number): Promise<ImapMessage[]> {
    const wanted = (uids || []).slice(-limit);
    if (wanted.length === 0) return [];
    const out: ImapMessage[] = [];
    for await (const msg of client.fetch(wanted, { ...QUERY, headers: [...QUERY.headers] }, { uid: true })) out.push(toMessage(msg));
    return out;
  }
  return {
    unseen: async (since) => collect(await client.search({ seen: false, since }, { uid: true }), 50),
    search: async (query, limit) => collect(await client.search(Object.keys(query).length === 0 ? { all: true } : { ...query }, { uid: true }), limit),
    source: async (uid) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return msg === false || msg === undefined ? null : msg.source ?? null;
    },
    close: async () => {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
}

/** A non-Google mailbox (cPanel, Zoho, Fastmail…) over IMAP: alerts for new personal mail, search and read for Luady. */
export function createImapService(deps: ImapDeps): ImapService {
  const connect = deps.connect ?? ((account: ImapAccount) => connectImap(account, deps.log));
  const key = `imap:${deps.account.user}`;
  const seen = deps.db.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM google_seen WHERE account = ? AND item = ?');
  const any = deps.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM google_seen WHERE account = ?');
  const mark = deps.db.prepare<[string, string, string]>('INSERT OR IGNORE INTO google_seen (account, item, seen_at) VALUES (?, ?, ?)');
  const label = deps.account.label;

  async function withSession<T>(work: (session: ImapSession) => Promise<T>): Promise<T> {
    const session = await connect(deps.account);
    try {
      return await work(session);
    } finally {
      await session.close();
    }
  }

  /** The start of each message's text, so Luady can judge it; empty when the server can't give it now. */
  async function bodySnippets(uids: readonly number[]): Promise<Map<number, string>> {
    try {
      return await withSession(async (s) => {
        const out = new Map<number, string>();
        for (const uid of uids) {
          const source = await s.source(uid);
          if (source !== null) out.set(uid, clip((await simpleParser(source)).text ?? '', SNIPPET_MAX));
        }
        return out;
      });
    } catch (err) {
      deps.log.warn({ err }, 'imap: could not read new mail text');
      return new Map();
    }
  }

  const line = (m: ImapMessage): string => `- [${label}] imap:${m.uid} · ${m.date.slice(0, 16).replace('T', ' ')} · ${m.from} · ${clip(m.subject, 100)}`;

  return {
    label,
    user: deps.account.user,
    search: (query, limit) => withSession(async (s) => {
      const parsed = parseMailQuery(query, deps.clock.now());
      let found = await s.search(parsed, limit);
      // IMAP matches the words as one phrase; when that finds nothing, retry on the most telling word alone.
      const words = parsed.text?.split(/\s+/) ?? [];
      if (found.length === 0 && words.length > 1) {
        found = await s.search({ ...parsed, text: [...words].sort((a, b) => b.length - a.length)[0] }, limit);
      }
      return [...found].reverse().map(line);
    }),
    async read(id) {
      const uid = Number(id.replace(/^imap:/, ''));
      if (!Number.isInteger(uid) || uid <= 0) throw new NotFoundError(`No email ${id}`);
      const source = await withSession((s) => s.source(uid));
      if (source === null) throw new NotFoundError(`No email ${id} in ${label}`);
      const mail = await simpleParser(source);
      const text = mail.text ?? (typeof mail.html === 'string' ? htmlToText(mail.html) : '');
      return `[${label}] From: ${mail.from?.text ?? ''}\nSubject: ${mail.subject ?? ''}\nDate: ${mail.date?.toISOString() ?? ''}\n\n${clip(text, BODY_MAX)}`;
    },
    briefLines: () => withSession(async (s) => (await s.unseen(new Date(deps.clock.now().getTime() - DAY_MS)))
      .filter((m) => !m.bulk).map((m) => `- [${label}] ${m.from}: ${clip(m.subject, 100)}`)),
    async tick() {
      const first = (any.get(key)?.n ?? 0) === 0;
      const fresh = await withSession(async (s) => (await s.unseen(new Date(deps.clock.now().getTime() - DAY_MS)))
        .filter((m) => (seen.get(key, `u:${m.uid}`)?.n ?? 0) === 0));
      const stamp = deps.clock.now().toISOString();
      for (const m of fresh) mark.run(key, `u:${m.uid}`, stamp);
      if (first) {
        mark.run(key, 'primed', stamp);
        return;
      }
      const settings = deps.settings.get();
      const muted = settings.mute_until !== null && Date.parse(settings.mute_until) > deps.clock.now().getTime();
      const personal = fresh.filter((m) => !m.bulk);
      if (personal.length === 0 || muted || inQuietHours(deps.clock.now(), settings.quiet_hours)) return;
      if (deps.toLuady !== undefined) {
        const shown = personal.slice(0, LUADY_MAILS_MAX);
        const texts = await bodySnippets(shown.map((m) => m.uid));
        const mails = shown.map((m) => ({ account: label, from: m.from, subject: m.subject, snippet: texts.get(m.uid) ?? '' }));
        await deps.toLuady(newMailEvent(mails));
        return;
      }
      const lines = personal.slice(0, 5).map((m) => `📧 *${m.from}* · ${label}\n*${clip(m.subject, 120)}*`);
      const more = personal.length > 5 ? `\n…and ${personal.length - 5} more.` : '';
      await deps.outbound.send(`${lines.join('\n\n')}${more}`, null);
    },
  };
}
