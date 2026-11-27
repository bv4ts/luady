import { randomInt, randomUUID } from 'node:crypto';
import { SELF_HOST_ID, isSelfHost, type AskQuestion, type CtlPane, type CtlPending, type CtlProjects, type CtlSysinfo, type HostId, type PermissionPreview } from '@luady/shared';
import type { CtlClient, StartArgs } from '../packages/hub/dist/core/contracts.js';
import { CtlError } from '../packages/hub/dist/core/errors.js';
import { createFakeAuth, type AuthVerb } from './fake-auth.ts';
import { createKbFolder, gitStatusOf, skillsOf } from './fake-kit-v21.ts';
import { createPauseFlags } from './fake-pause.ts';
import { transcriptWindow } from './transcript-window.ts';

export { RESUME_TEXT } from './fake-pause.ts';
export { transcriptWindow } from './transcript-window.ts';

export interface PreviewPane { readonly target: string; readonly sid: string; readonly cwd: string; readonly pendingQid: string | null }
export interface EmitOptions { readonly ageMs?: number }
/** A kit-2 permission carries a structured preview. */
export interface PermitOptions extends EmitOptions { readonly preview?: PermissionPreview }

export interface FakeKit {
  readonly host: HostId;
  readonly client: CtlClient;
  attach(onLine: (line: string) => void): void;
  emit(event: string, target: string | null, data: Readonly<Record<string, unknown>>, opts?: EmitOptions): void;
  addPane(name: string, cwd: string): PreviewPane;
  removePane(target: string): void;
  pane(target: string): PreviewPane | undefined;
  panes(): readonly PreviewPane[];
  /** `opts.ageMs` dates the question back, like `emit` (the seed uses it). */
  ask(target: string, questions: readonly AskQuestion[], opts?: EmitOptions): string;
  permit(target: string, toolName: string, inputPreview: string, opts?: PermitOptions): string;
  /** Kit 2: a pause was requested for this pane (`luady-ctl pause`). */
  isPaused(target: string): boolean;
  /** Kit 2: the after-tool check stopped the paused pane: the flag becomes hit and a `paused` line is spooled. */
  pauseHit(target: string): void;
  say(target: string, role: 'user' | 'assistant', text: string): void;
  /** The host's Claude sign-in ends at the terminal (fake-auth.ts); the hub learns it at its next check. */
  signOut(): void;
  onSend(fn: (target: string, text: string) => void): void;
  /** Kit 2.1: what `kb-put` left in `~/luady-kb/` (path relative to the folder → content). */
  kbFiles(): ReadonlyMap<string, string>;
}

type PendingEntry = CtlPending['pending'][number];
type SendListener = (target: string, text: string) => void;
interface TranscriptLine { readonly uuid: string; readonly line: string }

export const KIT_VERSION = { kit: '2.1.0', claude: '2.1.323', tmux: '3.4', python: '3.12.3' } as const;
const QID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const EXIT = { refused: 3, not_found: 4 } as const;
const TRANSCRIPT_DIR = '/home/dev/.claude/projects/preview';
const TOOL_USE_ID = 'toolu_preview';
/**
 * The real `projects` verb scans git folders over SSH and takes a moment. Distinct delays per host also keep the hub
 * from writing PROJECTS.auto.md for every server in the same instant (its writes share one temp file name).
 */
const PROJECTS_DELAY_MS: Readonly<Record<HostId, number>> = { cedar: 100, birch: 250, ash: 400, local: 550, [SELF_HOST_ID]: 0 };

export function transcriptPathFor(sid: string): string {
  return `${TRANSCRIPT_DIR}/${sid}.jsonl`;
}

/** The kit names tmux sessions `cc-<name>` (dots become underscores); the brain lives in `manager` on the self host. */
export function targetFor(host: HostId, name: string): string {
  return isSelfHost(host) ? 'manager:0.0' : `cc-${name.replace(/\./g, '_')}:0.0`;
}

function newQid(): string {
  return Array.from({ length: 8 }, () => QID_ALPHABET[randomInt(QID_ALPHABET.length)]).join('');
}

function spoolFile(at: Date): string {
  return `events-${at.toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`;
}

function notFound(message: string): CtlError {
  return new CtlError('not_found', message, EXIT.not_found);
}

function toCtlPane(pane: PreviewPane, index: number): CtlPane {
  return {
    target: pane.target, tmux_session: pane.target.split(':')[0] ?? pane.target, pane_pid: 1000 + index, command: 'claude',
    cwd: pane.cwd, is_claude: true, session_id: pane.sid, transcript_path: transcriptPathFor(pane.sid), registered: true,
    pending_qid: pane.pendingQid,
  };
}

