import { z } from 'zod';
import { PinSchema } from './ids.js';
import { RoomIdSchema } from './rooms.js';
import { LIMITS } from './limits.js';
import { HttpsUrlSchema } from './urls.js';

/** A Jira ticket key: project key (2–20, capital first), a dash, the number. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-\d{1,7}$/;
/** The only site address the hub accepts: `https://<name>.atlassian.net`, nothing after the host but one slash. */
export const JIRA_SITE_RE = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/;

/** True for `https://<name>.atlassian.net` (checked before any request, so the hub cannot be pointed elsewhere). */
export function isJiraSiteUrl(url: string): boolean {
  return JIRA_SITE_RE.test(url);
}

export const JiraKeySchema = z.string().regex(JIRA_KEY_RE);
export const JiraSiteUrlSchema = z.string().max(200).regex(JIRA_SITE_RE);

export const JIRA_VIEWS = ['sprint', 'mine', 'attention'] as const;
export const JiraViewSchema = z.enum(JIRA_VIEWS);
export type JiraView = (typeof JIRA_VIEWS)[number];

export const JIRA_CATEGORIES = ['todo', 'doing', 'done'] as const;
export const JiraCategorySchema = z.enum(JIRA_CATEGORIES);
export type JiraCategory = (typeof JIRA_CATEGORIES)[number];

/** One office's Jira connection. The token never leaves the hub. `attention`: tickets that need the owner, null = not counted yet. */
export const JiraSiteDTOSchema = z.object({
  /** The room key of the office the site belongs to. */
  server: RoomIdSchema,
  baseUrl: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  connectedAt: z.string(),
  lastOkAt: z.string().nullable(),
  lastError: z.string().nullable(),
  attention: z.number().int().min(0).nullable(),
});
export type JiraSiteDTO = z.infer<typeof JiraSiteDTOSchema>;

export const JiraSitesDTOSchema = z.object({ sites: z.array(JiraSiteDTOSchema) });
export type JiraSitesDTO = z.infer<typeof JiraSitesDTOSchema>;

/** `PUT /api/jira/:server/connection`: the hub checks the sign-in before it stores the token sealed. */
export const JiraConnectBodySchema = z.strictObject({
  baseUrl: JiraSiteUrlSchema,
  email: z.string().trim().min(3).max(LIMITS.jiraEmailMax),
  token: z.string().min(LIMITS.jiraTokenMin).max(LIMITS.jiraTokenMax),
  pin: PinSchema,
});
export type JiraConnectBody = z.infer<typeof JiraConnectBodySchema>;

/** `POST /api/jira/:server/disconnect`. */
export const JiraDisconnectBodySchema = z.strictObject({ pin: PinSchema });
export type JiraDisconnectBody = z.infer<typeof JiraDisconnectBodySchema>;

export const JiraIssueDTOSchema = z.object({
  key: JiraKeySchema,
  summary: z.string(),
  type: z.string(),
  status: z.object({ name: z.string(), category: JiraCategorySchema }),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  updatedAt: z.string(),
  sprint: z.string().nullable(),
  parent: z.object({ key: JiraKeySchema, summary: z.string() }).nullable(),
  flagged: z.boolean(),
  /** Changed since the owner last opened it. */
  hasNews: z.boolean(),
  /** The ticket on the Jira site (the website links to it). */
  url: HttpsUrlSchema,
});
export type JiraIssueDTO = z.infer<typeof JiraIssueDTOSchema>;

/** A board column: one ticket status, ordered to-do, in progress, done. */
export const JiraColumnDTOSchema = z.object({ name: z.string(), category: JiraCategorySchema, keys: z.array(JiraKeySchema) });
export type JiraColumnDTO = z.infer<typeof JiraColumnDTOSchema>;

export const JiraBoardDTOSchema = z.object({
  view: JiraViewSchema,
  issues: z.array(JiraIssueDTOSchema),
  columns: z.array(JiraColumnDTOSchema),
  sprint: z.object({ name: z.string(), endsAt: z.string().nullable() }).nullable(),
  fetchedAt: z.string(),
});
export type JiraBoardDTO = z.infer<typeof JiraBoardDTOSchema>;

/** A ticket opened: Jira's rich text converted to Markdown (rendered by the sanitising renderer). */
export const JiraIssueDetailDTOSchema = JiraIssueDTOSchema.extend({
  descriptionMd: z.string(),
  reporter: z.string().nullable(),
  assignee: z.string().nullable(),
  createdAt: z.string(),
  dueDate: z.string().nullable(),
  comments: z.array(z.object({ id: z.string(), author: z.string(), at: z.string(), bodyMd: z.string() })),
  transitions: z.array(z.object({ id: z.string(), name: z.string(), to: z.string() })),
  subtasks: z.array(z.object({ key: JiraKeySchema, summary: z.string(), status: z.string() })),
});
export type JiraIssueDetailDTO = z.infer<typeof JiraIssueDetailDTOSchema>;

export const JiraTransitionBodySchema = z.strictObject({ transitionId: z.string().min(1).max(64) });
export type JiraTransitionBody = z.infer<typeof JiraTransitionBodySchema>;

export const JiraCommentBodySchema = z.strictObject({ text: z.string().min(1).max(LIMITS.jiraCommentMax) });
export type JiraCommentBody = z.infer<typeof JiraCommentBodySchema>;

export const JiraEditBodySchema = z.strictObject({
  summary: z.string().min(1).max(LIMITS.jiraSummaryMax).optional(),
  description: z.string().max(LIMITS.jiraDescriptionMax).optional(),
  priority: z.string().min(1).max(64).optional(),
  labels: z.array(z.string().min(1).max(LIMITS.jiraLabelMax)).max(LIMITS.jiraLabelsMax).optional(),
});
export type JiraEditBody = z.infer<typeof JiraEditBodySchema>;

/** `me: true` assigns the ticket to the connected account; false unassigns it. */
export const JiraAssignBodySchema = z.strictObject({ me: z.boolean() });
export type JiraAssignBody = z.infer<typeof JiraAssignBodySchema>;
