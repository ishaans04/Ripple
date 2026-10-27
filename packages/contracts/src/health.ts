import { z } from 'zod';

/** GET /health/live: the process is running and its event loop responds. */
export const liveHealthSchema = z.object({
  status: z.literal('ok'),
});
export type LiveHealth = z.infer<typeof liveHealthSchema>;

/**
 * GET /health/ready: dependencies needed to serve gameplay are available.
 * Deliberately minimal so public readiness does not leak configuration.
 */
export const readyHealthSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: z.enum(['ok', 'unavailable']),
    migrations: z.enum(['current', 'pending', 'unknown']),
  }),
});
export type ReadyHealth = z.infer<typeof readyHealthSchema>;
