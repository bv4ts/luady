import { JIRA_KEY_RE, type JiraCategory, type JiraColumnDTO, type JiraIssueDTO, type JiraIssueDetailDTO } from '@luady/shared';
import { adfToMarkdown } from './adf.js';
import type { FieldIds, RawIssue, RawTransition } from './api.js';

/** Jira issue data to the hub's DTOs. Every value is read defensively: the input comes from outside. */

export const LIST_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'labels', 'updated', 'parent'] as const;
export const DETAIL_FIELDS = [...LIST_FIELDS, 'description', 'reporter', 'assignee', 'created', 'duedate', 'subtasks', 'comment'] as const;
const COMMENTS_MAX = 50;

/** Field names to ask for: the fixed ones plus the site's sprint and flagged fields when it has them. */
export function fieldList(base: readonly string[], ids: FieldIds): string[] {
  return [...base, ...[ids.sprint, ids.flagged].filter((id): id is string => id !== null)];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const prop = (value: unknown, name: string): unknown => (isObject(value) ? value[name] : undefined);
const person = (value: unknown): string | null => strOrNull(prop(value, 'displayName'));

/** Jira's times (`2026-11-15T09:00:00.000+0100`) as ISO UTC; anything unreadable stays as it came. */
export function isoTime(value: unknown): string {
  const text = str(value);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString();
}

/** Jira's status category keys: `new` (to do), `indeterminate` (in progress), `done`. */
export function categoryOf(key: unknown): JiraCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'doing';
  return 'todo';
}

export interface SprintInfo { readonly name: string; readonly endsAt: string | null; readonly state: string }

/** The issue's sprint: the active one, else a future one, else the last it was in. */
export function sprintOf(value: unknown): SprintInfo | null {
  if (!Array.isArray(value)) return null;
  const sprints = value.filter(isObject).map((s) => ({ name: str(s.name), endsAt: strOrNull(s.endDate), state: str(s.state) }))
    .filter((s) => s.name !== '');
  return sprints.find((s) => s.state === 'active') ?? sprints.find((s) => s.state === 'future') ?? sprints.at(-1) ?? null;
}

function flaggedOf(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

function parentOf(value: unknown): JiraIssueDTO['parent'] {
  const key = str(prop(value, 'key'));
  if (!JIRA_KEY_RE.test(key)) return null;
  return { key, summary: str(prop(prop(value, 'fields'), 'summary')) };
}

/** A ticket card. `hasNews` is filled in by the service from jira_seen. */
export function toIssueDto(raw: RawIssue, ids: FieldIds, site: string): JiraIssueDTO {
  const f = raw.fields;
  const status = f.status;
  const sprint = ids.sprint === null ? null : sprintOf(f[ids.sprint]);
  return {
    key: raw.key,
    summary: str(f.summary),
    type: str(prop(f.issuetype, 'name')) || 'Task',
    status: { name: str(prop(status, 'name')) || 'Unknown', category: categoryOf(prop(prop(status, 'statusCategory'), 'key')) },
    priority: strOrNull(prop(f.priority, 'name')),
    labels: Array.isArray(f.labels) ? f.labels.filter((label): label is string => typeof label === 'string') : [],
    updatedAt: isoTime(f.updated),
    sprint: sprint?.name ?? null,
    parent: parentOf(f.parent),
    flagged: ids.flagged === null ? false : flaggedOf(f[ids.flagged]),
    hasNews: false,
    url: `${site}/browse/${raw.key}`,
  };
}

function commentsOf(value: unknown): JiraIssueDetailDTO['comments'] {
  const list = prop(value, 'comments');
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).slice(-COMMENTS_MAX).map((c) => ({
    id: str(c.id),
    author: person(c.author) ?? 'Someone',
    at: isoTime(c.created),
    bodyMd: adfToMarkdown(c.body),
  }));
}

function subtasksOf(value: unknown): JiraIssueDetailDTO['subtasks'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((s) => {
    const key = str(s.key);
    if (!JIRA_KEY_RE.test(key)) return [];
    return [{ key, summary: str(prop(s.fields, 'summary')), status: str(prop(prop(s.fields, 'status'), 'name')) }];
  });
}

export function toDetailDto(raw: RawIssue, transitions: readonly RawTransition[], ids: FieldIds, site: string): JiraIssueDetailDTO {
  const f = raw.fields;
  return {
    ...toIssueDto(raw, ids, site),
    descriptionMd: adfToMarkdown(f.description),
    reporter: person(f.reporter),
    assignee: person(f.assignee),
    createdAt: isoTime(f.created),
    dueDate: strOrNull(f.duedate),
    comments: commentsOf(f.comment),
    transitions: transitions.map((t) => ({ id: t.id, name: t.name, to: t.to })),
    subtasks: subtasksOf(f.subtasks),
  };
}

const CATEGORY_ORDER: readonly JiraCategory[] = ['todo', 'doing', 'done'];

/** One column per status, ordered to-do, in progress, done, then in the order the statuses first appear. */
export function columnsOf(issues: readonly JiraIssueDTO[]): JiraColumnDTO[] {
  const columns: JiraColumnDTO[] = [];
  for (const issue of issues) {
    const at = columns.findIndex((c) => c.name === issue.status.name);
    if (at === -1) columns.push({ name: issue.status.name, category: issue.status.category, keys: [issue.key] });
    else columns[at] = { ...columns[at]!, keys: [...columns[at]!.keys, issue.key] };
  }
  return CATEGORY_ORDER.flatMap((category) => columns.filter((c) => c.category === category));
}

/** The sprint a board shows: the first active sprint among the issues. */
export function boardSprint(raws: readonly RawIssue[], ids: FieldIds): { name: string; endsAt: string | null } | null {
  if (ids.sprint === null) return null;
  const sprintField = ids.sprint;
  const found = raws.map((raw) => sprintOf(raw.fields[sprintField])).find((s) => s !== null && s.state === 'active') ?? null;
  return found === null ? null : { name: found.name, endsAt: found.endsAt };
}
