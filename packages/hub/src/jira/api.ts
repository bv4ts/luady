import { z } from 'zod';
import { JIRA_KEY_RE } from '@luady/shared';
import type { AdfDoc } from './adf.js';
import type { JiraHttp } from './client.js';
import { JiraError } from './errors.js';

/**
 * The Jira Cloud REST v3 calls the hub makes. Checked against Atlassian's v3 reference (2026-11): JQL search is
 * `GET /rest/api/3/search/jql` (fields named explicitly, pages by `nextPageToken`, no token on the last page).
 */

/** Custom fields found once per site from the field list. */
export interface FieldIds {
  readonly sprint: string | null;
  readonly flagged: string | null;
}

export interface JiraMe {
  readonly accountId: string;
  readonly displayName: string | null;
}

/** One issue as Jira sends it: `fields` is read with care in map.ts. */
export interface RawIssue {
  readonly key: string;
  readonly fields: Record<string, unknown>;
}

export interface RawTransition {
  readonly id: string;
  readonly name: string;
  readonly to: string;
}

const PAGE_SIZE = 50;
const SPRINT_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';

const MyselfSchema = z.object({ accountId: z.string().min(1), displayName: z.string().nullish() });
const FieldSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  custom: z.boolean().nullish(),
  schema: z.object({ custom: z.string().nullish() }).nullish(),
});
const IssueSchema = z.object({ key: z.string().regex(JIRA_KEY_RE), fields: z.record(z.string(), z.unknown()).nullish() });
const SearchSchema = z.object({
  issues: z.array(z.unknown()).default([]),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
});
const TransitionsSchema = z.object({
  transitions: z.array(z.object({ id: z.string(), name: z.string().nullish(), to: z.object({ name: z.string().nullish() }).nullish() })).default([]),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new JiraError('unreadable');
  return result.data;
}

const issuePath = (key: string): string => {
  if (!JIRA_KEY_RE.test(key)) throw new JiraError('bad', 'That is not a Jira ticket key.');
  return `/rest/api/3/issue/${key}`;
};

function toRawIssue(value: unknown): RawIssue | null {
  const result = IssueSchema.safeParse(value);
  return result.success ? { key: result.data.key, fields: result.data.fields ?? {} } : null;
}

/** `GET /rest/api/3/myself`: who the token belongs to (the sign-in check). */
export async function getMyself(http: JiraHttp): Promise<JiraMe> {
  const me = parse(MyselfSchema, await http.get('/rest/api/3/myself'));
  return { accountId: me.accountId, displayName: me.displayName ?? null };
}

/** `GET /rest/api/3/field`: the sprint field (Jira Software's sprint type) and the "Flagged" field. */
export async function getFieldIds(http: JiraHttp): Promise<FieldIds> {
  const fields = parse(z.array(FieldSchema), await http.get('/rest/api/3/field'));
  const sprint = fields.find((f) => f.schema?.custom === SPRINT_TYPE) ?? fields.find((f) => f.custom === true && f.name === 'Sprint');
  const flagged = fields.find((f) => f.custom === true && f.name?.toLowerCase() === 'flagged');
  return { sprint: sprint?.id ?? null, flagged: flagged?.id ?? null };
}

/** `GET /rest/api/3/search/jql`, following `nextPageToken` until `max` issues or the last page. */
export async function searchIssues(http: JiraHttp, jql: string, fields: readonly string[], max: number): Promise<RawIssue[]> {
  const found: RawIssue[] = [];
  let token: string | undefined;
  for (let page = 0; page < Math.ceil(max / PAGE_SIZE) + 1 && found.length < max; page += 1) {
    const body = parse(SearchSchema, await http.get('/rest/api/3/search/jql', {
      jql, fields: fields.join(','), maxResults: Math.min(PAGE_SIZE, max - found.length), nextPageToken: token,
    }));
    found.push(...body.issues.flatMap((issue) => toRawIssue(issue) ?? []));
    token = body.nextPageToken ?? undefined;
    if (token === undefined || body.isLast === true) break;
  }
  return found.slice(0, max);
}

/** `GET /rest/api/3/issue/{key}` with the fields named. */
export async function getIssue(http: JiraHttp, key: string, fields: readonly string[]): Promise<RawIssue> {
  const issue = toRawIssue(await http.get(issuePath(key), { fields: fields.join(',') }));
  if (issue === null) throw new JiraError('unreadable');
  return issue;
}

/** `GET /rest/api/3/issue/{key}/transitions`: the moves Jira offers now. */
export async function getTransitions(http: JiraHttp, key: string): Promise<RawTransition[]> {
  const body = parse(TransitionsSchema, await http.get(`${issuePath(key)}/transitions`));
  return body.transitions.map((t) => ({ id: t.id, name: t.name ?? t.id, to: t.to?.name ?? '' }));
}

/** `POST /rest/api/3/issue/{key}/transitions` (204). */
export async function postTransition(http: JiraHttp, key: string, transitionId: string): Promise<void> {
  await http.post(`${issuePath(key)}/transitions`, { transition: { id: transitionId } });
}

/** `POST /rest/api/3/issue/{key}/comment` with a Jira document body (201). */
export async function postComment(http: JiraHttp, key: string, body: AdfDoc): Promise<void> {
  await http.post(`${issuePath(key)}/comment`, { body });
}

/** `PUT /rest/api/3/issue/{key}` with `fields` (204). */
export async function putIssueFields(http: JiraHttp, key: string, fields: Record<string, unknown>): Promise<void> {
  await http.put(issuePath(key), { fields });
}

/** `PUT /rest/api/3/issue/{key}/assignee`: an account id, or null to unassign (204). */
export async function putAssignee(http: JiraHttp, key: string, accountId: string | null): Promise<void> {
  await http.put(`${issuePath(key)}/assignee`, { accountId });
}
