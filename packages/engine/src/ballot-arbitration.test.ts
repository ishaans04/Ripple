import { describe, expect, it } from 'vitest';
import { nextBallot, openSpecialRound } from './ballot-arbitration.ts';
import { candidateRuleset } from './ruleset.ts';
import { preparationOptions, resolveSpecialVote, traceOptions } from './arrival.ts';
describe('one channel-wide ballot at a safe boundary', () => {
  it('always numbers trace Keep/Clear as one/two, defaults to Clear and rejects a third choice', () => {
    for (const seed of ['one', 'two', 'three']) {
      const round = openSpecialRound(
        {
          kind: 'TRACE',
          seed,
          roundId: 'trace-round',
          genome: candidateRuleset.genome.founder,
          history: [],
          atMs: 0,
          timings: { voteMs: 3000, graceMs: 200, observationMs: 12000, revealMs: 800 },
          options: traceOptions,
          traceOffer: { id: 'offer', version: 0, template: 'charged' },
        },
        candidateRuleset,
      );
      const options = round.specialBallot!.options;
      expect(options.map((option) => option.id)).toEqual(['keep', 'clear']);
      expect(resolveSpecialVote(options, [], 'clear').choice).toBe('clear');
      expect(
        resolveSpecialVote(options, [{ actorKey: 'invalid', choice: 3 }], 'clear').choice,
      ).toBe('clear');
      expect(resolveSpecialVote(options, [{ actorKey: 'yes', choice: 1 }], 'clear').choice).toBe(
        'keep',
      );
      expect(round.candidates).toEqual([]);
    }
  });
  it('prioritizes welcome, then trace/preparation, with a mutation after two non-urgent special rounds', () => {
    const pending = {
      pendingWelcome: false,
      pendingTrace: false,
      preparationRequested: false,
      nonMutationRounds: 0,
    };
    expect(nextBallot(pending)).toBe('MUTATION');
    expect(nextBallot({ ...pending, preparationRequested: true })).toBe('PREPARATION');
    expect(nextBallot({ ...pending, pendingTrace: true, preparationRequested: true })).toBe(
      'TRACE',
    );
    expect(
      nextBallot({
        ...pending,
        pendingTrace: true,
        preparationRequested: true,
        nonMutationRounds: 2,
      }),
    ).toBe('MUTATION');
    expect(
      nextBallot({
        ...pending,
        pendingWelcome: true,
        pendingTrace: true,
        preparationRequested: true,
        nonMutationRounds: 2,
      }),
    ).toBe('WELCOME');
  });
  it('records a stable seeded choice order without mutation candidates or hidden gene changes', () => {
    const input = {
      kind: 'PREPARATION' as const,
      seed: 'channel-seed',
      roundId: 'round',
      genome: { pulse: 6, calm: 6, grit: 6, drift: 6 },
      history: [],
      atMs: 1000,
      timings: { voteMs: 3000, graceMs: 200, observationMs: 12000, revealMs: 800 },
      options: preparationOptions,
    };
    const round = openSpecialRound(input, candidateRuleset);
    expect(round).toEqual(openSpecialRound(input, candidateRuleset));
    expect(round.genomeBefore).toEqual(input.genome);
    expect(round.candidates).toEqual([]);
    expect(round.counts).toEqual([0, 0, 0]);
    const options = round.specialBallot!.options;
    expect(
      resolveSpecialVote(
        options,
        [
          { actorKey: 'one', choice: 1 },
          { actorKey: 'two', choice: 2 },
        ],
        'neutral',
      ).choice,
    ).toBe(options[0]?.id);
    expect(resolveSpecialVote(options, [], 'neutral').choice).toBe('neutral');
    expect(input.options).toEqual(preparationOptions);
  });
});
