import type { ProjectDTO } from '@luady/shared';

/** Each project's automatic "Overview" page, built from the project scan only (no model). */

export const OVERVIEW_SLUG = 'overview';
export const OVERVIEW_TITLE = 'Overview';
const COMMITS_SHOWN = 5;
const SUBJECT_MAX = 100;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The body: folder, remote, branch, stack and the last commits. Nothing that changes without the project changing. */
export function overviewBody(project: ProjectDTO): string {
  const facts = [
    `- Folder: \`${project.path}\``,
    `- Remote: ${project.remote ?? 'none'}`,
    `- Branch: ${project.branch ?? 'unknown'}`,
    `- Stack: ${project.stack.length > 0 ? project.stack.join(', ') : 'not detected'}`,
  ];
  const commits = project.commits.slice(0, COMMITS_SHOWN).map((c) => `- ${c.date.slice(0, 10)} ${oneLine(c.subject, SUBJECT_MAX)} (\`${c.hash.slice(0, 7)}\`)`);
  return [
    `Project **${project.name}**, written by the hub from its project scan. Edit this page to keep your own version; it then stops updating.`,
    '',
    ...facts,
    '',
    '## Last commits',
    ...(commits.length > 0 ? commits : ['- none yet']),
    '',
  ].join('\n');
}
