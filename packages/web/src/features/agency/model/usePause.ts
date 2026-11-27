import { KIT_V2, isSelfHost, versionAtLeast, type ActionDTO, type ServerDTO, type SessionDTO, managerName } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError, userMessage } from '../../../api/errors.js';
import type { ResumeAnswer } from '../../../api/schemas.js';
import { describeAction } from '../../../lib/actions.js';
import type { ToastKind } from '../../../state/reducer.js';
import { useStore } from '../../../state/store.js';

/** What the owner sees when a server answers a pause with kit_too_old (the item is hidden for it afterwards). */
export const PAUSE_TOO_OLD = 'This server’s kit is too old for pause.';

export interface PauseControl {
  readonly paused: boolean;
  readonly canPause: boolean;
  /** Why it cannot be paused right now; null when it can. */
  readonly reason: string | null;
  /** The server refused a pause for an old kit: show no pause control for it at all. */
  readonly hidden: boolean;
  readonly busy: boolean;
  toggle(): Promise<void>;
}

function blockedReason(session: SessionDTO, server: ServerDTO | undefined): string | null {
  if (session.state === 'ended') return 'This agent has ended.';
  if (isSelfHost(session.host)) return `${managerName()}’s own sessions cannot be paused.`;
  return versionAtLeast(server?.kitVersion, KIT_V2) ? null : `Update the kit on ${session.host} to pause.`;
}

/**
 * What a resume did, in words. A newer hub says it in `resume`; an older one only writes "nothing was sent" in the
 * result, which covers both an idle agent and a pause that had not stopped it yet, so those words claim neither.
 */
function resumeText(action: ResumeAnswer, name: string): string {
  if (action.resume !== undefined) {
    if (action.resume.sent) return `Resumed ${name}.`;
    return action.resume.wasHit ? 'Pause lifted. The agent was idle.' : 'Pause lifted. The agent was still working.';
  }
  return action.result?.includes('nothing was sent') === true ? `Resumed ${name}. Nothing needed to be sent.` : `Resumed ${name}.`;
}

/** The toast for a finished pause or resume. */
function outcome(action: ActionDTO | ResumeAnswer, name: string, resumed: boolean): { kind: ToastKind; text: string } {
  if (action.status !== 'done') return describeAction(action);
  return { kind: 'success', text: resumed ? resumeText(action, name) : `Paused ${name}.` };
}

/** Pause or resume one agent through the hub, with the reasons it cannot be done in plain words. */
export function usePause(session: SessionDTO): PauseControl {
  const api = useApi();
  const { state, dispatch, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const paused = Object.hasOwn(state.activity, session.id) && state.activity[session.id]?.paused === true;
  const reason = paused && session.state !== 'ended' ? null : blockedReason(session, state.servers.find((s) => s.name === session.host));
  const { id, host, displayName } = session;

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      const action = paused ? await api.resumeSession(id) : await api.pauseSession(id);
      const result = outcome(action, displayName, paused);
      toast(result.kind, result.text);
    } catch (err) {
      if (isApiError(err, 'kit_too_old')) {
        dispatch({ type: 'pause.refused', host });
        toast('error', PAUSE_TOO_OLD);
      } else {
        toast('error', userMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }, [api, dispatch, toast, paused, id, host, displayName]);

  return { paused, canPause: reason === null, reason, hidden: state.pauseRefused.includes(host), busy, toggle };
}
