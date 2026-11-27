import type { ActionDTO, SessionDTO } from '@luady/shared';
import type {
  Clock, Db, EventBus, HubEvents, Logger, MissionTracker, OutboundChannel, PhoneService, QuestionService, SessionService,
  SettingsService,
} from '../core/contracts.js';
import { flatText } from '../hosts/clean.js';
import { createBatcher } from './batcher.js';
import {
  endedLine, errorLine, finishedLine, formatConfirmation, formatEnded, formatError, formatFinished, sessionLabel,
} from './format.js';
import { isDuplicateFailure, passesQuietHours, shouldNotifyFinished } from './policy.js';
import { createQuestionNotifier } from './questions.js';
import { createAutoResumer } from './resume.js';
import { createTroubleReporter } from './trouble.js';

export interface NotifyDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  outbound: OutboundChannel;
  settings: SettingsService;
  questions: QuestionService;
  sessions: SessionService;
  phone: PhoneService;
  /** Open missions get a status message (edited per turn) instead of a "finished" message per turn. */
  missions?: Pick<MissionTracker, 'isOpen'>;
  /** When set, crashed or ended sessions go to Luady (who investigates and repairs) instead of straight to the owner. */
  toLuady?: (text: string) => Promise<void>;
  /** A drop of a session the pause really stopped is held until the pause is released (activity/pause.ts). */
  isHeld?: (sessionId: string) => boolean;
  /** Subscribes to pause releases; a held drop is then carried on or dropped. */
  onReleased?: (listener: (sessionId: string, sent: boolean) => void) => () => void;
}

const FAILURE_EXCERPT_MAX = 300;

