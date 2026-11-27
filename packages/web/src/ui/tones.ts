import type { ActionStatus, LuadyStatusDTO, ServerDTO, SessionState } from '@luady/shared';

export type Tone = 'working' | 'waiting' | 'idle' | 'error' | 'ended' | 'starting' | 'accent';

export const STATE_TONE: Readonly<Record<SessionState, Tone>> = {
  starting: 'starting', idle: 'idle', working: 'working', waiting_question: 'waiting',
  waiting_permission: 'waiting', error: 'error', ended: 'ended',
};

export const STATE_LABEL: Readonly<Record<SessionState, string>> = {
  starting: 'Starting', idle: 'Idle', working: 'Working', waiting_question: 'Needs you',
  waiting_permission: 'Needs you', error: 'Error', ended: 'Ended',
};

export function serverTone(status: ServerDTO['status']): Tone {
  if (status === 'online') return 'idle';
  return status === 'offline' ? 'error' : 'starting';
}

export function actionTone(status: ActionStatus): Tone {
  switch (status) {
    case 'done': return 'idle';
    case 'approved': return 'working';
    case 'pending_confirmation': return 'waiting';
    case 'failed': return 'error';
    case 'denied':
    case 'expired': return 'ended';
  }
}

export const LUADY_LABEL: Readonly<Record<LuadyStatusDTO['state'], string>> = {
  running: 'Ready', busy: 'Thinking', starting: 'Starting', down: 'Down', off: 'Off',
};

export function luadyTone(state: LuadyStatusDTO['state']): Tone {
  if (state === 'running') return 'idle';
  if (state === 'busy') return 'working';
  return state === 'starting' ? 'starting' : 'error';
}

