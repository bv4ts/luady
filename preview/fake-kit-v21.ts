import { CtlKbPutInputSchema, SELF_HOST_ID, type CtlGitStatus, type CtlKbFile, type CtlKbPut, type CtlSkills, type HostId } from '@luady/shared';
import { CtlError } from '../packages/hub/dist/core/errors.js';

/** Kit 2.1 verbs for the preview: a skill list per host, a `~/luady-kb/` folder that remembers what it got, git status. */

type Skill = CtlSkills['skills'][number];

const HOME = '/home/dev';
const EXIT_USAGE = 2;

const user = (name: string, description: string): Skill => ({ name, description, source: 'user', path: `${HOME}/.claude/skills/${name}/SKILL.md` });
const project = (folder: string, name: string, description: string): Skill => ({
  name, description, source: 'project', path: `${HOME}/projects/${folder}/.claude/skills/${name}/SKILL.md`,
});
const plugin = (pack: string, name: string, description: string): Skill => ({
  name, description, source: 'plugin', path: `${HOME}/.claude/plugins/cache/${pack}/skills/${name}/SKILL.md`,
});

const COMMON: readonly Skill[] = [
  user('cc-prompt', 'Write a brief for a Claude Code session: objective, context, done when, scope, stop and ask, verify and report.'),
  user('frontend-design', 'A considered look for web pages and components, without templated defaults.'),
  plugin('superpowers', 'test-driven-development', 'Write the failing test first, then the code that makes it pass.'),
  plugin('superpowers', 'systematic-debugging', 'Find the root cause of a bug before proposing a fix.'),
];

/** What each host has installed (Orchard has the most project skills). */
export const PREVIEW_SKILLS: Readonly<Record<HostId, readonly Skill[]>> = {
  cedar: [
    ...COMMON,
    project('meadow-vat', 'vat-return', 'Prepare a VAT return from the ledger export and check the totals.'),
    project('meadow-hr', 'payroll-run', 'Run the monthly payroll export and compare it with last month.'),
  ],
  birch: [
    ...COMMON,
    project('app-backend', 'migrations', 'Write and check a database migration for the Orchard API.'),
    project('app-backend', 'api-contract', 'Keep the OpenAPI file and the handlers in step.'),
    project('app-frontend', 'store-screenshots', 'Take App Store and Play Store screenshots on the simulators.'),
    plugin('atlassian', 'jira-ticket', 'Read a Jira ticket with its comments and sub-tasks before starting work.'),
  ],
  ash: [
    ...COMMON,
    project('harbor-web-app', 'rtl-check', 'Check every page in Arabic, right to left, at phone and desktop sizes.'),
    user('harbor-copy', 'Write Harbor marketing copy in English and Arabic.'),
  ],
  local: [
    ...COMMON,
    user('image-prompt', 'Write a prompt for a GPT image and save the result in the inbox.'),
    project('research-desk', 'deep-research', 'Search widely, read the sources and write a short report with links.'),
  ],
  [SELF_HOST_ID]: [],
};

export function skillsOf(host: HostId): CtlSkills {
  return { skills: (PREVIEW_SKILLS[host] ?? []).map((skill) => ({ ...skill })) };
}

/** `~/luady-kb/` on one host: what `kb-put` wrote last, so a test can read it back. */
export interface KbFolder {
  put(files: readonly CtlKbFile[], prune: boolean): CtlKbPut;
  files(): ReadonlyMap<string, string>;
}

export function createKbFolder(): KbFolder {
  let files: ReadonlyMap<string, string> = new Map();
  return {
    put(input, prune) {
      const parsed = CtlKbPutInputSchema.safeParse({ files: input.map((f) => ({ path: f.path, content: f.content })), prune });
      if (!parsed.success) throw new CtlError('usage', `kb-put refused: ${parsed.error.issues[0]?.message ?? 'bad payload'}`, EXIT_USAGE);
      const sent = new Map(parsed.data.files.map((f) => [f.path, f.content]));
      const kept = prune ? [...files].filter(([path]) => sent.has(path)) : [...files];
      const removed = files.size - kept.length;
      files = new Map([...kept, ...sent]);
      return { written: sent.size, removed };
    },
    files: () => files,
  };
}

const HOUR_MS = 3_600_000;

/** One entry per project folder; every third one has work that is not saved yet. */
export function gitStatusOf(paths: readonly string[], now: Date): CtlGitStatus {
  return {
    projects: paths.map((path, i) => ({
      path, name: path.slice(path.lastIndexOf('/') + 1), branch: i % 4 === 1 ? 'feature/checkout' : 'main',
      dirty: i % 3 === 0, ahead: i % 3 === 0 ? 2 : 0, behind: 0, lastCommitAt: new Date(now.getTime() - (i + 1) * HOUR_MS).toISOString(),
    })),
  };
}
