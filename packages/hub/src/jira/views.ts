import type { JiraIssueDTO, JiraIssueDetailDTO, JiraView } from '@luady/shared';

/** The JQL behind each board view, the attention filter and how a move is matched by name. */

export const SPRINT_JQL = 'assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC';
export const MINE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
/** A board holds at most this many tickets (pages are followed up to it). */
export const BOARD_MAX = 100;

const HIGH_PRIORITIES = new Set(['highest', 'high', 'critical', 'blocker', 'urgent', 'p1', 'p0']);

export function jqlFor(view: Exclude<JiraView, 'attention'>): string {
  return view === 'sprint' ? SPRINT_JQL : MINE_JQL;
}

export function isHighPriority(priority: string | null): boolean {
  return priority !== null && HIGH_PRIORITIES.has(priority.trim().toLowerCase());
}

/** Needs attention: flagged, high priority, or changed since the owner last opened it. */
export function needsAttention(issue: JiraIssueDTO): boolean {
  return issue.flagged || isHighPriority(issue.priority) || issue.hasNews;
}

export type MoveMatch =
  | { readonly kind: 'one'; readonly id: string }
  | { readonly kind: 'none' | 'many'; readonly choices: string };

function choiceText(transitions: JiraIssueDetailDTO['transitions']): string {
  if (transitions.length === 0) return 'Jira offers no moves for it right now.';
  return `Choices: ${transitions.map((t) => (t.to === '' || t.to === t.name ? t.name : `${t.name} (to ${t.to})`)).join(', ')}.`;
}

/** `to` matched without case against transition names and target status names; one distinct transition or the choices. */
export function matchMove(transitions: JiraIssueDetailDTO['transitions'], to: string): MoveMatch {
  const wanted = to.trim().toLowerCase();
  const hits = transitions.filter((t) => t.name.toLowerCase() === wanted || t.to.toLowerCase() === wanted);
  const ids = [...new Set(hits.map((t) => t.id))];
  if (ids.length === 1) return { kind: 'one', id: ids[0]! };
  return { kind: ids.length === 0 ? 'none' : 'many', choices: choiceText(ids.length === 0 ? transitions : hits) };
}
