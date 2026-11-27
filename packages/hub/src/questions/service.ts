import { hiddenNote, permissionAllowOffered, type Channel, type HostId, type PermissionAnswerFile, type QuestionDTO, type ServerDTO } from '@luady/shared';
import type { Clock, CtlClient, Db, EventBus, Fleet, Logger, MemoryService, QuestionService } from '../core/contracts.js';
import { CtlError, NotFoundError, QuestionClosedError, ValidationError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import { createQuestionIntake } from './intake.js';
import { createQuestionsRepo, toQuestionDto, type QuestionKind, type QuestionRecord, type QuestionState } from './repo.js';
import { PERMISSION_MESSAGE_MAX, answerText, assertNotPinMessage, validateAnswers } from './validate.js';

export interface QuestionDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  fleet: Fleet;
  memory: MemoryService;
  log: Logger;
}

/** Questions younger than this may be missing from a `pending` snapshot taken while they were being created. */
export const RECONCILE_GRACE_MS = 10_000;

interface Claim {
  state: QuestionState;
  answerJson: string;
  via: Channel;
  memo: string | null;
}

interface PermissionReply {
  payload: PermissionAnswerFile;
  memo: string;
}

function permissionAnswer(qid: string, behavior: 'allow' | 'deny', message: string | undefined): PermissionReply {
  const payload: PermissionAnswerFile = message === undefined ? { behavior } : { behavior, message };
  const memo = `↩ #${qid} ${behavior === 'allow' ? 'allowed' : 'denied'}${message === undefined ? '' : `: ${message}`}`;
  return { payload, memo };
}

/** Allow only when the request offers it: one shown redacted or cut is denied or answered in the terminal. */
function requireAllowOffered(record: QuestionRecord): void {
  const { toolName, inputPreview, preview } = record.payload;
  const offer = { toolName: toolName ?? 'unknown', inputPreview: inputPreview ?? '', preview };
  if (!permissionAllowOffered(offer)) throw new ValidationError(hiddenNote(offer));
}

/** "Allow always" goes with Allow only, and only when the kit offered it in the stored preview. */
function allowAlways(record: QuestionRecord, behavior: 'allow' | 'deny', message: string | undefined): PermissionReply {
  if (behavior !== 'allow') throw new ValidationError('Allow always goes with Allow');
  if (record.payload.preview?.always == null) throw new ValidationError('Allow always is not offered for this request');
  const payload: PermissionAnswerFile = message === undefined
    ? { behavior: 'allow', always: true }
    : { behavior: 'allow', message, always: true };
  return { payload, memo: `↩ #${record.qid} allowed for the rest of the session` };
}

