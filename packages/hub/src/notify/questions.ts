import type { QuestionDTO } from '@luady/shared';
import type {
  Clock, Db, EventBus, HubEvents, Logger, OutboundChannel, PhoneService, QuestionService, SessionService, SettingsService,
} from '../core/contracts.js';
import { inQuietHours } from '../core/time.js';
import { formatPending, questionLabel } from './format.js';
import { canEscalate, escalationDueAt } from './policy.js';

export interface QuestionNotifierDeps {
  db: Db;
  bus: Pick<EventBus, 'on'>;
  clock: Clock;
  log: Logger;
  /** The notice facade: with the website on it returns null and the red message comes later, by the fallback. */
  outbound: OutboundChannel;
  settings: SettingsService;
  questions: QuestionService;
  sessions: SessionService;
  phone: PhoneService;
}

export interface QuestionNotifier {
  onQuestion(question: QuestionDTO): Promise<void>;
  restore(): Promise<void>;
  /** Listens for a red question the fallback put on the chat: it is pinned and its escalation starts then. */
  start(): void;
  stop(): void;
}

interface QuestionRow {
  qid: string;
  created_at: string;
  notified_at: string | null;
  escalated_at: string | null;
}

/** Chat pins last 24 h, 7 d or 30 d; a question rarely waits longer than a day. */
const QUESTION_PIN_SECONDS = 86_400;

export function createQuestionNotifier(deps: QuestionNotifierDeps): QuestionNotifier {
  const timers = new Map<string, NodeJS.Timeout>();
  const inflight = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  const sentMessages = deps.db.prepare<[string], { msg_id: string }>(
    "SELECT msg_id FROM channel_links WHERE kind = 'question' AND ref_id = ?",
  );
  // When the red message reached the chat, or was due to: its reply link, its notice's send (also when the channel
  // queued it) or the notice's fallback time (the clock keeps running while the link is down or the hub is away).
  const reachedChat = deps.db.prepare<[string, string], { at: string | null }>(
    `SELECT MIN(at) AS at FROM (
       SELECT created_at AS at FROM channel_links WHERE kind = 'question' AND ref_id = ?
       UNION ALL SELECT MIN(COALESCE(chat_sent_at, chat_due_at), COALESCE(chat_due_at, chat_sent_at)) AS at FROM notices
         WHERE ref_kind = 'question' AND ref_id = ? AND (chat_sent_at IS NOT NULL OR chat_due_at IS NOT NULL))`,
  );
  const selectRow = deps.db.prepare<[string], QuestionRow>(
    'SELECT qid, created_at, notified_at, escalated_at FROM questions WHERE qid = ?',
  );
  const selectOpen = deps.db.prepare<[], QuestionRow>(
    `SELECT qid, created_at, notified_at, escalated_at FROM questions
     WHERE state = 'pending' AND (notified_at IS NULL OR escalated_at IS NULL) ORDER BY created_at`,
  );

  function cancel(qid: string): void {
    const timer = timers.get(qid);
    if (timer) clearTimeout(timer);
    timers.delete(qid);
  }

  async function send(question: QuestionDTO): Promise<void> {
    inflight.add(question.qid);
    try {
      const label = questionLabel(question, deps.sessions.get(question.sessionId));
      const msgId = await deps.outbound.send(formatPending(label, question), { kind: 'question', refId: question.qid });
      deps.questions.markNotified(question.qid);
      if (msgId !== null) deps.outbound.pin?.(msgId, true, QUESTION_PIN_SECONDS);
      schedule(question.qid);
    } catch (err) {
      deps.log.error({ err, qid: question.qid }, 'notify: question send failed');
    } finally {
      inflight.delete(question.qid);
    }
  }

  async function escalate(qid: string): Promise<void> {
    timers.delete(qid);
    const settings = deps.settings.get();
    const allowed = canEscalate({
      pending: deps.questions.get(qid)?.state === 'pending',
      alreadyEscalated: (selectRow.get(qid)?.escalated_at ?? null) !== null,
      phoneEnabledSetting: settings.phone_enabled,
      phoneAvailable: deps.phone.enabled(),
      quiet: inQuietHours(deps.clock.now(), settings.quiet_hours),
      nightCalls: settings.night_calls,
    });
    if (!allowed) return;
    try {
      await deps.phone.callForQuestion(qid);
      deps.questions.markEscalated(qid);
    } catch (err) {
      deps.log.error({ err, qid }, 'notify: escalation call failed');
    }
  }

  /** Counted from when the red message reached the chat or was due to (the website-first fallback time). */
  function schedule(qid: string): void {
    if (timers.has(qid) || (selectRow.get(qid)?.escalated_at ?? null) !== null) return;
    const base = reachedChat.get(qid, qid)?.at ?? null;
    if (base === null) return;
    const due = escalationDueAt(base, deps.settings.get().escalate_after_min);
    const delay = Math.max(0, due - deps.clock.now().getTime());
    timers.set(qid, setTimeout(() => void escalate(qid), delay));
  }

  async function onQuestion(question: QuestionDTO): Promise<void> {
    if (question.state !== 'pending') {
      cancel(question.qid);
      // Every message linked to the question (the pinned one, or a re-send from /status) loses its pin.
      for (const row of sentMessages.all(question.qid)) deps.outbound.pin?.(row.msg_id, false);
      return;
    }
    const row = selectRow.get(question.qid);
    if (!row) {
      deps.log.warn({ qid: question.qid }, 'notify: question row missing');
      return;
    }
    schedule(row.qid);
    if (row.notified_at !== null || inflight.has(question.qid)) return;
    await send(question);
  }

  function onDelivered({ notice, msgId }: HubEvents['notice.delivered']): void {
    if (notice.ref?.kind !== 'question') return;
    const qid = notice.ref.id;
    if (deps.questions.get(qid)?.state !== 'pending') return;
    if (msgId !== null) deps.outbound.pin?.(msgId, true, QUESTION_PIN_SECONDS);
    schedule(qid);
  }

  async function restore(): Promise<void> {
    for (const row of selectOpen.all()) {
      const question = deps.questions.get(row.qid);
      if (question) await onQuestion(question);
    }
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    onQuestion,
    restore,
    start() {
      if (unsubscribe === null) unsubscribe = deps.bus.on('notice.delivered', onDelivered);
    },
    stop,
  };
}
