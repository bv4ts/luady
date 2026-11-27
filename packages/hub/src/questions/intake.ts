import { TARGET_RE, type HostId, type QuestionDTO, type SpoolEvent } from '@luady/shared';
import type { EventBus, Logger, MemoryService } from '../core/contracts.js';
import { displayNameFor, projectFor, sessionIdForEvent, sessionLabel } from '../sessions/naming.js';
import { normalizeTs } from '../sessions/registry.js';
import { toQuestionDto, type QuestionState, type QuestionsRepo } from './repo.js';
import { questionText } from './validate.js';

export interface QuestionIntakeDeps {
  repo: QuestionsRepo;
  bus: EventBus;
  memory: MemoryService;
  log: Logger;
}

export interface QuestionIntake {
  apply(host: HostId, event: SpoolEvent): void;
  /** Emits `question.updated` for the current row and returns its DTO. */
  publish(qid: string): QuestionDTO | undefined;
}

type AskedEvent = Extract<SpoolEvent, { event: 'question' }>;
type PermissionEvent = Extract<SpoolEvent, { event: 'permission' }>;

const QUESTION_OUTCOMES: Record<'answered' | 'released' | 'timeout' | 'error', QuestionState> = {
  answered: 'answered',
  released: 'released',
  timeout: 'timeout',
  error: 'released',
};
const PERMISSION_OUTCOMES: Record<'allowed' | 'denied' | 'released' | 'timeout' | 'error', QuestionState> = {
  allowed: 'answered',
  denied: 'answered',
  released: 'released',
  timeout: 'timeout',
  error: 'released',
};

/** Session id and label for a question; panes without a tmux target fall back to the Claude session id. */
export function questionOwner(host: HostId, event: SpoolEvent): { sessionId: string; label: string } {
  const sessionId = sessionIdForEvent(host, event) ?? `${host}:${event.session_id ?? 'unknown'}`;
  const name = event.tmux !== null && TARGET_RE.test(event.tmux) ? displayNameFor(event.tmux) : (projectFor(event.cwd) ?? 'session');
  return { sessionId, label: sessionLabel(host, name) };
}

export function createQuestionIntake(deps: QuestionIntakeDeps): QuestionIntake {
  function publish(qid: string): QuestionDTO | undefined {
    const record = deps.repo.get(qid);
    if (record === undefined) return undefined;
    const dto = toQuestionDto(record);
    deps.bus.emit('question.updated', dto);
    return dto;
  }

  function note(sessionId: string, text: string, extId: string): void {
    try {
      deps.memory.record({ thread: `session:${sessionId}`, role: 'assistant', channel: null, text, extId });
    } catch (err) {
      deps.log.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'cannot record question text');
    }
  }

  function onAsked(host: HostId, event: AskedEvent): void {
    const owner = questionOwner(host, event);
    const inserted = deps.repo.insert({
      qid: event.data.qid,
      kind: 'question',
      host,
      sessionId: owner.sessionId,
      createdAt: normalizeTs(event.ts),
      payload: {
        label: owner.label,
        questions: event.data.questions,
        toolName: null,
        inputPreview: null,
        toolUseId: event.data.tool_use_id,
        claudeSessionId: event.session_id,
        preview: null,
      },
    });
    if (!inserted) return;
    note(owner.sessionId, questionText(event.data.qid, event.data.questions), event.id);
    publish(event.data.qid);
  }

  function onPermission(host: HostId, event: PermissionEvent): void {
    const owner = questionOwner(host, event);
    const inserted = deps.repo.insert({
      qid: event.data.qid,
      kind: 'permission',
      host,
      sessionId: owner.sessionId,
      createdAt: normalizeTs(event.ts),
      payload: {
        label: owner.label,
        questions: [],
        toolName: event.data.tool_name,
        inputPreview: event.data.input_preview,
        toolUseId: null,
        claudeSessionId: event.session_id,
        preview: event.data.preview ?? null,
      },
    });
    if (!inserted) return;
    note(owner.sessionId, `🔐 #${event.data.qid} wants to use ${event.data.tool_name}: ${event.data.input_preview}`, event.id);
    publish(event.data.qid);
  }

  /** A resolved event closes only a question of the host whose link delivered it. */
  function onResolved(host: HostId, qid: string, state: QuestionState, outcome: string, ts: string): void {
    const changed = deps.repo.resolve(qid, host, state, normalizeTs(ts), outcome);
    deps.repo.dropPreview(qid, host);
    if (changed) publish(qid);
  }

  return {
    publish,
    apply(host, event) {
      switch (event.event) {
        case 'question':
          onAsked(host, event);
          return;
        case 'permission':
          onPermission(host, event);
          return;
        case 'question_resolved':
          onResolved(host, event.data.qid, QUESTION_OUTCOMES[event.data.outcome], event.data.outcome, event.ts);
          return;
        case 'permission_resolved':
          onResolved(host, event.data.qid, PERMISSION_OUTCOMES[event.data.outcome], event.data.outcome, event.ts);
          return;
        default:
          return;
      }
    },
  };
}