export function createQuestionService(
  deps: QuestionDeps,
): QuestionService & { start(): void; stop(): void; reconciled(host: HostId): boolean } {
  const repo = createQuestionsRepo(deps.db, deps.log);
  const intake = createQuestionIntake({ repo, bus: deps.bus, memory: deps.memory, log: deps.log });
  const statuses = new Map<HostId, ServerDTO['status']>();
  let unsubscribers: Array<() => void> = [];
  /** Servers whose pending questions were compared with the kit since the hub started. */
  let reconciledHosts: ReadonlySet<string> = new Set();

  function requireOpen(qid: string, kind: QuestionKind | null): QuestionRecord {
    const record = repo.get(qid);
    if (record === undefined) throw new NotFoundError(`unknown question #${qid}`);
    if (record.state !== 'pending') throw new QuestionClosedError(record.state, `#${qid} was already ${record.state}`);
    if (kind !== null && record.kind !== kind) throw new ValidationError(`#${qid} is a ${record.kind} request`);
    return record;
  }

  function noteAnswer(record: QuestionRecord, claim: Claim): void {
    if (claim.memo === null) return;
    try {
      deps.memory.record({ thread: `session:${record.sessionId}`, role: 'owner', channel: claim.via, text: claim.memo });
    } catch (err) {
      deps.log.warn({ qid: record.qid, err: err instanceof Error ? err.message : String(err) }, 'cannot record answer text');
    }
  }

  function failDelivery(record: QuestionRecord, claim: Claim, err: unknown): unknown {
    if (err instanceof CtlError && err.code === 'not_found') {
      repo.expireClaim(record.qid, claim.state, isoNow(deps.clock));
      repo.dropPreview(record.qid, record.host);
      intake.publish(record.qid);
      return new QuestionClosedError('timeout', `#${record.qid} is no longer pending on ${record.host}`);
    }
    repo.unclaim(record.qid, claim.state, claim.via);
    return err;
  }

  /** Claims the row first (exactly once), then writes the answer file; rolls the claim back if delivery fails. */
  async function deliver(record: QuestionRecord, claim: Claim, send: (ctl: CtlClient) => Promise<void>): Promise<QuestionDTO> {
    if (!repo.claim(record.qid, claim.state, claim.answerJson, claim.via, isoNow(deps.clock))) {
      const current = repo.get(record.qid)?.state ?? 'closed';
      throw new QuestionClosedError(current, `#${record.qid} was already ${current}`);
    }
    try {
      await send(deps.fleet.client(record.host));
    } catch (err) {
      throw failDelivery(record, claim, err);
    }
    repo.dropPreview(record.qid, record.host);
    noteAnswer(record, claim);
    return intake.publish(record.qid) ?? toQuestionDto(record);
  }

  /** A question left `pending`: its stored preview goes before the update is published. */
  function closed(record: QuestionRecord): void {
    repo.dropPreview(record.qid, record.host);
    intake.publish(record.qid);
  }

  async function reconcileHost(server: HostId): Promise<void> {
    const startedAt = deps.clock.now().getTime();
    const { pending } = await deps.fleet.client(server).pending();
    const live = new Set(pending.map((item) => item.qid));
    const cutoff = new Date(startedAt - RECONCILE_GRACE_MS).toISOString();
    for (const record of repo.pendingOnHostBefore(server, cutoff)) {
      if (!live.has(record.qid) && repo.resolve(record.qid, record.host, 'timeout', isoNow(deps.clock), 'reconcile')) closed(record);
    }
    reconciledHosts = new Set([...reconciledHosts, server]);
  }

  function onServer(server: ServerDTO): void {
    const previous = statuses.get(server.name);
    statuses.set(server.name, server.status);
    if (server.status !== 'online' || previous === 'online') return;
    void reconcileHost(server.name).catch((err: unknown) => {
      deps.log.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'question reconciliation failed');
    });
  }

  function closeForSession(sessionId: string): void {
    for (const record of repo.pendingForSession(sessionId)) {
      if (repo.resolve(record.qid, record.host, 'timeout', isoNow(deps.clock), 'session_ended')) closed(record);
    }
  }

  return {
    start() {
      if (unsubscribers.length > 0) return;
      unsubscribers = [
        deps.bus.on('spool.event', ({ host, event }) => intake.apply(host, event)),
        deps.bus.on('server.updated', (server) => onServer(server)),
        deps.bus.on('session.ended', ({ session }) => closeForSession(session.id)),
      ];
    },
    stop() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers = [];
    },
    pending: () => repo.pending().map(toQuestionDto),
    reconciled: (host) => reconciledHosts.has(host),
    get: (qid) => {
      const record = repo.get(qid);
      return record === undefined ? undefined : toQuestionDto(record);
    },
    check(qid, answers) {
      const record = requireOpen(qid, 'question');
      validateAnswers(record.payload.questions, answers);
      return toQuestionDto(record);
    },
    async answer(qid, answers, via) {
      const record = requireOpen(qid, 'question');
      validateAnswers(record.payload.questions, answers);
      const copy = { ...answers };
      const claim: Claim = { state: 'answered', answerJson: JSON.stringify({ answers: copy }), via, memo: answerText(qid, copy) };
      return deliver(record, claim, (ctl) => ctl.answer(qid, { answers: copy }));
    },
    async answerPermission(qid, behavior, message, via, opts = {}) {
      const record = requireOpen(qid, 'permission');
      if (behavior !== 'allow' && behavior !== 'deny') throw new ValidationError('behavior must be allow or deny');
      if (message !== undefined && message.length > PERMISSION_MESSAGE_MAX) {
        throw new ValidationError(`message must be at most ${PERMISSION_MESSAGE_MAX} characters`);
      }
      assertNotPinMessage(message);
      if (behavior === 'allow') requireAllowOffered(record);
      const { payload, memo } = opts.always === true
        ? allowAlways(record, behavior, message)
        : permissionAnswer(qid, behavior, message);
      return deliver(record, { state: 'answered', answerJson: JSON.stringify(payload), via, memo }, (ctl) => ctl.permission(qid, payload));
    },
    async release(qid, via) {
      const record = requireOpen(qid, null);
      const claim: Claim = { state: 'released', answerJson: JSON.stringify({ release: true }), via, memo: null };
      return deliver(record, claim, (ctl) =>
        record.kind === 'question' ? ctl.answer(qid, { release: true }) : ctl.permission(qid, { release: true }),
      );
    },
    markNotified: (qid) => repo.stamp(qid, 'notified_at', isoNow(deps.clock)),
    markEscalated: (qid) => repo.stamp(qid, 'escalated_at', isoNow(deps.clock)),
  };
}
