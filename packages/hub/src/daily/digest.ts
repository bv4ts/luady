import type { Db } from '../core/contracts.js';
import { zoneOffsetMs } from '../scheduler/zone.js';
import { managerName, ownerZone, SELF_HOST_ID, wallTimeToUtc } from '@luady/shared';

/** About 15 k tokens of activity text. */
export const DIGEST_CHARS_MAX = 60_000;
const OWNER_TEXT_MAX = 400;
const LUADY_TEXT_MAX = 300;
const PROMPT_MAX = 200;
const STOP_MAX = 600;

/**
 * UTC bounds of one calendar day in the owner's zone, "YYYY-MM-DD": from its local midnight to the next one, so a day
 * on a DST change is 23 or 25 hours long.
 */
export function ownerDayBounds(day: string): { from: string; to: string } {
  const [year, month, date] = day.split('-').map(Number);
  const tz = ownerZone();
  const start = wallTimeToUtc(tz, { year: year ?? 1970, month: month ?? 1, day: date ?? 1, hour: 0, minute: 0 });
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + 1));
  const end = wallTimeToUtc(tz, { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 });
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

function clip(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function ownerTime(iso: string): string {
  const at = new Date(iso);
  return new Date(at.getTime() + zoneOffsetMs(at)).toISOString().slice(11, 16);
}

interface MessageRow { role: string; channel: string | null; text: string; ts: string }
interface EventRow { label: string; type: string; ts: string; preview: string | null; reply: string | null }
interface QuestionRow { label: string | null; host: string; question: string | null; state: string; answer: string | null; created_at: string }
interface ActionRow { id: string; summary: string; status: string; actor: string; created_at: string }

function conversation(db: Db, from: string, to: string): string[] {
  const rows = db.prepare<[string, string], MessageRow>(
    "SELECT role, channel, text, ts FROM messages WHERE thread = 'manager' AND ts >= ? AND ts < ? ORDER BY ts",
  ).all(from, to);
  return rows.map((row) =>
    `- ${ownerTime(row.ts)} ${row.role === 'owner' ? `owner (${row.channel ?? '?'})` : managerName()}: ${clip(row.text, row.role === 'owner' ? OWNER_TEXT_MAX : LUADY_TEXT_MAX)}`);
}

function sessions(db: Db, from: string, to: string): string[] {
  const rows = db.prepare<[string, string, string], EventRow>(`
    SELECT COALESCE(s.host || ' · ' || s.display_name, e.host || ' · ' || COALESCE(e.session_id, '?')) AS label, e.type, e.ts,
           json_extract(e.payload_json, '$.data.prompt_preview') AS preview,
           json_extract(e.payload_json, '$.data.last_assistant_message') AS reply
    FROM events e LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.host != ? AND e.type IN ('prompt', 'stop') AND e.ts >= ? AND e.ts < ?
    ORDER BY label, e.ts`).all(SELF_HOST_ID, from, to);
  const lines: string[] = [];
  let current = '';
  for (const row of rows) {
    if (row.label !== current) {
      current = row.label;
      lines.push('', `### ${current}`);
    }
    if (row.type === 'prompt') lines.push(`- ${ownerTime(row.ts)} asked: ${clip(row.preview, PROMPT_MAX)}`);
    else lines.push(`- ${ownerTime(row.ts)} finished: ${clip(row.reply, STOP_MAX)}`);
  }
  return lines;
}

function questions(db: Db, from: string, to: string): string[] {
  const rows = db.prepare<[string, string], QuestionRow>(`
    SELECT s.host || ' · ' || s.display_name AS label, q.host, q.state, q.answer_json AS answer, q.created_at,
           json_extract(q.payload_json, '$.questions[0].question') AS question
    FROM questions q LEFT JOIN sessions s ON s.id = q.session_id
    WHERE q.created_at >= ? AND q.created_at < ? ORDER BY q.created_at`).all(from, to);
  return rows.map((row) =>
    `- ${ownerTime(row.created_at)} ${row.label ?? row.host}: ${clip(row.question, PROMPT_MAX)} → ${row.state}${row.answer ? ` (${clip(row.answer, PROMPT_MAX)})` : ''}`);
}

function actions(db: Db, from: string, to: string): string[] {
  const rows = db.prepare<[string, string], ActionRow>(
    'SELECT id, summary, status, actor, created_at FROM actions WHERE created_at >= ? AND created_at < ? ORDER BY created_at',
  ).all(from, to);
  return rows.map((row) => `- ${ownerTime(row.created_at)} ${row.id} (${row.actor}): ${clip(row.summary, PROMPT_MAX)} → ${row.status}`);
}

/** The hub's 0-token summary of one owner day, or null when nothing happened (no AI run needed). */
export function buildDigestActivity(db: Db, day: string): string | null {
  const { from, to } = ownerDayBounds(day);
  const parts: Array<[string, string[]]> = [
    [`Owner ↔ ${managerName()}`, conversation(db, from, to)],
    ['Sessions (asked / finished)', sessions(db, from, to)],
    ['Questions from sessions', questions(db, from, to)],
    ['Actions', actions(db, from, to)],
  ];
  if (parts.every(([, lines]) => lines.length === 0)) return null;
  const text = parts
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `## ${title}\n${lines.join('\n').trim()}`)
    .join('\n\n');
  return text.length <= DIGEST_CHARS_MAX ? text : `${text.slice(0, DIGEST_CHARS_MAX)}\n…(cut: ${text.length - DIGEST_CHARS_MAX} more characters)`;
}

/** Where the day's activity is written for Luady to Read (the injection itself stays short). */
export function digestFile(day: string): string {
  return `digest/${day}.md`;
}

export function digestPrompt(day: string): string {
  return [
    `Nightly digest for ${day} (owner time). Read ${digestFile(day)} (the day's activity, written by the hub), then:`,
    `1. Write memory/journal/${day}.md (at most 30 lines): what was done per project, decisions, open items.`,
    '2. Update memory/PROJECTS.md and memory/DECISIONS.md with durable facts only (and memory/USER.md if you learned something about the owner). Remove bullets that became false.',
    '3. Then reply exactly NO_UPDATE (the digest is not sent to the owner).',
  ].join('\n');
}
