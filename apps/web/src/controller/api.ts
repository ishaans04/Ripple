export class LiveRequestError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.name = 'LiveRequestError';
  }
}
export async function liveRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      ...options,
    });
  } catch {
    throw new Error('Connection lost. Retry the same command when the connection returns.');
  }
  const value: unknown = await response.json();
  if (!response.ok) {
    const code =
      typeof value === 'object' &&
      value !== null &&
      'error' in value &&
      typeof value.error === 'object' &&
      value.error !== null &&
      'code' in value.error
        ? String(value.error.code)
        : 'REQUEST_FAILED';
    throw new LiveRequestError(response.status, code);
  }
  return value;
}
export const controlMessages: Readonly<Record<string, string>> = {
  SIGN_IN_REQUIRED: 'Sign in with Twitch to control your channel.',
  CSRF_FAILED: 'Your browser session changed. Sign in again before sending controls.',
  STALE_VERSION: 'The channel changed. Review its current state and try again.',
  INTEGRATION_UNAVAILABLE: 'The stream and all input subscriptions must be ready first.',
  SEED_COOLDOWN: 'The seeding cooldown is still active. Try again after the time shown.',
  COMMAND_PENDING: 'A seed command is already waiting to be processed.',
  NO_RESIDENT: 'There is no living resident to change.',
  RESIDENT_EXISTS: 'This channel already has a resident.',
  PAUSED: 'The channel is manually paused. Resume it first.',
  CLAIM_NOT_AVAILABLE: 'This raid has no remaining historical invitation.',
  NOT_CLAIM_DESTINATION: 'Only the original raid destination can adopt this descendant.',
  CLAIM_EXPIRED: 'The retained raid invitation has expired. No descendant was activated.',
  CLAIM_CAPACITY: 'The harbor is full. Try again before the original invitation expires.',
};
export function controlMessage(code: string): string {
  return controlMessages[code] ?? code.replaceAll('_', ' ');
}
