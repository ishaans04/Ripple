import {
  artistStatusSchema,
  studioStateSchema,
  type AppearanceBlueprint,
  type ArtistStatus,
  type StudioState,
} from '@ripple/contracts';

export class StudioRequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'StudioRequestError';
  }
}

async function json(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'code' in body.error &&
      typeof body.error.code === 'string'
        ? body.error.code
        : 'NETWORK_ERROR';
    throw new StudioRequestError(code);
  }
  return body;
}

export async function fetchStudio(sessionId: string, signal?: AbortSignal): Promise<StudioState> {
  return studioStateSchema.parse(
    await json(
      await fetch(`/api/studios/${sessionId}`, { cache: 'no-store', signal: signal ?? null }),
    ),
  );
}

/** Artist sign-in exists only on a live installation; elsewhere the page stays local practice. */
export async function fetchArtist(
  sessionId: string,
  operation: string | null,
  signal?: AbortSignal,
): Promise<ArtistStatus> {
  const connection = (await json(await fetch('/api/connection', { cache: 'no-store' }))) as {
    liveEnabled?: boolean;
  };
  if (connection.liveEnabled !== true)
    return {
      signedIn: false,
      available: false,
      login: null,
      csrfToken: null,
      proposals: [],
      lastResult: null,
    };
  const query = new URLSearchParams({ studio: sessionId });
  if (operation !== null) query.set('operation', operation);
  return artistStatusSchema.parse(
    await json(
      await fetch(`/api/artist/status?${query.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: signal ?? null,
      }),
    ),
  );
}

export async function submitProposal(input: {
  sessionId: string;
  csrfToken: string;
  key: string;
  proposalId: string;
  blueprint: AppearanceBlueprint;
  creditOptIn: boolean;
}): Promise<void> {
  await json(
    await fetch(`/api/studios/${input.sessionId}/proposals`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.key,
      },
      body: JSON.stringify({
        proposalId: input.proposalId,
        blueprint: input.blueprint,
        creditOptIn: input.creditOptIn,
      }),
    }),
  );
}

export async function withdrawProposal(input: {
  sessionId: string;
  proposalId: string;
  csrfToken: string;
  key: string;
}): Promise<void> {
  await json(
    await fetch(`/api/studios/${input.sessionId}/proposals/${input.proposalId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': input.csrfToken, 'idempotency-key': input.key },
    }),
  );
}

/** Plain-language explanations for the stable codes a submission can receive. */
export const proposalMessages: Readonly<Record<string, string>> = {
  APPLIED: 'Your proposal is in. You can replace it until creation closes.',
  NO_CHANGE: 'This proposal was already received.',
  STUDIO_WRONG_PHASE:
    'Creation has closed, so this proposal was not accepted. Your draft is kept here.',
  PROPOSAL_LIMIT_REACHED:
    'This studio has reached its proposal limit. You can keep editing, but it cannot accept another proposal.',
  PROPOSAL_RATE_LIMITED: 'You replaced your proposal very recently. Wait a moment, then try again.',
  ARTIST_BLOCKED: 'The broadcaster is not accepting proposals from this account.',
  INVALID_BLUEPRINT: 'This design is outside the supported template, so it was not accepted.',
  MUTATION_NOT_LEGAL: 'That trade-off is no longer available for this creature.',
  BASE_STATE_CHANGED:
    'The creature changed since this studio opened, so this design cannot be used.',
  ARTIST_SIGN_IN_REQUIRED: 'Sign in with Twitch to submit an attributable proposal.',
  IDEMPOTENCY_CONFLICT: 'A different request already used this submission. Try submitting again.',
  CAPACITY_FULL: 'Too many requests right now. Wait a moment, then try again.',
  NETWORK_ERROR: 'The network is unavailable. Your draft is kept on this device.',
};
