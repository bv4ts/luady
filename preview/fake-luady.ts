import { NAME_RE, isHostId, isSelfHost, type HostId, type SessionDTO } from '@luady/shared';
import { PREVIEW_PROJECTS_ROOT } from './config.ts';
import type { FakeKit } from './fake-kit.ts';
import { promptData } from './seed.ts';

/**
 * The preview's Luady without a model. He answers the owner in two seconds, answers a note he is sent, and reacts to a
 * Run or Give event from the board in a fixed way: one session per suggested group (an idle one of that project is
 * reused), started or messaged through the hub's own tool path with `todos`, exactly as the real brain does.
 */


/** A host id the office may delegate to: any valid one but the manager's own (the hub checks it exists). */
const isOfficeHost = (value: string): boolean => isHostId(value) && !isSelfHost(value);
export const LUADY_REPLY = 'Preview Luady: got it.';
export const NO_UPDATE = 'NO_UPDATE';
const REPLY_DELAY_MS = 2_000;
const THINK_MS = 1_200;

export type DelegateTarget = { readonly kind: 'auto' } | { readonly kind: 'session'; readonly sessionId: string } | { readonly kind: 'server'; readonly server: HostId };
export interface DelegateGroup { readonly server: HostId | null; readonly project: string | null; readonly ids: readonly number[] }
export interface Delegation {
  readonly runId: string;
  readonly target: DelegateTarget;
  readonly cards: ReadonlyMap<number, string>;
  readonly groups: readonly DelegateGroup[];
}

const ids = (text: string): number[] => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

function parseTarget(lines: readonly string[]): DelegateTarget | null {
  const line = lines.find((l) => l.startsWith('Target: '));
  if (line === undefined) return null;
  if (line.startsWith('Target: you decide')) return { kind: 'auto' };
  const session = /^Target: the session .* \(([^,()]+), [a-z_]+\)\. Give it every card\.$/.exec(line);
  if (session !== null) return { kind: 'session', sessionId: session[1]! };
  const server = /^Target: a new session in (\w+)\./.exec(line)?.[1];
  return server !== undefined && isOfficeHost(server) ? { kind: 'server', server } : null;
}

function parseCards(lines: readonly string[]): Map<number, string> {
  const cards = new Map<number, string>();
  for (const line of lines) {
    const match = /^- #(\d+) · .*? · ("(?:[^"\\]|\\.)*") · /.exec(line);
    if (match === null) continue;
    try {
      cards.set(Number(match[1]), JSON.parse(match[2]!) as string);
    } catch {
      cards.set(Number(match[1]), `Card #${match[1]}`);
    }
  }
  return cards;
}

