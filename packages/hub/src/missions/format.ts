import { clock12, humanDuration } from '../core/time.js';

const LAST_MAX = 600;
const DONE_TEXT_MAX = 3000;

export type MissionPhase = 'working' | 'waiting' | 'idle' | 'done' | 'ended';

export interface MissionView {
  label: string;
  title: string;
  phase: MissionPhase;
  turns: number;
  openedAt: string;
  note: string | null;
  lastText: string | null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function phaseLine(view: MissionView, now: Date): string {
  const since = clock12(new Date(view.openedAt));
  const turns = view.turns === 1 ? '1 turn' : `${view.turns} turns`;
  switch (view.phase) {
    case 'working':
      return view.turns === 0 ? `⏳ Working · since ${since}` : `⏳ Working · ${turns} done · since ${since}`;
    case 'waiting':
      return '❓ Waiting for your answer (see the question message)';
    case 'idle':
      return `💤 Paused after ${turns} · since ${since}`;
    case 'done':
      return `✅ Done · ${turns} · ${humanDuration((now.getTime() - Date.parse(view.openedAt)) / 1000)}`;
    case 'ended':
      return '⏹ Session ended';
  }
}

/** The mission's status message; edited in place as the mission moves. */
export function renderStatus(view: MissionView, now: Date): string {
  const lines = [`📌 *Mission · ${view.label}*`];
  // Luady's own 2-6 word title, shown whole; never the instruction text a session received.
  if (view.title.trim() !== '') lines.push(`_${view.title.trim()}_`);
  lines.push(phaseLine(view, now));
  if (view.note) lines.push(`🗒 ${clip(view.note, LAST_MAX)}`);
  lines.push(`_Updated ${clock12(now)}_`);
  return lines.join('\n');
}

/** The one "done" message the owner gets at the end (with sound): Luady's summary, never the raw session output. */
export function formatMissionDone(view: MissionView, summary: string, now: Date): string {
  const took = humanDuration((now.getTime() - Date.parse(view.openedAt)) / 1000);
  const body = summary.trim().length > DONE_TEXT_MAX ? `${summary.trim().slice(0, DONE_TEXT_MAX - 1)}…` : summary.trim();
  return [`✅ *Mission done · ${view.label}* (${took})`, '', body].join('\n');
}

export function missionListLine(view: MissionView, now: Date): string {
  return `📌 *${view.label}* — ${phaseLine(view, now)}${view.title.trim() === '' ? '' : `\n   _${view.title.trim()}_`}`;
}
