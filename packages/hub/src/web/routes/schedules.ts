import { z } from 'zod';
import { CreateScheduleBodySchema, type ScheduleItemDTO, type ScheduleListDTO } from '@luady/shared';
import { NotFoundError } from '../../core/errors.js';
import type { RouteModule } from '../context.js';
import { EmptyBodySchema } from '../schemas.js';
import { parseBody, parseParams } from '../validate.js';

const ScheduleParamsSchema = z.strictObject({ id: z.string().min(1).max(64) });

/**
 * The schedule board on the existing scheduler: Luady's reminders and timed jobs. A bad `when` (not an
 * ISO time with offset in the future, not a 5-field cron) is the scheduler's ValidationError (400). The scheduler
 * itself announces `schedules.changed` (wired in app.ts), so Luady's own schedule tools refresh the board too.
 */
export const scheduleRoutes: RouteModule = (app, ctx) => {
  const { scheduler } = ctx.deps;
  app.get('/api/schedules', async (): Promise<ScheduleListDTO> => ({ items: scheduler.list() }));
  app.post('/api/schedules', async (request): Promise<ScheduleItemDTO> => {
    const { when, task } = parseBody(CreateScheduleBodySchema, request.body);
    return scheduler.add(when, task);
  });
  app.post('/api/schedules/:id/cancel', async (request): Promise<{ ok: true }> => {
    const { id } = parseParams(ScheduleParamsSchema, request.params);
    parseBody(EmptyBodySchema, request.body);
    if (!scheduler.cancel(id)) throw new NotFoundError(`No schedule ${id}`);
    return { ok: true };
  });
};