export function createNotifyService(deps: NotifyDeps): { start(): void; stop(): void } {
  const notifier = createQuestionNotifier(deps);
  const batcher = createBatcher(deps);
  const trouble = deps.toLuady === undefined ? null : createTroubleReporter(deps.toLuady, deps.log);
  const lastFailureAt = new Map<string, number>();
  const confirmationsSent = new Set<string>();
  const remoteStmt = deps.db.prepare<[string], { turn_remote: number }>('SELECT turn_remote FROM sessions WHERE id = ?');
  let unsubscribers: Array<() => void> = [];

  const isRemoteTurn = (sessionId: string): boolean => remoteStmt.get(sessionId)?.turn_remote === 1;

  const muted = (): boolean => {
    const until = deps.settings.get().mute_until;
    return until !== null && Date.parse(until) > deps.clock.now().getTime();
  };

  /** Only when no mission tracker is wired (tests, degraded start): with missions, Luady summarises every turn. */
  async function onFinished(e: HubEvents['turn.finished']): Promise<void> {
    if (deps.missions !== undefined || e.session.origin === 'system' || muted()) return;
    const settings = deps.settings.get();
    const wanted = shouldNotifyFinished({
      durationSec: e.durationSec, remote: e.remote, away: settings.away, replay: e.replay,
      finishedMinSeconds: settings.finished_min_seconds,
    });
    if (!wanted || !passesQuietHours('finished', e.remote, deps.clock.now(), settings)) return;
    const label = sessionLabel(e.session);
    await batcher.push({
      kind: 'finished', text: formatFinished(label, e.durationSec, e.lastMessage),
      line: finishedLine(label, e.durationSec), link: { kind: 'session', refId: e.session.id },
    });
  }

  /** A worker session crashed or ended: Luady repairs it (not muted, not held for quiet hours: fixing is silent). */
  function handToLuady(session: SessionDTO, what: string): boolean {
    if (trouble === null || session.origin === 'system') return false;
    trouble.add(`- ${sessionLabel(session)} (${session.id}) ${what}`);
    return true;
  }

  function troubleFailed(session: SessionDTO, error: string): void {
    const now = deps.clock.now().getTime();
    if (isDuplicateFailure(lastFailureAt.get(session.id), now)) return;
    lastFailureAt.set(session.id, now);
    // The error text is the server's: one quoted line, so it can never pass for a line of the hub's or the owner's.
    handToLuady(session, `failed: ${JSON.stringify(flatText(error, FAILURE_EXCERPT_MAX))}`);
  }

  // A dropped API stream only needs a "carry on": the hub sends it, no Luady turn (Luady gets it if drops repeat).
  const resumer = trouble === null ? null : createAutoResumer({
    sessions: deps.sessions, clock: deps.clock, log: deps.log, onGiveUp: troubleFailed,
    ...(deps.isHeld === undefined ? {} : { isHeld: deps.isHeld }),
  });

  async function onSessionFailed(e: HubEvents['session.failed']): Promise<void> {
    if (e.replay) return;
    if (trouble !== null && e.session.origin !== 'system') {
      if (resumer?.tryResume(e.session, e.error) === true) return;
      troubleFailed(e.session, e.error);
      return;
    }
    await onFailure(e.session, e.error, e.replay);
  }

  async function onFailure(session: SessionDTO, error: string, replay: boolean): Promise<void> {
    if (replay || muted()) return;
    const now = deps.clock.now();
    if (!passesQuietHours('error', isRemoteTurn(session.id), now, deps.settings.get())) return;
    if (isDuplicateFailure(lastFailureAt.get(session.id), now.getTime())) return;
    lastFailureAt.set(session.id, now.getTime());
    const label = sessionLabel(session);
    // The reference says what it is: a session (the brain's own for a brain failure), never a chat message id. A
    // A chat reply to it still goes to the manager through the router (PIN-shape guard), never into the pane.
    const link = { kind: 'session' as const, refId: session.id };
    await batcher.push({ kind: 'error', text: formatError(label, error), line: errorLine(label), link });
  }

  async function onEnded(e: HubEvents['session.ended']): Promise<void> {
    if (!e.unexpected || e.replay || e.session.origin === 'system') return;
    if (handToLuady(e.session, `ended unexpectedly: ${e.reason}`)) return;
    if (muted()) return;
    if (!passesQuietHours('ended', isRemoteTurn(e.session.id), deps.clock.now(), deps.settings.get())) return;
    const label = sessionLabel(e.session);
    await batcher.push({ kind: 'ended', text: formatEnded(label, e.reason), line: endedLine(label, e.reason), link: null });
  }

  async function onAction(action: ActionDTO): Promise<void> {
    if (action.actor !== 'manager' || action.status !== 'pending_confirmation') return;
    if (confirmationsSent.has(action.id)) return;
    confirmationsSent.add(action.id);
    await deps.outbound.send(formatConfirmation(action.summary, action.id), { kind: 'action', refId: action.id });
  }

  function guarded<T>(event: string, fn: (payload: T) => Promise<void>): (payload: T) => void {
    return (payload) => {
      fn(payload).catch((err: unknown) => deps.log.error({ err, event }, 'notify: handler failed'));
    };
  }

  function start(): void {
    if (unsubscribers.length > 0) return;
    unsubscribers = [
      deps.bus.on('question.updated', guarded('question.updated', notifier.onQuestion)),
      deps.bus.on('turn.finished', guarded('turn.finished', onFinished)),
      deps.bus.on('session.failed', guarded('session.failed', onSessionFailed)),
      deps.bus.on('usage.notice', guarded('usage.notice', (e: HubEvents['usage.notice']) => onFailure(e.session, e.message, e.replay))),
      deps.bus.on('session.ended', guarded('session.ended', onEnded)),
      deps.bus.on('action.updated', guarded('action.updated', onAction)),
      ...(resumer === null || deps.onReleased === undefined ? [] : [deps.onReleased((id, sent) => resumer.release(id, sent))]),
    ];
    notifier.start();
    notifier.restore().catch((err: unknown) => deps.log.error({ err }, 'notify: restore failed'));
  }

  function stop(): void {
    for (const off of unsubscribers) off();
    unsubscribers = [];
    notifier.stop();
    batcher.stop();
    trouble?.stop();
    resumer?.stop();
  }

  return { start, stop };
}
