import { readyHealthSchema } from '@ripple/contracts';

export type ServiceStatus =
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: 'unreachable' | 'database' | 'updating' };

export const serviceStatusMessages = {
  checking: 'Checking the game service…',
  available: 'The game service is online.',
  unreachable: 'The game service cannot be reached right now.',
  database: 'The game service cannot reach its database.',
  updating: 'The game service is starting or applying an update.',
} as const;

export function describeServiceStatus(status: ServiceStatus): string {
  return status.kind === 'unavailable'
    ? serviceStatusMessages[status.reason]
    : serviceStatusMessages[status.kind];
}

/** Classify the readiness endpoint's answer into what a visitor needs to know. */
export async function fetchServiceStatus(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ServiceStatus> {
  let response: Response;
  try {
    response = await fetchImpl('/health/ready', {
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { kind: 'unavailable', reason: 'unreachable' };
  }

  const body: unknown = await response.json().catch(() => null);
  const report = readyHealthSchema.safeParse(body);
  if (!report.success) return { kind: 'unavailable', reason: 'unreachable' };
  if (report.data.status === 'ready') return { kind: 'available' };
  return {
    kind: 'unavailable',
    reason: report.data.checks.database === 'unavailable' ? 'database' : 'updating',
  };
}
