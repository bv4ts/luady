import { z } from 'zod';
import { LIMITS } from './limits.js';

/**
 * What an agent said: the last message of a finished turn (`reply`) or a mid-turn `luady-report` line (`report`),
 * cut to LIMITS.saidTextMax characters (`truncated`). Never sent for Luady's own session or for a replayed event.
 */
export const SaidDTOSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(['reply', 'report']),
  text: z.string().max(LIMITS.saidTextMax),
  truncated: z.boolean(),
  at: z.string(),
});
export type SaidDTO = z.infer<typeof SaidDTOSchema>;

/** `GET /api/said`: the newest per live session, kept in the hub's memory. */
export const SaidListDTOSchema = z.object({ items: z.array(SaidDTOSchema) });
export type SaidListDTO = z.infer<typeof SaidListDTOSchema>;
