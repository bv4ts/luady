import { z } from 'zod';

export const ToolResponseSchema = z.union([
  z.object({ ok: z.literal(true), text: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ToolResponse = z.infer<typeof ToolResponseSchema>;

/** The internal socket's routes: the manager's tools, health, and the hub's state for `doctor`. */
export const INTERNAL_PATHS = {
  tools: '/internal/tools', health: '/internal/health', status: '/internal/status',
} as const;
