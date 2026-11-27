import { z } from 'zod';
import { DAY_RE, type TimelineDTO } from '@luady/shared';
import { ownerDateKey } from '../../scheduler/zone.js';
import type { RouteModule } from '../context.js';
import { parseQuery } from '../validate.js';

const TimelineQuerySchema = z.strictObject({ day: z.string().regex(DAY_RE).optional() });

/** The today strip: one owner day, today when none is named. */
export const timelineRoutes: RouteModule = (app, ctx) => {
  const { timeline, clock } = ctx.deps;
  app.get('/api/timeline', async (request): Promise<TimelineDTO> => {
    const { day } = parseQuery(TimelineQuerySchema, request.query);
    return timeline.day(day ?? ownerDateKey(clock.now()));
  });
};
