import { expect, it } from 'vitest';
import { analyticsFor } from './analytics.ts';
import { effect } from './lifecycle.ts';

it('counts real studio triggers without counting active scenes or stale bridge reconciliation', () => {
  const bridge = {
    type: 'bridgeScene',
    scene: 'Main',
    sessionId: '11111111-1111-4111-8111-111111111111',
  } as const;
  expect(
    analyticsFor(
      bridge,
      effect('APPLIED', 'availability.changed', { bridgeStale: false }),
      { round: null },
      { online: true },
      true,
    ),
  ).toEqual([]);
  expect(
    analyticsFor(
      bridge,
      effect('APPLIED', 'studio.opened', { templates: ['cosmetic-only'] }),
      { round: null },
      { online: true },
      true,
    ).map((event) => event.type),
  ).toEqual(['studio_triggered', 'studio_opened']);
});
it('never treats a trace lifetime decrement as proof of expiry or a duplicate vote as participation', () => {
  expect(
    analyticsFor(
      { type: 'vote', actorKey: 'private', choice: 1 },
      effect('NO_CHANGE'),
      { round: null },
      { online: true },
      true,
    ),
  ).toEqual([]);
  const events = analyticsFor(
    { type: 'resume' },
    effect('APPLIED', 'round.resolved', { tracesAged: ['id'] }),
    { round: null },
    { online: true },
    true,
  );
  expect(events.map((event) => event.type)).not.toContain('trace_expired');
  expect(JSON.stringify(events)).not.toContain('private');
});
