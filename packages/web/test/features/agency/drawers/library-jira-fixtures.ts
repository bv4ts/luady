import { ApiError } from '../../../../src/api/errors.js';
import type { FakeApiOverrides } from '../../../helpers/fake-api.js';
import type {
  JiraBoardDTO, JiraIssueDTO, JiraIssueDetailDTO, JiraSiteDTO, KbPageDTO, KbPageFullDTO, LibraryDTO, LibraryProjectDTO, SkillDTO,
} from '@luady/shared';

export const AT = '2026-11-15T09:00:00.000Z';

export function project(over: Partial<LibraryProjectDTO> = {}): LibraryProjectDTO {
  return {
    server: 'birch', path: '/home/dev/projects/orchard-web', name: 'orchard-web', remote: 'git@github.com:birch/orchard-web.git',
    branch: 'main', commits: [{ hash: 'abc1234', date: AT, subject: 'Fix the checkout total' }], stack: ['react', 'vite'],
    updatedAt: AT, sessions: 2, openItems: 3, pages: 1, ...over,
  };
}

export function skill(over: Partial<SkillDTO> = {}): SkillDTO {
  return { name: 'cc-prompt', description: 'Write a brief for a session.', source: 'user', path: '~/.claude/skills/cc-prompt/SKILL.md', ...over };
}

export function library(over: Partial<LibraryDTO> = {}): LibraryDTO {
  return {
    offices: [
      { server: 'cedar', projects: [project({ server: 'cedar', name: 'meadow-vat', path: '/home/dev/projects/meadow-vat', sessions: 0, openItems: 0, pages: 0 })], skills: null, skillsAt: null },
      {
        server: 'birch',
        projects: [project(), project({ name: 'orchard-api', path: '/home/dev/projects/orchard-api', sessions: 1, openItems: 0, pages: 0 })],
        skills: [skill(), skill({ name: 'frontend-design', source: 'plugin', description: 'Distinctive interfaces.' }), skill({ name: 'deploy', source: 'project' })],
        skillsAt: AT,
      },
    ],
    managerSkills: [skill({ name: 'board', source: 'project', description: 'The board and its tools.' })],
    ...over,
  };
}

export function page(over: Partial<KbPageDTO> = {}): KbPageDTO {
  return {
    id: 1, scope: 'global', server: null, project: null, slug: 'house-rules', title: 'House rules', tags: ['rules'], pinned: false,
    auto: false, size: 420, updatedAt: AT, updatedBy: 'owner', ...over,
  };
}

export function fullPage(over: Partial<KbPageFullDTO> = {}): KbPageFullDTO {
  return { ...page(over), body: '# House rules\n\nAlways run the tests.', ...over };
}

export const PAGES: readonly KbPageDTO[] = [
  page({ id: 4, scope: 'project', server: 'birch', project: 'orchard-web', slug: 'overview', title: 'Overview', auto: true, updatedBy: 'system' }),
  page(),
  page({ id: 2, scope: 'office', server: 'birch', slug: 'deploys', title: 'Deploys', pinned: true, updatedBy: 'manager' }),
  page({ id: 3, scope: 'office', server: 'cedar', slug: 'vat', title: 'VAT notes' }),
  page({ id: 5, scope: 'global', slug: 'arabic', title: 'Arabic copy', pinned: true }),
];

export function site(over: Partial<JiraSiteDTO> = {}): JiraSiteDTO {
  return {
    server: 'birch', baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', displayName: 'Owner', connectedAt: AT,
    lastOkAt: AT, lastError: null, attention: 2, ...over,
  };
}

export function issue(over: Partial<JiraIssueDTO> = {}): JiraIssueDTO {
  return {
    key: 'ORC-101', summary: 'Checkout total is wrong', type: 'Bug', status: { name: 'To Do', category: 'todo' }, priority: 'High',
    labels: ['web'], updatedAt: AT, sprint: 'Sprint 42', parent: null, flagged: false, hasNews: false,
    url: 'https://orchard-demo.atlassian.net/browse/ORC-101', ...over,
  };
}

export function board(over: Partial<JiraBoardDTO> = {}): JiraBoardDTO {
  return {
    view: 'sprint',
    issues: [
      issue(),
      issue({ key: 'ORC-102', summary: 'Menu import times out', status: { name: 'In Progress', category: 'doing' }, hasNews: true }),
      issue({ key: 'ORC-103', summary: 'Push copy', status: { name: 'Done', category: 'done' }, priority: 'Low' }),
    ],
    columns: [
      { name: 'Done', category: 'done', keys: ['ORC-103'] },
      { name: 'To Do', category: 'todo', keys: ['ORC-101'] },
      { name: 'In Progress', category: 'doing', keys: ['ORC-102'] },
    ],
    sprint: { name: 'Sprint 42', endsAt: '2026-11-20T12:00:00.000Z' },
    fetchedAt: AT,
    ...over,
  };
}

export function detail(over: Partial<JiraIssueDetailDTO> = {}): JiraIssueDetailDTO {
  return {
    ...issue(), descriptionMd: 'The **total** skips the delivery fee.\n\n<script>alert(1)</script>', reporter: 'Sara', assignee: 'Owner',
    createdAt: AT, dueDate: '2026-11-20',
    comments: [{ id: 'c1', author: 'Sara', at: AT, bodyMd: 'Seen on *iOS* too.' }],
    transitions: [{ id: '21', name: 'Start progress', to: 'In Progress' }, { id: '31', name: 'Done', to: 'Done' }],
    subtasks: [{ key: 'ORC-110', summary: 'Add a test', status: 'To Do' }],
    ...over,
  };
}

const absent = async (): Promise<never> => { throw new ApiError(404, 'not_found', 'not here'); };

/** The store's live loads answer as an older hub would (404), so the tests stay quiet. */
export const QUIET_STORE: FakeApiOverrides = {
  activity: async () => ({ items: [] }), notices: async () => ({ items: [] }),
  presence: async () => ({ mode: 'here', online: true, clients: 1, forcedUntil: null }),
  board: absent, missions: absent, said: absent,
};
