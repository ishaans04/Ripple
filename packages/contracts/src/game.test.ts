import { describe, expect, it } from 'vitest';
import { gameCommandSchema, liveRoundTimings, roundTimingsSchema } from './game.ts';

describe('accepted game contracts', () => {
  it('rejects chat text, supplied fitness, and unbounded actors', () => {
    expect(
      gameCommandSchema.safeParse({ type: 'activity', actorKey: 'a', text: 'raw chat' }).success,
    ).toBe(false);
    expect(gameCommandSchema.safeParse({ type: 'seed', health: 100 }).success).toBe(false);
    expect(
      gameCommandSchema.safeParse({ type: 'vote', actorKey: 'a'.repeat(129), choice: 1 }).success,
    ).toBe(false);
  });
  it('stores accelerated timing explicitly and retains twelve equal buckets', () => {
    expect(roundTimingsSchema.parse(liveRoundTimings)).toEqual(liveRoundTimings);
    expect(roundTimingsSchema.safeParse({ ...liveRoundTimings, observationMs: 121 }).success).toBe(
      false,
    );
  });
});
