import { z } from 'zod';

/**
 * Stable machine-readable error codes returned by every HTTP route.
 * Codes are part of the public contract: never rename one, only add.
 */
export const errorCodes = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'UNAUTHORIZED',
  'WORLD_EXPIRED',
  'WRONG_WORLD_MODE',
  'CAPACITY_FULL',
  'NOT_OWNER',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'STALE_VERSION',
  'SEED_COOLDOWN',
  'COMMAND_PENDING',
  'ROUND_UNRESOLVED',
  'OPERATOR_REQUIRED',
  'INVALID_OAUTH_STATE',
  'AUTHORIZATION_DENIED',
  'INVALID_IDENTITY',
  'CSRF_FAILED',
  'SIGN_IN_REQUIRED',
  'INVALID_SIGNATURE',
  'STALE_NOTIFICATION',
  'INVALID_EVENT',
  'UNKNOWN_SUBSCRIPTION',
  'RECEIPT_CONFLICT',
  'INVALID_CHALLENGE',
  'SUBSCRIPTION_NOT_READY',
  'PROVIDER_UNAVAILABLE',
  'GRANT_REVOKED',
  'RATE_LIMITED',
  'PROVIDER_REJECTED',
  'INVALID_RESPONSE',
  'STUDIO_DISABLED',
  'STUDIO_NOT_FOUND',
  'STUDIO_WRONG_PHASE',
  'BASE_STATE_CHANGED',
  'MUTATION_NOT_LEGAL',
  'PROPOSAL_LIMIT_REACHED',
  'PROPOSAL_TOO_LARGE',
  'PENDING_ADAPTATION_EXISTS',
  'REVIEW_EXPIRED',
  'ARTIST_SIGN_IN_REQUIRED',
  'BRIDGE_UNAUTHORIZED',
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
