import type { CtlClient } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import type { HubPathGuard, HubPathUse } from '../security/hub-paths.js';

/**
 * The client of "this computer", whose kit runs as the hub's own user: its file verbs refuse the hub's own folders
 * (security/hub-paths.ts) before anything reaches the kit, whoever asks (a manager tool, an approved action, the
 * website). Every other verb passes through unchanged.
 */
export function guardHubFiles(client: CtlClient, guard: HubPathGuard): CtlClient {
  const check = (path: string, use: HubPathUse = 'read'): void => {
    const why = guard.refusal(path, use);
    if (why !== null) throw new RefusedError(why);
  };
  return {
    ...client,
    fileRead: async (path, maxBytes) => {
      check(path);
      return client.fileRead(path, maxBytes);
    },
    fileGet: async (path, maxBytes) => {
      check(path);
      return client.fileGet(path, maxBytes);
    },
    fileWrite: async (path, content) => {
      check(path, 'write');
      return client.fileWrite(path, content);
    },
  };
}
