import {
  JIRA_CATEGORIES, LIMITS, isJiraSiteUrl, type JiraBoardDTO, type JiraCategory, type JiraIssueDTO, type JiraView,
} from '@luady/shared';
import { isApiError, userMessage } from '../../../../api/errors.js';
import type { RoomLookup } from '../../../rooms/room-lookup.js';

/**
 * The room whose Jira board the pop-up shows: the room asked for (a host reads as its home room); for a key that names
 * no room (HQ, a lot) the first room; null while the office has no rooms.
 */
export function officeOf(room: string, lookup: RoomLookup): string | null {
  return lookup.room(room)?.id ?? lookup.firstRoom();
}

export const VIEW_LABELS: Readonly<Record<JiraView, string>> = { sprint: 'My sprint', mine: 'All mine', attention: 'Needs attention' };
export const VIEWS: readonly JiraView[] = Object.freeze(['sprint', 'mine', 'attention']);

/** Where the owner makes an API token. */
export const ATLASSIAN_TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** The usual Jira priorities, highest first (a site may name its own; the ticket's own value is always offered too). */
export const PRIORITIES: readonly string[] = Object.freeze(['Highest', 'High', 'Medium', 'Low', 'Lowest']);

export interface BoardColumn {
  readonly name: string;
  readonly category: JiraCategory;
  readonly issues: readonly JiraIssueDTO[];
}

const categoryRank = (category: JiraCategory): number => JIRA_CATEGORIES.indexOf(category);

/**
 * The board's columns with their tickets, ordered to-do, in progress, done (the hub's own order kept inside a
 * category). A key with no ticket in the list is skipped; a ticket in no column gets a column for its status.
 */
export function boardColumns(board: Pick<JiraBoardDTO, 'columns' | 'issues'>): readonly BoardColumn[] {
  const byKey = new Map(board.issues.map((issue) => [issue.key, issue]));
  // A key belongs to the first column that lists it.
  const owner = new Map<string, string>();
  for (const column of board.columns) for (const key of column.keys) if (!owner.has(key)) owner.set(key, column.name);
  const unplaced = board.issues.filter((issue) => !owner.has(issue.key));
  const columnNames = new Set(board.columns.map((column) => column.name));
  const columns = board.columns.map((column) => ({
    name: column.name,
    category: column.category,
    issues: [
      ...[...new Set(column.keys)].filter((key) => owner.get(key) === column.name).flatMap((key) => byKey.get(key) ?? []),
      ...unplaced.filter((issue) => issue.status.name === column.name),
    ],
  }));
  const extraNames = [...new Set(unplaced.map((issue) => issue.status.name).filter((name) => !columnNames.has(name)))];
  const extras = extraNames.map((name) => {
    const issues = unplaced.filter((issue) => issue.status.name === name);
    return { name, category: issues[0]?.status.category ?? 'todo', issues };
  });
  return [...columns, ...extras]
    .map((column, index) => ({ column, index }))
    .toSorted((a, b) => categoryRank(a.column.category) - categoryRank(b.column.category) || a.index - b.index)
    .map(({ column }) => column);
}

/** "3 tickets · 1 with news". */
export function boardSummary(issues: readonly JiraIssueDTO[]): string {
  const news = issues.filter((issue) => issue.hasNews).length;
  const count = `${issues.length} ${issues.length === 1 ? 'ticket' : 'tickets'}`;
  return news === 0 ? count : `${count} · ${news} with news`;
}

/** The view asked for and the one the hub answered differ when "My sprint" was empty and fell back to "All mine". */
export function fellBack(asked: JiraView, board: Pick<JiraBoardDTO, 'view'>): boolean {
  return asked === 'sprint' && board.view !== 'sprint';
}

/** A site as the owner types it, made into `https://<name>.atlassian.net` where that is clearly what was meant. */
export function normaliseSite(text: string): string {
  const raw = text.trim().toLowerCase();
  if (raw === '') return '';
  const withScheme = /^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' && url.hostname.endsWith('.atlassian.net') ? `https://${url.hostname}` : withScheme;
  } catch {
    return withScheme;
  }
}

export interface ConnectFields {
  readonly site: string;
  readonly email: string;
  readonly token: string;
}

export type ConnectErrors = Partial<Record<keyof ConnectFields, string>>;
export type ConnectCheck =
  | { readonly ok: true; readonly baseUrl: string; readonly email: string; readonly token: string }
  | { readonly ok: false; readonly errors: ConnectErrors };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The connect form before anything is sent: the site, the e-mail and the token in plain words. The PIN comes after. */
export function checkConnect(fields: ConnectFields): ConnectCheck {
  const baseUrl = normaliseSite(fields.site);
  const email = fields.email.trim();
  const token = fields.token.trim();
  const errors: ConnectErrors = {
    ...(baseUrl === '' ? { site: 'Type your Jira address, such as https://name.atlassian.net.' }
      : isJiraSiteUrl(baseUrl) ? {} : { site: 'Use your Atlassian address: https://name.atlassian.net.' }),
    ...(email === '' ? { email: 'Type the e-mail you sign in to Jira with.' }
      : EMAIL_RE.test(email) && email.length <= LIMITS.jiraEmailMax ? {} : { email: 'That does not look like an e-mail address.' }),
    ...(token === '' ? { token: 'Paste the API token.' }
      : token.length < LIMITS.jiraTokenMin || token.length > LIMITS.jiraTokenMax ? { token: 'That token looks too short. Copy the whole token.' } : {}),
  };
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, baseUrl, email, token };
}

/** True for the hub's answer when the office has no Jira connection. */
export const notConnected = (err: unknown): boolean => isApiError(err, 'jira_not_connected');

/** True when Jira refused the stored sign-in (the token expired or was revoked): the owner should connect again. */
export const signInRefused = (err: unknown): boolean => isApiError(err, 'jira_auth');

/** A hub error in the owner's words. A hub without Jira yet (404, 501) says so instead of "unexpected error". */
export function jiraErrorText(err: unknown): string {
  if (notConnected(err)) return 'Jira is not connected for this office.';
  if (isApiError(err) && (err.status === 404 || err.status === 501)) return 'The hub cannot do this yet. It needs the next update.';
  return userMessage(err);
}

/** The card a ticket becomes: "ORC-123 summary" (cut to the card's 300 characters). */
export function ticketCardTitle(issue: Pick<JiraIssueDTO, 'key' | 'summary'>): string {
  return `${issue.key} ${issue.summary}`.slice(0, LIMITS.boardTitleMax);
}

const DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

/** A Jira date ("2026-11-20") as "Nov 20, 2026"; anything unreadable as it came. */
export function dayText(date: string): string {
  const at = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(at) ? DAY.format(at) : date;
}

/** Labels typed as "a, b c" or "a b": Jira labels have no spaces, so any run of spaces or commas splits them. */
export function parseLabels(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))].slice(0, LIMITS.jiraLabelsMax);
}

/** "name.atlassian.net" from a site address; the address itself when it cannot be read. */
export function siteHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
