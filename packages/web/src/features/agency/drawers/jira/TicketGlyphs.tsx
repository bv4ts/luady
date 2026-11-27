import type { JiraCategory } from '@luady/shared';

/** The colour family of an issue type: bug, story, task, epic, sub-task, anything else. */
export function typeTone(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('bug')) return 'bug';
  if (t.includes('story')) return 'story';
  if (t.includes('epic')) return 'epic';
  if (t.includes('sub')) return 'subtask';
  if (t.includes('task')) return 'task';
  return 'other';
}

/** "high", "low" or "medium" for the priority arrow. */
export function priorityTone(priority: string | null): 'high' | 'medium' | 'low' | null {
  if (priority === null) return null;
  const p = priority.toLowerCase();
  if (p.includes('high') || p.includes('critical') || p.includes('blocker') || p.includes('urgent')) return 'high';
  if (p.includes('low') || p.includes('minor') || p.includes('trivial')) return 'low';
  return 'medium';
}

export function TypeGlyph({ type }: { type: string }) {
  return <span className={`jira-type jira-type--${typeTone(type)}`} title={type} aria-label={type} role="img">{type.slice(0, 1).toUpperCase()}</span>;
}

const ARROWS = { high: '▲', medium: '=', low: '▼' } as const;

export function PriorityGlyph({ priority }: { priority: string | null }) {
  const tone = priorityTone(priority);
  if (tone === null || priority === null) return null;
  return <span className={`jira-prio jira-prio--${tone}`} title={`${priority} priority`} aria-label={`${priority} priority`} role="img">{ARROWS[tone]}</span>;
}

export function StatusLozenge({ name, category }: { name: string; category: JiraCategory }) {
  return <span className={`jira-lozenge jira-lozenge--${category}`} dir="auto">{name}</span>;
}