/** Verbs with nothing to remember: the same minimal valid objects as the hub's own `createFakeCtl`. */
function quietVerbs(sysinfo: CtlSysinfo): Omit<CtlClient, LiveVerb | AuthVerb | KitV21Verb> {
  return {
    version: async () => ({ ...KIT_VERSION }),
    sysinfo: async () => ({ ...sysinfo }),
    keys: async () => undefined,
    capture: async () => '',
    updateClaude: async () => ({ before: KIT_VERSION.claude, after: KIT_VERSION.claude, output: '' }),
    exec: async () => ({ exit: 0, stdout: '', stderr: '', truncated: false, timed_out: false }),
    fileRead: async (path) => ({ path, size: 0, content: '', truncated: false }),
    fileGet: async (path) => ({ path, size: 1, b64: 'AA==' }),
    filePut: async (name, b64) => ({ path: `/home/dev/luady-inbox/${name}`, size: Math.floor((b64.length * 3) / 4) }),
    graphifyRun: async (path) => ({ path, seconds: 1, report: '# Graph Report\n', tail: '' }),
    graphQuery: async (path) => ({ path, built_at: '2026-11-14 02:00', text: '' }),
    fileWrite: async (_path, content) => ({ ok: true, bytes: Buffer.byteLength(content, 'utf8') }),
    getConfig: async () => ({ remote_answering: true, hook_wait_seconds: 14400, host_alias: 'preview' }),
    setConfig: async () => ({ remote_answering: true, hook_wait_seconds: 14400, host_alias: 'preview' }),
  };
}

type KitV21Verb = 'skills' | 'kbPut' | 'gitStatus';
type LiveVerb = 'sessions' | 'pending' | 'answer' | 'permission' | 'send' | 'start' | 'stop' | 'restart' | 'remove' | 'transcript'
  | 'projects' | 'pause' | 'resume';

/** One project per folder a pane works in, like the kit's git scan (without commits). */
function projectsOf(panes: readonly PreviewPane[]): CtlProjects['projects'] {
  const paths = [...new Set(panes.map((p) => p.cwd).filter((cwd) => cwd.startsWith('/home/dev/projects/')))].sort();
  return paths.map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), remote: null, branch: 'main', commits: [], stack: [] }));
}

