import { SettingsPatchSchema } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { PinRequiredError } from '../errors.js';
import { parseBody } from '../validate.js';

export const settingsRoutes: RouteModule = (app, ctx) => {
  const { settings } = ctx.deps;
  app.get('/api/settings', async () => settings.get());
  // Turning require_pin off lets the manager's risky actions run without the PIN, so it needs the PIN itself. The PIN is
  // checked (with its lockout) before anything is written, and it is neither stored nor logged.
  app.put('/api/settings', async (request) => {
    const { pin, ...patch } = parseBody(SettingsPatchSchema, request.body);
    if (patch.require_pin === false) {
      if (pin === undefined) throw new PinRequiredError('PIN required to stop asking for the PIN');
      await ctx.deps.pin.verify(pin, 'web');
    }
    return settings.update(patch);
  });
};
