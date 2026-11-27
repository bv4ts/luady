import type { Channel, HostId } from '@luady/shared';
import type { Clock } from '../core/contracts.js';
import type { ClaudeLoginService } from './service.js';
import {
  CODE_IN_FLIGHT, CODE_NOT_RECOGNISED, NO_SIGN_IN_WAITING, noLoginWaiting, signInFailedText, signedInText,
} from './text.js';

/** What the inbound router uses: the chat texts of /login on top of the data service. */
export interface ChatLogin {
  /** Goes to the sign-in that started last; none waiting → noLoginWaiting. `via` is the chat channel's id. */
  submit(code: string, via: Channel): Promise<string>;
  /** A sign-in waits for its code (a code inside a sentence is then taken out of it). */
  waiting(): boolean;
}

/**
 * `hosts`: the hosts of the fleet a chat sign-in can name (read at every call), for the "nothing is waiting" answer.
 */
export function createChatLogin(
  service: Pick<ClaudeLoginService, 'submit' | 'latestPending'>, clock: Clock, hosts: () => readonly HostId[],
): ChatLogin {
  return {
    async submit(code, via) {
      const host: HostId | null = service.latestPending();
      if (host === null) return noLoginWaiting(hosts());
      const result = await service.submit(host, code, via);
      if (result.ok) return signedInText(host, result.expiresAt, clock.now(), result.brainRestarted);
      if (result.message === NO_SIGN_IN_WAITING) return noLoginWaiting(hosts());
      if (result.message === CODE_NOT_RECOGNISED || result.message === CODE_IN_FLIGHT) return result.message;
      return signInFailedText(host, result.message);
    },
    waiting: () => service.latestPending() !== null,
  };
}
