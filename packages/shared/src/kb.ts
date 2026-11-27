import { z } from 'zod';
import { ProjectDTOSchema } from './api.js';
import { HostIdSchema } from './ids.js';
import { LIMITS } from './limits.js';

/** A page applies to everyone (`global`), to one office (`office`, with its server) or to one project (with server and project). */
export const KB_SCOPES = ['global', 'office', 'project'] as const;
export const KbScopeSchema = z.enum(KB_SCOPES);
export type KbScope = (typeof KB_SCOPES)[number];

export const KB_AUTHORS = ['owner', 'manager', 'system'] as const;
export const KbAuthorSchema = z.enum(KB_AUTHORS);
export type KbAuthor = (typeof KB_AUTHORS)[number];

/** A slug: lower-case letters and digits in runs joined by single dashes, 1–60 characters. */
export const KB_SLUG_RE = /^(?=.{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The slug of a title that has no letters or digits left (an Arabic title, for example). */
export const KB_SLUG_FALLBACK = 'page';

/**
 * The slug of a page title: lower-cased, every run of characters other than `a-z` and `0-9` turned into one `-`,
 * no dash at either end, at most 60 characters. Uniqueness within a scope, server and project is the hub's job.
 */
export function kbSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.kbSlugMax)
    .replace(/-+$/, '');
  return slug === '' ? KB_SLUG_FALLBACK : slug;
}

export const KbPageDTOSchema = z.object({
  id: z.number().int().positive(),
  scope: KbScopeSchema,
  server: HostIdSchema.nullable(),
  project: z.string().nullable(),
  slug: z.string().regex(KB_SLUG_RE),
  title: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  /** Built by the hub (a project's Overview page) and rebuilt until someone edits it. */
  auto: z.boolean(),
  /** The body's length in characters. */
  size: z.number().int().min(0),
  updatedAt: z.string(),
  updatedBy: KbAuthorSchema,
});
export type KbPageDTO = z.infer<typeof KbPageDTOSchema>;

export const KbPageFullDTOSchema = KbPageDTOSchema.extend({ body: z.string() });
export type KbPageFullDTO = z.infer<typeof KbPageFullDTOSchema>;

/** `syncedAt`: when the pages last reached each server's `~/luady-kb/` (null = never). */
export const KbListDTOSchema = z.object({
  items: z.array(KbPageDTOSchema),
  syncedAt: z.partialRecord(HostIdSchema, z.string().nullable()),
});
export type KbListDTO = z.infer<typeof KbListDTOSchema>;

const Title = z.string().trim().min(1).max(LIMITS.kbTitleMax);
const Body = z.string().max(LIMITS.kbBodyMax);
const Tags = z.array(z.string().trim().min(1).max(LIMITS.kbTagMax)).max(LIMITS.kbTagsMax);
const Project = z.string().min(1).max(LIMITS.boardProjectMax);

/** True when the server and project given are exactly the ones the scope needs. */
export function kbScopeFits(page: { scope: KbScope; server?: unknown; project?: unknown }): boolean {
  const hasServer = page.server !== undefined;
  const hasProject = page.project !== undefined;
  if (page.scope === 'global') return !hasServer && !hasProject;
  if (page.scope === 'office') return hasServer && !hasProject;
  return hasServer && hasProject;
}

export const KB_SCOPE_RULE = { message: 'global takes no server or project, office takes a server, project takes a server and a project' };

export const CreateKbPageBodySchema = z
  .strictObject({
    scope: KbScopeSchema,
    server: HostIdSchema.optional(),
    project: Project.optional(),
    title: Title,
    body: Body,
    tags: Tags.optional(),
  })
  .refine(kbScopeFits, KB_SCOPE_RULE);
export type CreateKbPageBody = z.infer<typeof CreateKbPageBodySchema>;

export const UpdateKbPageBodySchema = z.strictObject({
  title: Title.optional(),
  body: Body.optional(),
  tags: Tags.optional(),
  pinned: z.boolean().optional(),
});
export type UpdateKbPageBody = z.infer<typeof UpdateKbPageBodySchema>;

/** `POST /api/kb/sync`: one server now, or every server when none is named. */
export const KbSyncBodySchema = z.strictObject({ server: HostIdSchema.optional() });
export type KbSyncBody = z.infer<typeof KbSyncBodySchema>;

/** `POST /api/library/refresh`: one office, or all of them. */
export const LibraryRefreshBodySchema = z.strictObject({ server: HostIdSchema.optional() });
export type LibraryRefreshBody = z.infer<typeof LibraryRefreshBodySchema>;

export const SKILL_SOURCES = ['user', 'project', 'plugin'] as const;
export const SkillSourceSchema = z.enum(SKILL_SOURCES);
export type SkillSource = (typeof SKILL_SOURCES)[number];

/** One installed Claude Code skill (from the kit's `skills` verb, or Luady's own `brain/skills`). */
export const SkillDTOSchema = z.object({
  name: z.string(),
  description: z.string().max(LIMITS.skillDescriptionMax),
  source: SkillSourceSchema,
  path: z.string(),
});
export type SkillDTO = z.infer<typeof SkillDTOSchema>;

/** A project with what is on it now: live sessions, open cards and knowledge pages. */
export const LibraryProjectDTOSchema = ProjectDTOSchema.extend({
  sessions: z.number().int().min(0),
  openItems: z.number().int().min(0),
  pages: z.number().int().min(0),
});
export type LibraryProjectDTO = z.infer<typeof LibraryProjectDTOSchema>;

/** `skills` null = not listed (the kit is older than 2.1, or the server has not answered yet). */
export const LibraryOfficeDTOSchema = z.object({
  server: HostIdSchema,
  projects: z.array(LibraryProjectDTOSchema),
  skills: z.array(SkillDTOSchema).nullable(),
  skillsAt: z.string().nullable(),
});
export type LibraryOfficeDTO = z.infer<typeof LibraryOfficeDTOSchema>;

export const LibraryDTOSchema = z.object({ offices: z.array(LibraryOfficeDTOSchema), managerSkills: z.array(SkillDTOSchema) });
export type LibraryDTO = z.infer<typeof LibraryDTOSchema>;
