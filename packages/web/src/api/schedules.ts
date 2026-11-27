import { CreateScheduleBodySchema, ScheduleItemDTOSchema, ScheduleListDTOSchema } from '@luady/shared';
import type { z } from 'zod';
import { OkSchema } from './schemas.js';
import { EMPTY, checked, seg, type Verbs } from './verbs.js';

export type CreateScheduleInput = z.input<typeof CreateScheduleBodySchema>;

/** Luady's reminders and timed jobs (the schedule board). */
export function scheduleRoutes({ get, post }: Verbs) {
  return {
    schedules: () => get('/api/schedules', ScheduleListDTOSchema),
    addSchedule: async (body: CreateScheduleInput) => post('/api/schedules', ScheduleItemDTOSchema, checked(CreateScheduleBodySchema, body)),
    cancelSchedule: (id: string) => post(`/api/schedules/${seg(id)}/cancel`, OkSchema, EMPTY),
  };
}