export function createFakeKit(host: HostId, deps: { clock: () => Date; sysinfo: CtlSysinfo }): FakeKit {
  let panes: readonly PreviewPane[] = [];
  let pending: readonly PendingEntry[] = [];
  let transcripts: ReadonlyMap<string, readonly TranscriptLine[]> = new Map();
  let backlog: readonly string[] = [];
  let listener: ((line: string) => void) | null = null;
  let sendListeners: readonly SendListener[] = [];
  let offset = 0;
  const flags = createPauseFlags();

  const pane = (target: string): PreviewPane | undefined => panes.find((p) => p.target === target);
  const requirePane = (target: string): PreviewPane => {
    const found = pane(target);
    if (found === undefined) throw notFound(`no Claude pane ${target} on ${host}`);
    return found;
  };
  const setPendingQid = (target: string, pendingQid: string | null): void => {
    panes = panes.map((p) => (p.target === target ? { ...p, pendingQid } : p));
  };

  function deliver(line: string): void {
    if (listener === null) backlog = [...backlog, line];
    else listener(line);
  }

  function emit(event: string, target: string | null, data: Readonly<Record<string, unknown>>, opts: EmitOptions = {}): void {
    const at = deps.clock();
    const found = target === null ? undefined : pane(target);
    const record = {
      v: 1, id: randomUUID(), ts: new Date(at.getTime() - (opts.ageMs ?? 0)).toISOString(), host, event,
      session_id: found?.sid ?? null, cwd: found?.cwd ?? null, transcript_path: found ? transcriptPathFor(found.sid) : null,
      tmux: target, permission_mode: 'bypassPermissions', data,
    };
    offset += Buffer.byteLength(JSON.stringify(record)) + 1;
    deliver(JSON.stringify({ file: spoolFile(at), offset, event: record }));
  }

  function addPane(name: string, cwd: string): PreviewPane {
    const created: PreviewPane = { target: targetFor(host, name), sid: randomUUID(), cwd, pendingQid: null };
    panes = [...panes.filter((p) => p.target !== created.target), created];
    return created;
  }

  function removePane(target: string): void {
    panes = panes.filter((p) => p.target !== target);
    pending = pending.filter((entry) => entry.tmux !== target);
    flags.drop(target);
  }

  function hold(kind: PendingEntry['kind'], target: string, opts: EmitOptions): { qid: string; sid: string } {
    const found = requirePane(target);
    const qid = newQid();
    const createdAt = new Date(deps.clock().getTime() - (opts.ageMs ?? 0)).toISOString();
    pending = [...pending, { qid, kind, created_at: createdAt, session_id: found.sid, tmux: target }];
    setPendingQid(target, qid);
    return { qid, sid: found.sid };
  }

  function ask(target: string, questions: readonly AskQuestion[], opts: EmitOptions = {}): string {
    const { qid } = hold('question', target, opts);
    emit('question', target, { qid, tool_use_id: TOOL_USE_ID, questions: [...questions] }, opts);
    return qid;
  }

  function permit(target: string, toolName: string, inputPreview: string, opts: PermitOptions = {}): string {
    const { qid } = hold('permission', target, opts);
    const preview = opts.preview === undefined ? {} : { preview: opts.preview };
    emit('permission', target, { qid, tool_name: toolName, input_preview: inputPreview, ...preview }, opts);
    return qid;
  }

  function resolve(qid: string, kind: PendingEntry['kind'], outcome: string): void {
    const entry = pending.find((item) => item.qid === qid && item.kind === kind);
    if (entry === undefined) throw notFound(`no pending ${kind} ${qid}`);
    pending = pending.filter((item) => item.qid !== qid);
    if (entry.tmux !== null) setPendingQid(entry.tmux, null);
    emit(kind === 'question' ? 'question_resolved' : 'permission_resolved', entry.tmux, { qid, outcome });
  }

  function say(target: string, role: 'user' | 'assistant', text: string): void {
    const found = requirePane(target);
    const previous = transcripts.get(found.sid) ?? [];
    const uuid = randomUUID();
    const record = {
      type: role, uuid, parentUuid: previous.at(-1)?.uuid ?? null, sessionId: found.sid, timestamp: deps.clock().toISOString(),
      cwd: found.cwd, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    };
    transcripts = new Map([...transcripts, [found.sid, [...previous, { uuid, line: JSON.stringify(record) }]]]);
  }

  /** Claude reacts after the verb returns, never inside the hub's own call. */
  function typed(target: string, text: string): void {
    for (const fn of sendListeners) setImmediate(() => fn(target, text));
  }

  function liveVerbs(): Pick<CtlClient, LiveVerb> {
    return {
      sessions: async () => ({ sessions: panes.map((p, i) => ({ ...toCtlPane(p, i), paused: flags.isPaused(p.target) })) }),
      pending: async () => ({ pending: [...pending] }),
      answer: async (qid, payload) => resolve(qid, 'question', 'release' in payload ? 'released' : 'answered'),
      permission: async (qid, payload) => {
        const outcome = 'release' in payload ? 'released' : payload.behavior === 'allow' ? 'allowed' : 'denied';
        resolve(qid, 'permission', outcome);
      },
      send: async (target, text) => {
        if (requirePane(target).pendingQid !== null) throw new CtlError('refused', `${target} is waiting for an answer`, EXIT.refused);
        say(target, 'user', text);
        typed(target, text);
      },
      start: async (args) => startPane(args),
      stop: async (target, force) => {
        requirePane(target);
        emit('session_end', target, { reason: 'prompt_input_exit' });
        removePane(target);
        return { ok: true, forced: force };
      },
      restart: async (target) => {
        requirePane(target);
        emit('session_start', target, { source: 'resume', model: 'opus' });
      },
      remove: async (sessionId) => {
        const found = panes.find((p) => p.sid === sessionId);
        if (found !== undefined) removePane(found.target);
        return { ok: true, trashed: `/home/dev/.luady/trash/${sessionId}.jsonl` };
      },
      projects: async () => {
        await new Promise((done) => setTimeout(done, PROJECTS_DELAY_MS[host]));
        return { projects: projectsOf(panes) };
      },
      transcript: async (sessionId, window) =>
        transcriptWindow(transcriptPathFor(sessionId), (transcripts.get(sessionId) ?? []).map((entry) => entry.line), window),
      ...flags.verbs({
        requirePane,
        canType: (target) => pane(target)?.pendingQid === null,
        type: (target, text) => {
          say(target, 'user', text);
          typed(target, text);
        },
      }),
    };
  }

  function startPane(args: StartArgs): { ok: true; target: string } {
    const target = targetFor(host, args.name);
    if (pane(target) !== undefined) throw new CtlError('refused', `tmux session ${target.split(':')[0]} already exists`, EXIT.refused);
    const created = addPane(args.name, args.cwd);
    emit('session_start', created.target, { source: args.resume === undefined ? 'startup' : 'resume', model: args.model ?? 'opus' });
    if (args.prompt !== undefined) {
      say(created.target, 'user', args.prompt);
      typed(created.target, args.prompt);
    }
    return { ok: true, target: created.target };
  }

  const auth = createFakeAuth(host, deps.clock);
  const { signOut, ...authVerbs } = auth;
  const kb = createKbFolder();
  const v21: Pick<CtlClient, KitV21Verb> = {
    skills: async () => skillsOf(host),
    kbPut: async (files, prune) => kb.put(files, prune),
    gitStatus: async () => gitStatusOf(projectsOf(panes).map((p) => p.path), deps.clock()),
  };
  const client: CtlClient = { ...quietVerbs(deps.sysinfo), ...authVerbs, ...liveVerbs(), ...v21 };

  return {
    host,
    client,
    attach(onLine) {
      listener = onLine;
      const queued = backlog;
      backlog = [];
      for (const line of queued) onLine(line);
    },
    emit,
    addPane,
    removePane,
    pane,
    panes: () => panes,
    ask,
    permit,
    isPaused: (target) => flags.isPaused(target),
    pauseHit(target) {
      flags.hit(target);
      emit('paused', target, {});
    },
    say,
    signOut,
    onSend(fn) {
      sendListeners = [...sendListeners, fn];
    },
    kbFiles: () => kb.files(),
  };
}
