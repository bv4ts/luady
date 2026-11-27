import { describe, expect, it } from 'vitest';
import {
  CreateKbPageBodySchema,
  KB_SLUG_RE,
  KbListDTOSchema,
  KbPageDTOSchema,
  KbPageFullDTOSchema,
  KbSyncBodySchema,
  LibraryDTOSchema,
  LibraryOfficeDTOSchema,
  LibraryProjectDTOSchema,
  LibraryRefreshBodySchema,
  SkillDTOSchema,
  UpdateKbPageBodySchema,
  kbSlug,
} from '../src/kb.js';

const AT = '2026-11-15T09:00:00.000Z';
const page = {
  id: 3, scope: 'project', server: 'birch', project: 'orchard', slug: 'overview', title: 'Overview',
  tags: ['auto'], pinned: false, auto: true, size: 420, updatedAt: AT, updatedBy: 'system',
};
const skill = { name: 'cc-prompt', description: 'Write a brief for a session.', source: 'user', path: '/home/dev/.claude/skills/cc-prompt/SKILL.md' };
const project = {
  server: 'birch', path: '/home/dev/projects/orchard', name: 'orchard', remote: null, branch: 'main', commits: [], stack: ['node'], updatedAt: AT,
};

describe('kbSlug', () => {
  it.each([
    ['Overview', 'overview'],
    ['How we deploy: Orchard (prod)', 'how-we-deploy-orchard-prod'],
    ['  --Release   notes 2.1--  ', 'release-notes-2-1'],
    ['Ünïcode Straße', 'n-code-stra-e'],
  ])('%j becomes %j', (title, slug) => {
    expect(kbSlug(title)).toBe(slug);
    expect(KB_SLUG_RE.test(slug)).toBe(true);
  });

  it('cuts to 60 characters without a trailing dash', () => {
    const slug = kbSlug(`${'a'.repeat(59)} bcd`);
    expect(slug).toBe('a'.repeat(59));
    expect(kbSlug('x'.repeat(80))).toHaveLength(60);
  });

  it('falls back to "page" when nothing is left', () => {
    expect(kbSlug('مرحبا')).toBe('page');
    expect(kbSlug('---')).toBe('page');
  });

  it('KB_SLUG_RE rejects capitals, edge dashes and 61 characters', () => {
    expect(['Overview', '-a', 'a-', 'a--b', 'x'.repeat(61), ''].some((slug) => KB_SLUG_RE.test(slug))).toBe(false);
  });
});

describe('pages', () => {
  it('parses a page, a full page and a list', () => {
    expect(KbPageDTOSchema.parse(page)).toEqual(page);
    expect(KbPageFullDTOSchema.parse({ ...page, body: '# Overview' }).body).toBe('# Overview');
    const list = { items: [page], syncedAt: { birch: AT, cedar: null } };
    expect(KbListDTOSchema.parse(list)).toEqual(list);
    expect(KbListDTOSchema.safeParse({ items: [], syncedAt: { 'Not An Id': AT } }).success).toBe(false);
  });

  it('rejects a bad slug, an unknown scope and an unknown author', () => {
    expect(KbPageDTOSchema.safeParse({ ...page, slug: 'Over view' }).success).toBe(false);
    expect(KbPageDTOSchema.safeParse({ ...page, scope: 'team' }).success).toBe(false);
    expect(KbPageDTOSchema.safeParse({ ...page, updatedBy: 'session' }).success).toBe(false);
  });
});

describe('page bodies', () => {
  it('accepts a page for everyone, an office and a project', () => {
    expect(CreateKbPageBodySchema.parse({ scope: 'global', title: 'Rules', body: '' })).toEqual({ scope: 'global', title: 'Rules', body: '' });
    expect(CreateKbPageBodySchema.safeParse({ scope: 'office', server: 'cedar', title: 'Meadow', body: 'x' }).success).toBe(true);
    const full = { scope: 'project', server: 'birch', project: 'orchard', title: 'Deploy', body: 'npm run deploy', tags: ['deploy', 'prod'] };
    expect(CreateKbPageBodySchema.parse(full)).toEqual(full);
  });

  it.each([
    ['an office page without its server', { scope: 'office', title: 'x', body: '' }],
    ['a project page without its project', { scope: 'project', server: 'birch', title: 'x', body: '' }],
    ['a global page with a server', { scope: 'global', server: 'birch', title: 'x', body: '' }],
    ['an empty title', { scope: 'global', title: '', body: '' }],
    ['a 121-character title', { scope: 'global', title: 'x'.repeat(121), body: '' }],
    ['a 60001-character body', { scope: 'global', title: 'x', body: 'x'.repeat(60001) }],
    ['nine tags', { scope: 'global', title: 'x', body: '', tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }],
    ['a 31-character tag', { scope: 'global', title: 'x', body: '', tags: ['x'.repeat(31)] }],
    ['an unknown key', { scope: 'global', title: 'x', body: '', pinned: true }],
  ])('CreateKbPageBodySchema rejects %s', (_label, body) => {
    expect(CreateKbPageBodySchema.safeParse(body).success).toBe(false);
  });

  it('UpdateKbPageBodySchema takes a pin and rejects a scope change', () => {
    expect(UpdateKbPageBodySchema.parse({ pinned: true })).toEqual({ pinned: true });
    expect(UpdateKbPageBodySchema.safeParse({ scope: 'global' }).success).toBe(false);
  });

  it('the sync and refresh bodies take an optional server only', () => {
    expect(KbSyncBodySchema.parse({})).toEqual({});
    expect(KbSyncBodySchema.parse({ server: 'ash' })).toEqual({ server: 'ash' });
    expect(LibraryRefreshBodySchema.safeParse({ server: 'A:sh' }).success).toBe(false);
    expect(LibraryRefreshBodySchema.safeParse({ all: true }).success).toBe(false);
  });
});

describe('library', () => {
  it('parses skills, projects, offices and the whole library', () => {
    expect(SkillDTOSchema.parse(skill)).toEqual(skill);
    expect(SkillDTOSchema.safeParse({ ...skill, description: 'x'.repeat(301) }).success).toBe(false);
    expect(SkillDTOSchema.safeParse({ ...skill, source: 'builtin' }).success).toBe(false);
    const libraryProject = { ...project, sessions: 2, openItems: 5, pages: 1 };
    expect(LibraryProjectDTOSchema.parse(libraryProject)).toEqual(libraryProject);
    const office = { server: 'birch', projects: [libraryProject], skills: null, skillsAt: null };
    expect(LibraryOfficeDTOSchema.parse(office)).toEqual(office);
    expect(LibraryDTOSchema.parse({ offices: [office], managerSkills: [skill] }).offices).toHaveLength(1);
  });
});
