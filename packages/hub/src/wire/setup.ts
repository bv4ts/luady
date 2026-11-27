import { failedPinNotice } from '../notify/format.js';
import { createPinService } from '../security/pin.js';
import { createSetupCodeService } from '../security/setup-codes.js';
import type { SetupService } from '../core/contracts.js';
import { createSetupModule } from '../setup/index.js';
import type { WireContext, Wired } from './context.js';

/**
 * Setup: setup codes, the PIN (a failed PIN tells the owner through the owner's channel), and the
 * first-run module, provided as `setup`: the state machine, the login link's sign-in and the passkey skip. A PIN set or
 * changed tells the open pages the new setup state.
 */
export function wireSetup(ctx: WireContext): Wired {
  const db = ctx.get('db');
  const clock = ctx.get('clock');
  const log = ctx.get('log');
  const setupCodes = ctx.provide('setupCodes', createSetupCodeService({ db, clock }));
  let module: SetupService | null = null;
  const pin = ctx.provide('pin', createPinService({
    db, clock, setupCodes, log,
    onFailure: (info) => {
      ctx.get('ownerChannel').send(failedPinNotice(info.via, info.remaining), null)
        .catch((err: unknown) => log.error({ err }, 'pin: failure notice not sent'));
    },
    onChange: () => module?.notify(),
  }));
  const setup = createSetupModule({ db, clock, bus: ctx.get('bus'), config: ctx.config, log: log.child({ mod: 'setup' }) });
  module = setup;
  ctx.provide('setup', setup);
  return { name: 'setup', services: { pin, setupCodes, setup }, web: { pin, setupCodes, setup } };
}
