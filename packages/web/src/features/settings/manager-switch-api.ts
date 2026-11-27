import { PinSchema, SettingsSchema, type Settings } from '@luady/shared';
import { z } from 'zod';
import { createHttp, type Http } from '../../api/http.js';

/** `GET /api/manager/switch` (the hub's web/routes/luady.ts): the switch, its bootstrap steps, and whether sign-in is offered. */
export const ManagerSwitchViewSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(['off', 'starting', 'on', 'failed']),
  steps: z.array(z.object({ id: z.string(), state: z.string(), detail: z.string().nullable() })),
  signIn: z.boolean(),
});
export type ManagerSwitchView = z.infer<typeof ManagerSwitchViewSchema>;

/** `require_pin: false` with the PIN that confirms it (the settings route checks it before anything is written). */
const RequirePinOffSchema = z.strictObject({ require_pin: z.literal(false), pin: PinSchema });

/**
 * The two calls of this section that the shared client does not have. They go through the same HTTP layer as every
 * other call (page key, same origin, CSRF from the signed-in client), so nothing about them is weaker.
 */
export interface ManagerSwitchApi {
  view(): Promise<ManagerSwitchView>;
  /** Stops asking for the PIN before the manager's risky actions: needs the PIN itself. */
  requirePinOff(pin: string, csrf: string | null): Promise<Settings>;
}

export function createManagerSwitchApi(http: Http = createHttp()): ManagerSwitchApi {
  return {
    view: () => http.request('GET', '/api/manager/switch', ManagerSwitchViewSchema),
    requirePinOff: (pin, csrf) => {
      http.setCsrf(csrf);
      return http.request('PUT', '/api/settings', SettingsSchema, RequirePinOffSchema.parse({ require_pin: false, pin }));
    },
  };
}

/** The one instance the section uses (tests replace it with vi.mock). */
export const managerSwitchApi: ManagerSwitchApi = createManagerSwitchApi();