function parseGroups(lines: readonly string[]): DelegateGroup[] {
  return lines.flatMap((line): DelegateGroup[] => {
    const loose = /^- No project: ((?:#\d+(?:, )?)+)/.exec(line);
    if (loose !== null) return [{ server: null, project: null, ids: ids(loose[1]!) }];
    const group = /^\d+\. (.+?) · (.+): ((?:#\d+(?:, )?)+)$/.exec(line);
    if (group === null) return [];
    const office = group[1]!;
    const project = group[2]!.startsWith('project not set') ? null : group[2]!;
    return [{ server: isOfficeHost(office) ? office : null, project, ids: ids(group[3]!) }];
  });
}

/** The Run or Give event the board sends (board/delegate-text.ts), or null for any other text. */
export function parseDelegation(text: string): Delegation | null {
  const runId = /(?:Run|Give) from the board \(run (r_[0-9a-f]+)\)/.exec(text)?.[1];
  if (runId === undefined) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const target = parseTarget(lines);
  if (target === null) return null;
  const cards = parseCards(lines);
  const groups = target.kind === 'session' ? [{ server: null, project: null, ids: [...cards.keys()] }] : parseGroups(lines);
  return { runId, target, cards, groups };
}

/** A tmux-safe session name for a project folder. */
export function sessionNameFor(project: string): string {
  const name = project.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return NAME_RE.test(name) && name !== '' ? name : 'board-work';
}

export function briefFor(project: string, cardIds: readonly number[], cards: ReadonlyMap<number, string>): string {
  return [
    `Objective: work through these board cards for ${project}.`,
    ...cardIds.map((id, i) => `${i + 1}. #${id} ${cards.get(id) ?? ''}`.trimEnd()),
    'Done when: each card is finished, tested and reported.',
  ].join('\n');
}

/** Luady's tools as the brain calls them (the hub's internal tool route). Resolves to the tool's answer text. */
export type ToolCall = (name: string, args: Readonly<Record<string, unknown>>) => Promise<string>;

export interface FakeLuadyDeps {
  readonly kit: FakeKit;
  readonly tools: ToolCall;
  readonly sessions: () => readonly SessionDTO[];
  /** True when a tmux session of that name already runs on the server. */
  readonly paneExists: (server: HostId, name: string) => boolean;
  readonly wait: (ms: number) => Promise<void>;
  readonly log?: (text: string) => void;
}

const projectOf = (s: SessionDTO): string => (s.project ?? s.cwd?.slice(s.cwd.lastIndexOf('/') + 1) ?? '').toLowerCase();

function freeName(deps: FakeLuadyDeps, server: HostId, project: string): string {
  const base = sessionNameFor(project);
  for (let i = 1; i < 20; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!deps.paneExists(server, name)) return name;
  }
  return `${base}-${Date.now() % 10_000}`;
}

async function runGroup(deps: FakeLuadyDeps, plan: Delegation, group: DelegateGroup): Promise<void> {
  if (plan.target.kind === 'session') {
    const brief = briefFor('this session', group.ids, plan.cards);
    await deps.tools('session_send', { session: plan.target.sessionId, text: brief, todos: [...group.ids] });
    return;
  }
  if (group.server === null || group.project === null) {
    for (const id of group.ids) {
      await deps.tools('todo_update', { id, state: 'review', note: 'Luady: which office and project is this for? Add them and press Run again.' });
    }
    return;
  }
  const { server, project } = group;
  const idle = deps.sessions().find((s) => s.host === server && s.state === 'idle' && s.pendingQid === null && projectOf(s) === project.toLowerCase());
  const brief = briefFor(project, group.ids, plan.cards);
  if (idle !== undefined) {
    await deps.tools('session_send', { session: idle.id, text: brief, todos: [...group.ids] });
    return;
  }
  const name = freeName(deps, server, project);
  await deps.tools('session_start', { server, cwd: `${PREVIEW_PROJECTS_ROOT}/${sessionNameFor(project)}`, name, prompt: brief, todos: [...group.ids] });
}

/** Carries out a Run or Give event; a failing group never stops the others. */
export async function carryOut(deps: FakeLuadyDeps, plan: Delegation): Promise<void> {
  for (const group of plan.groups) {
    try {
      await runGroup(deps, plan, group);
    } catch (err) {
      deps.log?.(`fake Luady: a group of run ${plan.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The note a discussed note points at, so the fake Luady can add its follow-up card the way the real one does. */
export function noteRefOf(text: string): { id: string; title: string } | null {
  const note = /\(About the note ("(?:[^"\\]|\\.)*"), id ([nm]:[^ .]+)/.exec(text);
  if (note === null) return null;
  try {
    return { id: note[2]!, title: JSON.parse(note[1]!) as string };
  } catch {
    return { id: note[2]!, title: 'the note' };
  }
}

/** What the fake Luady answers: a short reading of a note, nothing for the board's own events, else a nod. */
export function replyFor(text: string): string {
  if (parseDelegation(text) !== null) return NO_UPDATE;
  if (/Your mission .* (reports while still working|finished a turn)/.test(text)) return NO_UPDATE;
  const note = noteRefOf(text);
  if (note === null) return LUADY_REPLY;
  return `I read "${note.title}". Two things stand out: the checkout fix comes first, and the release notes need an owner. `
    + 'I added a card for the follow-up. Shall I start on the checkout fix now?';
}

/** One turn of the luady pane: the prompt, Luady acts, and the turn ends with his reply. */
async function takeTurn(deps: FakeLuadyDeps, target: string, text: string): Promise<void> {
  if (deps.kit.pane(target) === undefined) return;
  deps.kit.emit('prompt', target, promptData(text));
  const plan = parseDelegation(text);
  const note = plan === null ? noteRefOf(text) : null;
  await deps.wait(plan === null ? REPLY_DELAY_MS : THINK_MS);
  if (plan !== null) await carryOut(deps, plan);
  if (note !== null) {
    await deps.tools('todo_add', { text: `Follow up on "${note.title}"`, source: 'note', source_ref: note.id })
      .catch((err: unknown) => deps.log?.(`fake Luady: todo_add failed: ${String(err)}`));
  }
  if (deps.kit.pane(target) === undefined) return;
  const reply = replyFor(text);
  deps.kit.emit('stop', target, { last_assistant_message: reply, truncated: false });
  deps.kit.say(target, 'assistant', reply);
}

/**
 * The luady pane's `onSend`. Like Claude Code it takes one turn at a time: a message typed during a turn waits, and its
 * prompt starts its own turn after that turn's stop. The hub reads each turn's source from its prompt, so a Run from
 * the website is the owner's turn and its session start needs no PIN, as with the real manager.
 */
export function createFakeLuady(deps: FakeLuadyDeps): (target: string, text: string) => void {
  let turns: Promise<void> = Promise.resolve();
  return (target, text) => {
    const pane = deps.kit.pane(target);
    if (pane === undefined || pane.pendingQid !== null) return;
    turns = turns.then(() => takeTurn(deps, target, text)).catch((err: unknown) => {
      deps.log?.(`fake Luady: a turn failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

