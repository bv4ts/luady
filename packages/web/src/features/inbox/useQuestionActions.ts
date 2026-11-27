import type { QuestionDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import type { AnswerBody } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import { isApiError, userMessage } from '../../api/errors.js';
import { useStore } from '../../state/store.js';

export type QuestionBusy = 'answer' | 'release' | null;

export function useQuestionActions(question: QuestionDTO) {
  const api = useApi();
  const { dispatch, refresh, toast } = useStore();
  const [busy, setBusy] = useState<QuestionBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const { qid, sessionLabel } = question;

  /** 409 = resolved elsewhere (terminal, Claude app, the chat, timeout): never retry, just resync. */
  const settleConflict = useCallback(async (err: unknown): Promise<boolean> => {
    if (!isApiError(err) || err.status !== 409) return false;
    toast('info', err.code === 'question_closed' ? `#${qid} was already resolved — your answer was not sent.` : err.message);
    dispatch({ type: 'question.removed', qid });
    await refresh();
    return true;
  }, [dispatch, qid, refresh, toast]);

  const run = useCallback(async (kind: 'answer' | 'release', call: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    setError(null);
    try {
      await call();
      dispatch({ type: 'question.removed', qid });
      toast('success', done);
    } catch (err) {
      if (!(await settleConflict(err))) setError(userMessage(err));
    } finally {
      setBusy(null);
    }
  }, [dispatch, qid, settleConflict, toast]);

  const answer = useCallback(
    (body: AnswerBody) => run('answer', () => api.answerQuestion(qid, body), `Answer sent to ${sessionLabel}`),
    [api, qid, run, sessionLabel],
  );
  const release = useCallback(
    () => run('release', () => api.releaseQuestion(qid), `#${qid} handed back to the terminal`),
    [api, qid, run],
  );

  return { answer, release, busy, error, setError };
}
