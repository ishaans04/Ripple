export type AnalyticsScope =
  { kind: 'channel'; worldId: string; channelId: string } | { kind: 'studio'; sessionId: string };
export type ClientEvent =
  | 'overlay_seen'
  | 'trial_opened'
  | 'passport_opened'
  | 'sandbox_completed'
  | 'editor_opened'
  | 'camera_enabled'
  | 'camera_failed'
  | 'fallback_selected';

const sent = new Set<string>();
/**
 * Fire-and-forget product event: an allow-listed name and a scope, nothing about the viewer.
 * Each event is sent at most once per page load for a given scope; failures are ignored.
 */
export function track(event: ClientEvent, scope: AnalyticsScope | null): void {
  if (scope === null) return;
  const key = `${event}:${JSON.stringify(scope)}`;
  if (sent.has(key)) return;
  sent.add(key);
  void fetch('/api/analytics', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, scope }),
  }).catch(() => undefined);
}
