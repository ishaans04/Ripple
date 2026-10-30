import type { Celebration } from '@ripple/contracts';

/**
 * Optional paid-event subscriptions (exact current EventSub versions). Each needs its own
 * broadcaster scope and is created only when the installation enables celebrations and the
 * broadcaster granted that scope. They never count toward required input health.
 */
export const celebrationSubscriptions: Readonly<
  Record<string, { version: string; scope: string; kind: Celebration['kind'] }>
> = Object.freeze({
  'channel.cheer': { version: '1', scope: 'bits:read', kind: 'cheer' },
  'channel.subscribe': { version: '1', scope: 'channel:read:subscriptions', kind: 'subscription' },
  'channel.hype_train.begin': {
    version: '2',
    scope: 'channel:read:hype_train',
    kind: 'hype_train',
  },
});
export const celebrationScopes = [
  ...new Set(Object.values(celebrationSubscriptions).map((item) => item.scope)),
];
